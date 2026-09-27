import { expect, test } from "bun:test";
import type { SessionMeta, SessionsFrame } from "@omp-remote/protocol";
import {
  NotificationTaps,
  type PendingOpenStorage,
  decideTap,
} from "../src/core/notification-tap";
import { SessionListCache } from "../src/core/session-list-cache";
import { AppStore } from "../src/core/store";

function meta(id: string): SessionMeta {
  return {
    id,
    cwd: "/home/me/proj",
    project: "proj",
    model: "m",
    title: "T",
    pid: 1,
    startedAt: 0,
  };
}
const sessions = (...ids: string[]): SessionsFrame => ({
  t: "sessions",
  sessions: ids.map(meta),
});

/** A cold load whose device cache last showed m1 running s1. */
function coldLoad(): AppStore {
  const items = new Map<string, string>();
  const cache = new SessionListCache({
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  });
  cache.save([{ machineId: "m1", sessions: [meta("s1")] }]);
  const store = new AppStore(Date.now, undefined, cache);
  store.restoreCachedList();
  return store;
}

const tap = (store: AppStore, sessionId = "s1") =>
  decideTap({ machineId: "m1", sessionId }, store.tree(), store.connecting());

test("a tapped notification waits while its machine's list is in doubt, then opens the live session", () => {
  const store = coldLoad();
  // The cached rows list s1, but they may be stale.
  expect(tap(store)).toBe("wait");
  store.setMachineList(["m1"]);
  expect(tap(store)).toBe("wait");
  store.applyFrame("m1", sessions("s1"));
  expect(tap(store)).toBe("open");

  // A resume check doubts the list until its pong; a lost socket until the
  // next snapshot.
  store.doubtLists();
  expect(tap(store)).toBe("wait");
  store.confirmLists();
  expect(tap(store)).toBe("open");
  store.awaitSnapshots();
  expect(tap(store)).toBe("wait");
  store.applyFrame("m1", sessions("s1"));
  expect(tap(store)).toBe("open");
});

test("a tapped notification for a session its machine's current list no longer has reports it ended", () => {
  const store = coldLoad();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions("s2"));
  expect(tap(store)).toBe("ended");
  // Ended this load (the bye), even while still selected elsewhere.
  store.applyFrame("m1", sessions("s1", "s2"));
  store.applyFrame("m1", { t: "bye", sessionId: "s1" });
  store.applyFrame("m1", sessions("s2"));
  expect(tap(store)).toBe("ended");
});

test("a tapped notification gives up once its machine is offline, which outranks a list in doubt", () => {
  const store = coldLoad();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions("s1"));
  store.setMachineList([]);
  expect(tap(store)).toBe("offline");
  // The relay link lost too: every machine's rows sync, but an offline one
  // is not about to report in.
  store.awaitSnapshots();
  expect(tap(store)).toBe("offline");

  // A machine the first live list does not carry was never seen online this
  // load: its cached rows go, and so does the wait.
  const cold = coldLoad();
  cold.setMachineList(["m2"]);
  expect(tap(cold)).toBe("offline");
  // Before any live data, an unknown machine may still report in.
  expect(tap(new AppStore())).toBe("wait");
});

/** A tab's `sessionStorage`: it outlives a reload of the window. */
function tabStorage(): PendingOpenStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

/**
 * One load of the app over `store`, paired with m1: what its taps did. Its
 * link check doubts every list until the pong, as the client's does.
 */
function appLoad(
  store: AppStore,
  storage: PendingOpenStorage,
  opts: { signedIn?: boolean; hidden?: boolean } = {},
) {
  const seen = { opened: [] as string[], ended: 0, backs: 0 };
  const taps = new NotificationTaps({
    storage,
    pairedMachineIds: () => ["m1"],
    ready: () => opts.signedIn ?? true,
    tree: () => store.tree(),
    connecting: () => store.connecting(),
    hidden: () => opts.hidden ?? false,
    probe: () => store.doubtLists(),
    open: (sessionId) => seen.opened.push(sessionId),
    back: () => {
      seen.backs += 1;
    },
    ended: () => {
      seen.ended += 1;
    },
  });
  store.subscribe(() => taps.settle());
  return { taps, seen };
}

test("a tap that brings a backgrounded app forward waits for a current list, so a session started meanwhile opens instead of reading as ended", () => {
  // The list the page last saw before it was frozen in the background.
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions("s1"));
  const { taps, seen } = appLoad(store, tabStorage(), { hidden: true });
  taps.tapped({ machineId: "m1", sessionId: "s2" });
  expect(seen).toEqual({ opened: [], ended: 0, backs: 1 });

  // What the relay sent while the page was frozen lands before the pong.
  store.applyFrame("m1", sessions("s1", "s2"));
  store.confirmLists();
  expect(seen).toEqual({ opened: ["s2"], ended: 0, backs: 1 });
});

test("a tapped session still waiting when the window reloads into a new deploy opens after the reload, and only once", () => {
  const storage = tabStorage();
  // The window a tap opened, before its sign-in has a client running.
  appLoad(coldLoad(), storage, { signedIn: false }).taps.tapped({
    machineId: "m1",
    sessionId: "s1",
  });

  // The new service worker takes over, and the page reloads into it.
  const store = coldLoad();
  const reloaded = appLoad(store, storage);
  expect(reloaded.taps.settle()).toBe("wait");
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions("s1"));
  expect(reloaded.seen.opened).toEqual(["s1"]);

  // Decided, it is gone: the next load starts on the list.
  expect(appLoad(coldLoad(), storage).taps.settle()).toBeUndefined();
});

test("a reload into a new deploy opens the session that was open again once the new list is current", () => {
  const storage = tabStorage();
  appLoad(coldLoad(), storage).taps.carry({ machineId: "m1", sessionId: "s1" });

  const store = coldLoad();
  const reloaded = appLoad(store, storage);
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions("s1"));
  expect(reloaded.seen.opened).toEqual(["s1"]);
});

test("a tap from a machine not paired here, or one dropped by opening another session, opens nothing, then or after a reload", () => {
  const storage = tabStorage();
  const { taps } = appLoad(coldLoad(), storage, { signedIn: false });
  taps.tapped({ machineId: "m9", sessionId: "s1" });
  taps.tapped({ machineId: "m1", sessionId: "s1" });
  taps.drop();

  const store = coldLoad();
  const reloaded = appLoad(store, storage);
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions("s1"));
  expect(reloaded.seen.opened).toEqual([]);
  expect(reloaded.taps.settle()).toBeUndefined();
});
