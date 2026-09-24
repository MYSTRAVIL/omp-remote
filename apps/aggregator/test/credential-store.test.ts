import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CredentialStore } from "../src/credential-store";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-cred-"));
  dirs.push(dir);
  return join(dir, "nested", "credentials.json");
}

test("a fresh store is empty but has a stable random user handle", async () => {
  const path = await tempStorePath();
  const store = await CredentialStore.load(path);
  expect(store.list()).toHaveLength(0);
  expect(store.userId.length).toBeGreaterThan(0);
  expect(store.userName).toBe("omp-remote");

  // reloading keeps the same generated user handle
  const again = await CredentialStore.load(path);
  expect(again.userId).toBe(store.userId);
});

test("added credentials persist across reloads", async () => {
  const path = await tempStorePath();
  const store = await CredentialStore.load(path);
  await store.add({ id: "cred-A", publicKey: "pkA", counter: 0 });
  await store.add({
    id: "cred-B",
    publicKey: "pkB",
    counter: 5,
    transports: ["internal"],
  });

  const reloaded = await CredentialStore.load(path);
  expect(reloaded.list()).toHaveLength(2);
  expect(reloaded.get("cred-A")?.publicKey).toBe("pkA");
  expect(reloaded.get("cred-B")?.counter).toBe(5);
  expect(reloaded.get("cred-B")?.transports).toEqual(["internal"]);
  expect(reloaded.get("missing")).toBeUndefined();
});

test("a duplicate credential id is rejected", async () => {
  const store = await CredentialStore.load(await tempStorePath());
  await store.add({ id: "dup", publicKey: "pk", counter: 0 });
  await expect(
    store.add({ id: "dup", publicKey: "pk2", counter: 0 }),
  ).rejects.toThrow(/already registered/);
});

test("recordUse advances the replay counter and stamps the last use, persisted", async () => {
  const path = await tempStorePath();
  const store = await CredentialStore.load(path);
  await store.add({
    id: "cred",
    publicKey: "pk",
    counter: 0,
    createdAt: 1_000,
  });
  await store.recordUse("cred", 42, 5_000);
  expect((await CredentialStore.load(path)).get("cred")).toMatchObject({
    counter: 42,
    createdAt: 1_000,
    lastUsedAt: 5_000,
  });
  await expect(store.recordUse("nope", 1, 5_000)).rejects.toThrow(/unknown/);
});

test("remove drops only that credential, persisted", async () => {
  const path = await tempStorePath();
  const store = await CredentialStore.load(path);
  await store.add({ id: "keep", publicKey: "pk1", counter: 0 });
  await store.add({ id: "drop", publicKey: "pk2", counter: 3 });
  await store.remove("drop");
  const reloaded = await CredentialStore.load(path);
  expect(reloaded.list().map((c) => c.id)).toEqual(["keep"]);
  await expect(store.remove("drop")).rejects.toThrow(/unknown/);
});

test("a store file from before passkey dates, token epochs, and password sign-in loads at epoch 0 with password sign-in on, and epoch bumps and the sign-in switch persist", async () => {
  const path = await tempStorePath();
  // Byte-for-byte what the aggregator wrote before these fields existed.
  const legacyCredential = {
    id: "old",
    publicKey: "pk",
    counter: 7,
    transports: ["internal"],
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      userId: "dXNlcg",
      userName: "omp-remote",
      credentials: [legacyCredential],
    }),
  );
  const store = await CredentialStore.load(path);
  expect(store.tokenEpoch).toBe(0);
  expect(store.passwordSignIn).toBe(true);
  expect(store.list()).toEqual([legacyCredential]);

  await store.bumpTokenEpoch();
  await store.bumpTokenEpoch();
  await store.setPasswordSignIn(false, 5_000);
  const reloaded = await CredentialStore.load(path);
  expect(reloaded.tokenEpoch).toBe(2);
  expect(reloaded.passwordSignIn).toBe(false);
  expect(reloaded.passwordSignInOffAt).toBe(5_000);
  expect(reloaded.userId).toBe("dXNlcg");
  expect(reloaded.list()).toEqual([legacyCredential]);
});

test("overlapping add/remove/epoch writes land in call order, so a reload sees the latest state", async () => {
  const path = await tempStorePath();
  const store = await CredentialStore.load(path);
  await store.add({ id: "keep", publicKey: "pk", counter: 0 });
  for (let round = 1; round <= 10; round++) {
    const landed: string[] = [];
    // A bulky passkey makes this write slow; the removal and the epoch bump
    // are made while it is still in flight.
    const adding = store
      .add({ id: "revoked", publicKey: "x".repeat(1 << 20), counter: 0 })
      .then(() => landed.push("add"));
    await stat(dirname(path)); // an fs round-trip: the add's write is under way
    const removing = store.remove("revoked").then(() => landed.push("remove"));
    const bumping = store.bumpTokenEpoch().then(() => landed.push("bump"));
    await Promise.all([adding, removing, bumping]);

    expect(landed).toEqual(["add", "remove", "bump"]);
    const onDisk = await CredentialStore.load(path);
    expect(onDisk.list().map((c) => c.id)).toEqual(["keep"]);
    expect(onDisk.tokenEpoch).toBe(round);
  }
});

test("a failed write undoes every change not yet on disk, so memory matches the disk, and later changes still land", async () => {
  const path = await tempStorePath();
  const store = await CredentialStore.load(path);
  await store.add({ id: "keep", publicKey: "pk", counter: 0 });
  await store.add({ id: "revoked", publicKey: "pk", counter: 0 });
  const before = structuredClone(store.list());

  // Every write fails while the store's directory is a file.
  await rm(dirname(path), { recursive: true });
  await writeFile(dirname(path), "");
  const outcomes = await Promise.allSettled([
    store.recordUse("keep", 1, 1_000),
    store.remove("revoked"),
    store.bumpTokenEpoch(),
  ]);
  expect(outcomes.map((o) => o.status)).toEqual([
    "rejected",
    "rejected",
    "rejected",
  ]);
  expect(store.list()).toEqual(before);
  expect(store.tokenEpoch).toBe(0);

  // Writable again: the next change lands, carrying none of the undone ones.
  await rm(dirname(path));
  await store.recordUse("keep", 2, 2_000);
  const reloaded = await CredentialStore.load(path);
  expect(reloaded.list().map((c) => c.id)).toEqual(["keep", "revoked"]);
  expect(reloaded.get("keep")).toMatchObject({ counter: 2, lastUsedAt: 2_000 });
  expect(reloaded.tokenEpoch).toBe(0);
});

test.skipIf(process.platform === "win32")(
  "the backing file is written owner-only (0600)",
  async () => {
    const path = await tempStorePath();
    const store = await CredentialStore.load(path);
    await store.add({ id: "cred", publicKey: "pk", counter: 0 });
    // low 9 permission bits must be rw for owner only
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  },
);

test("a corrupt store file throws rather than dropping credentials", async () => {
  const path = await tempStorePath();
  await (await CredentialStore.load(path)).add({
    id: "cred",
    publicKey: "pk",
    counter: 0,
  });
  await Bun.write(path, "{ not json");
  await expect(CredentialStore.load(path)).rejects.toThrow();
});

test("a write torn by a crash leaves the previous file whole and loadable", async () => {
  const path = await tempStorePath();
  const store = await CredentialStore.load(path);
  await store.add({ id: "keep", publicKey: "pk", counter: 0 });

  // The process dies halfway through writing the next state: half its bytes
  // reach the disk, then the write fails.
  const realWriteFile = fsp.writeFile;
  const torn = spyOn(fsp, "writeFile").mockImplementation(
    async (file, data, options) => {
      const text = String(data);
      await realWriteFile(file, text.slice(0, text.length / 2), options);
      throw new Error("simulated crash mid-write");
    },
  );
  try {
    await expect(
      store.add({ id: "lost", publicKey: "pk", counter: 0 }),
    ).rejects.toThrow("simulated crash");
  } finally {
    torn.mockRestore();
  }

  const reloaded = await CredentialStore.load(path);
  expect(reloaded.list().map((c) => c.id)).toEqual(["keep"]);
  // The failed write left nothing else behind.
  expect(await readdir(dirname(path))).toEqual([basename(path)]);
});
