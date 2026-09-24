import { afterAll, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PushSubscriptionStore } from "../src/push-store";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-push-"));
  dirs.push(dir);
  return join(dir, "nested", "subscriptions.json");
}

const subA = {
  endpoint: "https://fcm.googleapis.com/fcm/send/aaa",
  keys: { p256dh: "cGtleUE", auth: "YXV0aEE" },
};
const subB = {
  endpoint: "https://updates.push.services.mozilla.com/wpush/v2/bbb",
  keys: { p256dh: "cGtleUI", auth: "YXV0aEI" },
};

test("subscriptions persist across a reload", async () => {
  const path = await tempStorePath();
  const store = await PushSubscriptionStore.load(path);
  await store.add(subA);
  await store.add(subB);

  const reloaded = await PushSubscriptionStore.load(path);
  expect(reloaded.list()).toEqual([subA, subB]);
});

test("re-adding the same endpoint replaces, never duplicates", async () => {
  const path = await tempStorePath();
  const store = await PushSubscriptionStore.load(path);
  await store.add(subA);
  await store.add({ ...subA, keys: { p256dh: "bmV3", auth: "a2V5cw" } });

  const list = store.list();
  expect(list).toHaveLength(1);
  expect(list[0]?.keys.p256dh).toBe("bmV3");
});

test("remove drops a subscription by endpoint", async () => {
  const path = await tempStorePath();
  const store = await PushSubscriptionStore.load(path);
  await store.add(subA);
  await store.add(subB);
  await store.remove(subA.endpoint);
  expect(store.list()).toEqual([subB]);

  const reloaded = await PushSubscriptionStore.load(path);
  expect(reloaded.list()).toEqual([subB]);
});

test("a corrupt store file throws rather than silently dropping devices", async () => {
  const path = await tempStorePath();
  await (await PushSubscriptionStore.load(path)).add(subA);
  await writeFile(path, "{ not json");
  await expect(PushSubscriptionStore.load(path)).rejects.toThrow();
});

test.skipIf(process.platform === "win32")(
  "the backing file is written owner-only (0600)",
  async () => {
    const path = await tempStorePath();
    const store = await PushSubscriptionStore.load(path);
    await store.add(subA);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  },
);

test("a write torn by a crash leaves the previous file whole and loadable", async () => {
  const path = await tempStorePath();
  const store = await PushSubscriptionStore.load(path);
  await store.add(subA);

  // The process dies halfway through writing the next state.
  const realWriteFile = fsp.writeFile;
  const torn = spyOn(fsp, "writeFile").mockImplementation(
    async (file, data, options) => {
      const text = String(data);
      await realWriteFile(file, text.slice(0, text.length / 2), options);
      throw new Error("simulated crash mid-write");
    },
  );
  try {
    await expect(store.add(subB)).rejects.toThrow("simulated crash");
  } finally {
    torn.mockRestore();
  }

  expect((await PushSubscriptionStore.load(path)).list()).toEqual([subA]);
  expect(await readdir(dirname(path))).toEqual([basename(path)]);
});
