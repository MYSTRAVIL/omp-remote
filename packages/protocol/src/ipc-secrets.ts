import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { InstallSecret } from "./local-auth";

type Env = Record<string, string | undefined>;

/** The host-agent's per-install state: `OMP_REMOTE_STATE_DIR`, else `~/.omp-remote`. */
export function stateDir(env: Env = process.env): string {
  const override = env.OMP_REMOTE_STATE_DIR;
  return override ? override : join(homedir(), ".omp-remote");
}

/** The token a bridge presents in its IPC `hello`. */
export function ipcTokenPath(env: Env = process.env): string {
  return join(stateDir(env), "ipc-token");
}

/**
 * The current Windows account as `icacls` must name it: `DOMAIN\user`, the
 * domain from `USERDOMAIN` (the computer name for a local account). A bare
 * name is ambiguous: when it equals the computer name, `icacls` resolves it
 * to the machine and grants `CHEF\` — no account at all — which locks the
 * owner out of the file. Bare only when `USERDOMAIN` is unset.
 */
export function windowsAccount(
  env: Env = process.env,
  username: string = userInfo().username,
): string {
  const domain = env.USERDOMAIN;
  return domain && !username.includes("\\")
    ? `${domain}\\${username}`
    : username;
}

/** The secret the loopback dev client must offer. */
export function devClientSecretPath(env: Env = process.env): string {
  return join(stateDir(env), "dev-client-secret");
}

/** The secret stored at `path`, or `undefined` if the file does not exist. */
export async function readSecret(path: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return InstallSecret.parse(raw.trim());
}

/**
 * Why a Windows secret file could not be made owner-only. The secret is still
 * usable (it keeps the state dir's inherited ACL); the caller logs a warning.
 * - `acl-command-failed`: `icacls` could not be run or exited non-zero.
 * - `acl-not-owner-only`: `icacls` ran but the file still grants someone else.
 */
export type SecretAclFailure = "acl-command-failed" | "acl-not-owner-only";

export interface SecretOptions {
  /** A Windows secret file kept a non-owner-only ACL; never thrown. */
  onAclFailure?: (failure: SecretAclFailure) => void;
}

/** `icacls` argv that drops inherited ACEs and grants only `user` full control. */
export function ownerOnlyAclArgv(file: string, user: string): string[] {
  return ["icacls", file, "/inheritance:r", "/grant:r", `${user}:F`];
}

export interface CommandResult {
  code: number;
  stdout: string;
}
/** Runs `argv` directly (no shell); rejects only when it cannot start. */
export type RunCommand = (argv: readonly string[]) => Promise<CommandResult>;

const runCommand: RunCommand = (argv) => {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const [file = "", ...args] = argv;
  execFile(file, args, { windowsHide: true }, (err, stdout) => {
    if (!err) resolve({ code: 0, stdout });
    else if (typeof err.code === "number") resolve({ code: err.code, stdout });
    else reject(err);
  });
  return promise;
};

/**
 * The principals `icacls <file>` lists: the first ACE follows the echoed path,
 * the rest are indented on the following lines, up to the blank line.
 */
function aclPrincipals(listing: string, file: string): string[] {
  const principals: string[] = [];
  const lines = listing.split(/\r?\n/);
  const first = lines[0] ?? "";
  if (!first.startsWith(file)) return principals;
  const entries = [first.slice(file.length), ...lines.slice(1)];
  for (const entry of entries) {
    const ace = entry.trim();
    if (ace === "") break;
    const cut = ace.indexOf(":(");
    principals.push(cut < 0 ? ace : ace.slice(0, cut));
  }
  return principals;
}

/**
 * Whether `icacls <file>` shows an ACL that grants only `user`: `undefined`
 * when it does, else why not. Read-only; a listing it cannot parse counts as
 * not owner-only. Never throws.
 */
export async function checkOwnerOnly(
  file: string,
  run: RunCommand = runCommand,
  user: string = windowsAccount(),
): Promise<SecretAclFailure | undefined> {
  try {
    const listing = await run(["icacls", file]);
    if (listing.code !== 0) return "acl-command-failed";
    const principals = aclPrincipals(listing.stdout, file);
    const own = user.toLowerCase();
    const ownerOnly =
      principals.length > 0 &&
      principals.every((principal) => {
        const name = principal.toLowerCase();
        return name === own || name.endsWith(`\\${own}`);
      });
    return ownerOnly ? undefined : "acl-not-owner-only";
  } catch {
    return "acl-command-failed";
  }
}

/**
 * Restrict `file` to the current user on Windows (`icacls`, argv only), then
 * read the ACL back to verify nobody else is granted. Returns why it failed
 * instead of throwing: an over-broad ACL is a warning, not a startup failure.
 */
export async function restrictToOwner(
  file: string,
  run: RunCommand = runCommand,
  user: string = windowsAccount(),
): Promise<SecretAclFailure | undefined> {
  try {
    if ((await run(ownerOnlyAclArgv(file, user))).code !== 0)
      return "acl-command-failed";
  } catch {
    return "acl-command-failed";
  }
  return checkOwnerOnly(file, run, user);
}

/**
 * The secret stored at `path`, created owner-only on first use: 0600 in a 0700
 * directory on Unix, an ACL granting only the current user on Windows. Safe
 * against concurrent creators — the agent and every bridge may race to create
 * `ipc-token`: the secret is written to a private temp file, restricted, and
 * published with `link`, which never replaces an existing file. Readers
 * therefore see no file or a complete one, and every caller gets the winner.
 */
export async function loadOrCreateSecret(
  path: string,
  opts: SecretOptions = {},
): Promise<string> {
  const existing = await readSecret(path);
  if (existing !== undefined) return existing;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("base64url");
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temp, secret, { flag: "wx", mode: 0o600 });
  try {
    await chmod(temp, 0o600);
    // A hard link shares the file's ACL, so the published name is never broad.
    if (process.platform === "win32") {
      const failure = await restrictToOwner(temp);
      if (failure) opts.onAclFailure?.(failure);
    }
    await link(temp, path);
    return secret;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    await rm(temp, { force: true });
  }
  const winner = await readSecret(path);
  if (winner === undefined) throw new Error(`secret disappeared: ${path}`);
  return winner;
}

/** The IPC token shared by the host-agent and its bridges: the per-install `ipc-token` file. */
export async function resolveIpcToken(
  env: Env = process.env,
  opts: SecretOptions = {},
): Promise<string> {
  return loadOrCreateSecret(ipcTokenPath(env), opts);
}
