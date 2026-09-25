import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ipcTokenPath,
  loadOrCreateSecret,
  readSecret,
  resolveIpcToken,
} from "../src/ipc";
import {
  type CommandResult,
  checkOwnerOnly,
  ownerOnlyAclArgv,
  restrictToOwner,
  windowsAccount,
} from "../src/ipc-secrets";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-remote-secrets-"));
  dirs.push(dir);
  return dir;
}

test("a secret is created once as 32 random bytes and then reused", async () => {
  const path = join(await tempDir(), "state", "dev-client-secret");
  expect(await readSecret(path)).toBeUndefined();

  const secret = await loadOrCreateSecret(path);
  expect(Buffer.from(secret, "base64url")).toHaveLength(32);
  expect(Buffer.from(secret, "base64url").toString("base64url")).toBe(secret);

  expect(await loadOrCreateSecret(path)).toBe(secret);
  expect(await readSecret(path)).toBe(secret);
});

test.skipIf(process.platform === "win32")(
  "a created secret is owner-only (0600) in an owner-only directory",
  async () => {
    const dir = join(await tempDir(), "state");
    const path = join(dir, "ipc-token");
    await loadOrCreateSecret(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  },
);

test("concurrent creators agree on one secret and leave no temp files", async () => {
  const dir = await tempDir();
  const path = join(dir, "ipc-token");
  const secrets = await Promise.all(
    Array.from({ length: 16 }, () => loadOrCreateSecret(path)),
  );
  expect(new Set(secrets).size).toBe(1);
  expect(await readSecret(path)).toBe(secrets[0]);
  expect(await readdir(dir)).toEqual(["ipc-token"]);
});

test("an empty or malformed secret file is refused, never trusted", async () => {
  const path = join(await tempDir(), "dev-client-secret");
  await writeFile(path, "\n");
  await expect(loadOrCreateSecret(path)).rejects.toThrow();
  await writeFile(path, "short,secret");
  await expect(readSecret(path)).rejects.toThrow();
});

test("the IPC token is the per-install file; a stale OMP_REMOTE_TOKEN no longer overrides it", async () => {
  const env = { OMP_REMOTE_STATE_DIR: await tempDir() };
  const token = await resolveIpcToken(env);
  expect(await readSecret(ipcTokenPath(env))).toBe(token);
  expect(await resolveIpcToken({ ...env, OMP_REMOTE_TOKEN: "dev-token" })).toBe(
    token,
  );
});

const FILE = "C:\\Users\\me\\.omp-remote\\ipc-token";
test("the owner-only ACL argv drops inheritance and grants only the user", () => {
  expect(ownerOnlyAclArgv(FILE, "me")).toEqual([
    "icacls",
    FILE,
    "/inheritance:r",
    "/grant:r",
    "me:F",
  ]);
});

test("the icacls grantee is the domain-qualified account, so a user named like the machine still gets the ACE", () => {
  // User `Chef` on machine `CHEF`: a bare `Chef:F` grants `CHEF\`, nobody.
  const account = windowsAccount({ USERDOMAIN: "CHEF" }, "Chef");
  expect(account).toBe("CHEF\\Chef");
  expect(ownerOnlyAclArgv(FILE, account).at(-1)).toBe("CHEF\\Chef:F");
  expect(windowsAccount({ USERDOMAIN: "CORP" }, "CORP\\chef")).toBe(
    "CORP\\chef",
  );
  expect(windowsAccount({}, "chef")).toBe("chef");
});

/** A fake `icacls`: answers the grant, then the read-back listing. */
function icacls(grant: CommandResult | Error, listing: CommandResult) {
  const calls: (readonly string[])[] = [];
  const run = async (argv: readonly string[]): Promise<CommandResult> => {
    calls.push(argv);
    if (argv.length > 2) {
      if (grant instanceof Error) throw grant;
      return grant;
    }
    return listing;
  };
  return { run, calls };
}

const ok = { code: 0, stdout: "" };
const listed = (...aces: string[]): CommandResult => ({
  code: 0,
  stdout: `${FILE} ${aces.join("\r\n                                 ")}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`,
});

test("restrictToOwner verifies the ACL names only the current user", async () => {
  const fake = icacls(ok, listed("DESKTOP-1\\me:(F)"));
  expect(await restrictToOwner(FILE, fake.run, "me")).toBeUndefined();
  expect(fake.calls).toEqual([ownerOnlyAclArgv(FILE, "me"), ["icacls", FILE]]);
});

test("the ACL check accepts the qualified owner and rejects the empty machine principal", async () => {
  const owner = "CHEF\\Chef";
  const granted = icacls(ok, listed("CHEF\\Chef:(F)"));
  expect(await checkOwnerOnly(FILE, granted.run, owner)).toBeUndefined();
  const nobody = icacls(ok, listed("CHEF\\:(F)"));
  expect(await checkOwnerOnly(FILE, nobody.run, owner)).toBe(
    "acl-not-owner-only",
  );
});

test("restrictToOwner reports, never throws, when icacls fails or leaves others", async () => {
  const spawnFailed = icacls(new Error("ENOENT"), ok);
  expect(await restrictToOwner(FILE, spawnFailed.run, "me")).toBe(
    "acl-command-failed",
  );
  const denied = icacls({ code: 5, stdout: "" }, ok);
  expect(await restrictToOwner(FILE, denied.run, "me")).toBe(
    "acl-command-failed",
  );
  const stillShared = icacls(
    ok,
    listed("DESKTOP-1\\me:(F)", "BUILTIN\\Administrators:(I)(F)"),
  );
  expect(await restrictToOwner(FILE, stillShared.run, "me")).toBe(
    "acl-not-owner-only",
  );
  // A user whose name only ends like ours is someone else.
  const lookalike = icacls(ok, listed("DESKTOP-1\\notme:(F)"));
  expect(await restrictToOwner(FILE, lookalike.run, "me")).toBe(
    "acl-not-owner-only",
  );
  const unreadable = icacls(ok, { code: 0, stdout: "garbled" });
  expect(await restrictToOwner(FILE, unreadable.run, "me")).toBe(
    "acl-not-owner-only",
  );
});

test("checkOwnerOnly only reads the ACL: it never changes what it reports on", async () => {
  const owned = icacls(new Error("granted"), listed("DESKTOP-1\\me:(F)"));
  expect(await checkOwnerOnly(FILE, owned.run, "me")).toBeUndefined();
  const shared = icacls(
    new Error("granted"),
    listed("DESKTOP-1\\me:(F)", "NT AUTHORITY\\SYSTEM:(I)(F)"),
  );
  expect(await checkOwnerOnly(FILE, shared.run, "me")).toBe(
    "acl-not-owner-only",
  );
  expect([...owned.calls, ...shared.calls]).toEqual([
    ["icacls", FILE],
    ["icacls", FILE],
  ]);
  const missing = icacls(ok, { code: 2, stdout: "" });
  expect(await checkOwnerOnly(FILE, missing.run, "me")).toBe(
    "acl-command-failed",
  );
});

test.skipIf(process.platform !== "win32")(
  "a new secret file on Windows grants only the current user",
  async () => {
    const path = join(await tempDir(), "ipc-token");
    const failures: string[] = [];
    await loadOrCreateSecret(path, { onAclFailure: (f) => failures.push(f) });
    expect(failures).toEqual([]);
    // Read the ACL back independently: one ACE, for the current account.
    const listing = Bun.spawnSync(["icacls", path]).stdout.toString();
    const aces = listing
      .slice(path.length)
      .split(/\r?\n/)
      .map((line) => line.trim());
    const granted = aces.slice(0, aces.indexOf(""));
    expect(granted).toHaveLength(1);
    expect(granted[0]?.toLowerCase()).toStartWith(
      `${windowsAccount().toLowerCase()}:(`,
    );
  },
);
