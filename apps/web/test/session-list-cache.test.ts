import { expect, test } from "bun:test";
import type { SessionMeta, SessionsFrame } from "@omp-remote/protocol";
import {
  SESSION_LIST_KEY,
  SessionListCache,
  type SessionListStorage,
} from "../src/core/session-list-cache";
import type { MachineNode } from "../src/core/session-tree";
import { AppStore } from "../src/core/store";

interface MemoryStorage extends SessionListStorage {
  items: Map<string, string>;
}

/** In-memory storage standing in for `localStorage`. */
function memoryStorage(): MemoryStorage {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    id: "s",
    cwd: "/tmp/project",
    project: "project",
    model: "m",
    title: "T",
    pid: 1,
    startedAt: 0,
    ...over,
  };
}
const sessions = (list: SessionMeta[]): SessionsFrame => ({
  t: "sessions",
  sessions: list,
});

/** Machine id, stale flag and row titles: what a cold-load paint shows. */
function rows(tree: MachineNode[]) {
  return tree.map((m) => ({
    machineId: m.machineId,
    stale: m.stale === true,
    titles: m.projects.flatMap((p) => p.sessions.map((s) => s.title)),
  }));
}

/** A store on `storage` as a fresh page load builds it. */
function load(storage: MemoryStorage): AppStore {
  const store = new AppStore(
    Date.now,
    undefined,
    new SessionListCache(storage),
  );
  store.restoreCachedList();
  return store;
}

/** A previous visit that saw two titled sessions on machine-a. */
function visited(): MemoryStorage {
  const storage = memoryStorage();
  const store = load(storage);
  store.setMachineList(["machine-a"]);
  store.applyFrame(
    "machine-a",
    sessions([
      meta({ id: "a1", title: "Fix login", startedAt: 1 }),
      meta({ id: "a2", title: "", startedAt: 2 }),
    ]),
  );
  // a2's title lands later, through its transcript's state frame.
  store.applyFrame("machine-a", {
    t: "state",
    sessionId: "a2",
    model: "m",
    streaming: false,
    title: "Write docs",
  });
  return storage;
}

test("a snapshot with titles renders titled rows on the first draw", () => {
  const store = load(memoryStorage());
  expect(store.connecting()).toBe(true);
  expect(store.tree()).toEqual([]);
  store.setMachineList(["machine-a"]);
  store.applyFrame("machine-a", sessions([meta({ id: "a1", title: "Fix" })]));
  expect(store.connecting()).toBe(false);
  expect(rows(store.tree())).toEqual([
    { machineId: "machine-a", stale: false, titles: ["Fix"] },
  ]);
});

test("the cached list paints before connect and the live snapshot replaces it", () => {
  const store = load(visited());
  // Before any live data: the last list, titled, marked stale.
  expect(store.connecting()).toBe(true);
  const cold = rows(store.tree());
  expect(cold).toEqual([
    {
      machineId: "machine-a",
      stale: true,
      titles: ["Fix login", "Write docs"],
    },
  ]);

  // The machine list alone does not replace the rows; they stay stale.
  store.setMachineList(["machine-a"]);
  expect(store.connecting()).toBe(false);
  expect(rows(store.tree())).toEqual(cold);

  // The live snapshot (the agent now lists live titles) replaces them without
  // changing a title, and a session gone since last time disappears.
  store.applyFrame(
    "machine-a",
    sessions([meta({ id: "a2", title: "Write docs", startedAt: 2 })]),
  );
  expect(rows(store.tree())).toEqual([
    { machineId: "machine-a", stale: false, titles: ["Write docs"] },
  ]);
});

test("a cached machine the live machine list no longer carries is dropped and forgotten", () => {
  const storage = visited();
  const store = load(storage);
  store.setMachineList([]);
  expect(store.tree()).toEqual([]);
  expect(load(storage).tree()).toEqual([]);
});

test("a cached machine seen online this load stays, offline, when it drops before its snapshot", () => {
  const store = load(visited());
  store.setMachineList(["machine-a"]);
  store.setMachineList([]);
  expect(rows(store.tree())).toEqual([
    {
      machineId: "machine-a",
      stale: true,
      titles: ["Fix login", "Write docs"],
    },
  ]);
  expect(store.tree()[0]?.offline).toBe(true);
});

test("forgetting a machine removes it from the cache; others stay", () => {
  const storage = visited();
  const store = load(storage);
  store.setMachineList(["machine-a", "machine-b"]);
  store.applyFrame("machine-b", sessions([meta({ id: "b1", title: "B" })]));
  store.forgetMachine("machine-a");
  expect(rows(load(storage).tree())).toEqual([
    { machineId: "machine-b", stale: true, titles: ["B"] },
  ]);
});

test("a cleared cache (sign-out) paints nothing on the next load", () => {
  const storage = visited();
  new SessionListCache(storage).clear();
  const store = load(storage);
  expect(store.tree()).toEqual([]);
  expect(store.connecting()).toBe(true);
});

test("a malformed or foreign cache entry paints nothing", () => {
  for (const raw of ["{not json", '{"a":1}', '[{"machineId":""}]']) {
    const storage = memoryStorage();
    storage.setItem(SESSION_LIST_KEY, raw);
    expect(load(storage).tree()).toEqual([]);
  }
});

test("a sign-in that is not remembered keeps no session list on the device", () => {
  const storage = visited();
  const cache = new SessionListCache(storage);
  cache.persist(false);
  expect(storage.items.has(SESSION_LIST_KEY)).toBe(false);
  const store = new AppStore(Date.now, undefined, cache);
  store.setMachineList(["machine-a"]);
  store.applyFrame("machine-a", sessions([meta({ id: "a1", title: "X" })]));
  expect(storage.items.has(SESSION_LIST_KEY)).toBe(false);
});

test("the cache holds row labels only, never transcript content", () => {
  const storage = memoryStorage();
  const store = load(storage);
  store.setMachineList(["machine-a"]);
  store.applyFrame("machine-a", sessions([meta({ id: "a1" })]));
  store.applyFrame("machine-a", {
    t: "msg",
    sessionId: "a1",
    phase: "end",
    msgId: "u1",
    role: "user",
    text: "secret prompt text",
  });
  expect(storage.items.get(SESSION_LIST_KEY)).not.toContain("secret");
});
