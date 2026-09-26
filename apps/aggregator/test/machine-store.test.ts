import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as atomic from "../src/atomic-write";
import { MachineStore } from "../src/machine-store";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-machines-"));
  dirs.push(dir);
  return join(dir, "nested", "machines.json");
}

test("an issued token authenticates as its machine, and nothing else does", async () => {
  const store = await MachineStore.load(await tempStorePath());
  const t1 = await store.issue("m1", 1_000);
  const t2 = await store.issue("m2", 2_000);
  expect(store.authenticate(t1)).toBe("m1");
  expect(store.authenticate(t2)).toBe("m2");
  expect(store.authenticate("not-a-token")).toBeUndefined();
  expect(store.authenticate("")).toBeUndefined();
});

test("a second issue invalidates the first token and keeps joinedAt", async () => {
  const store = await MachineStore.load(await tempStorePath());
  const first = await store.issue("m1", 1_000);
  const second = await store.issue("m1", 5_000);
  expect(second).not.toBe(first);
  expect(store.authenticate(first)).toBeUndefined();
  expect(store.authenticate(second)).toBe("m1");
  expect(store.list()).toHaveLength(1);
  expect(store.list()[0]?.joinedAt).toBe(1_000);
});

test("a renewal authenticates beside the current token, survives a reload, and replaces it only when adopted; a newer renewal voids an unused one", async () => {
  const path = await tempStorePath();
  const store = await MachineStore.load(path);
  const current = await store.issue("m1", 1_000);
  const other = await store.issue("m2", 1_000);
  const voided = await store.renew("m1");
  const renewal = await store.renew("m1");
  expect(store.authenticate(voided)).toBeUndefined();
  expect(store.authenticate(renewal)).toBe("m1");

  const reloaded = await MachineStore.load(path);
  expect(reloaded.authenticate(current)).toBe("m1");
  expect(reloaded.authenticate(renewal)).toBe("m1");
  // Only m1's own renewal is adopted: not its current token, nor for m2.
  expect(await reloaded.adopt("m1", current)).toBe(false);
  expect(await reloaded.adopt("m2", renewal)).toBe(false);
  expect(await reloaded.adopt("m1", renewal)).toBe(true);
  expect(reloaded.authenticate(current)).toBeUndefined();
  expect(reloaded.authenticate(renewal)).toBe("m1");
  expect(await reloaded.adopt("m1", renewal)).toBe(false);
  expect(reloaded.authenticate(other)).toBe("m2");
  await expect(reloaded.renew("nobody")).rejects.toThrow();
});

test("revoke invalidates the token; revoking an unknown machine is false", async () => {
  const store = await MachineStore.load(await tempStorePath());
  const token = await store.issue("m1", 1_000);
  expect(await store.revoke("m1")).toBe(true);
  expect(store.authenticate(token)).toBeUndefined();
  expect(store.list()).toEqual([]);
  expect(await store.revoke("m1")).toBe(false);
});

test("tokens survive a reload; the file holds only their hashes, owner-only", async () => {
  const path = await tempStorePath();
  const store = await MachineStore.load(path);
  const token = await store.issue("m1", 1_000);
  store.touch("m1", 3_000);
  const other = await store.issue("m2", 2_000);

  const raw = await readFile(path, "utf8");
  expect(raw).not.toContain(token);
  expect(raw).not.toContain(other);
  if (process.platform !== "win32")
    expect((await stat(path)).mode & 0o777).toBe(0o600);

  const reloaded = await MachineStore.load(path);
  expect(reloaded.authenticate(token)).toBe("m1");
  expect(reloaded.authenticate(other)).toBe("m2");
  expect(reloaded.list().find((m) => m.machineId === "m1")?.lastSeenAt).toBe(
    3_000,
  );
});

test("an invalid machineId is refused and issues nothing", async () => {
  const store = await MachineStore.load(await tempStorePath());
  await expect(store.issue("has space", 1_000)).rejects.toThrow();
  expect(store.list()).toEqual([]);
});

test("a corrupt file throws instead of dropping every machine", async () => {
  const path = await tempStorePath();
  const store = await MachineStore.load(path);
  await store.issue("m1", 1_000);
  await writeFile(path, "{not json");
  await expect(MachineStore.load(path)).rejects.toThrow();
});

test("a failed write undoes the issue it carried", async () => {
  const store = await MachineStore.load(await tempStorePath());
  const kept = await store.issue("m1", 1_000);
  const spy = spyOn(atomic, "writeFileAtomic").mockRejectedValueOnce(
    new Error("disk full"),
  );
  try {
    await expect(store.issue("m1", 2_000)).rejects.toThrow("disk full");
  } finally {
    spy.mockRestore();
  }
  expect(store.authenticate(kept)).toBe("m1");
});
