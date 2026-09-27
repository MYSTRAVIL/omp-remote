import { expect, test } from "bun:test";
import {
  clientSessionKeys,
  newIdentity,
  notifyKey,
  serverSessionKeys,
} from "@omp-remote/crypto";
import {
  type NotifyNotice,
  type SealedFrame,
  sealNotice,
} from "@omp-remote/protocol";
import type { BadgeApi } from "../src/core/app-badge";
import {
  COSTLY_REMOVALS_PER_DAY,
  CostlyRemovals,
} from "../src/core/costly-removals";
import {
  DISMISSED_NOTICES_MAX,
  DismissedNotices,
  type SeenReceivers,
} from "../src/core/dismissed-notices";
import {
  PREFS_CACHE,
  readNotifyDetail,
  readNotifyKeys,
  readQuietWhileOpen,
  saveNotifyDetail,
  saveNotifyKeys,
  staleShellCaches,
} from "../src/core/sw-caches";
import {
  ATTENTION_BODY,
  ATTENTION_TAG,
  ATTENTION_TITLE,
  type ClientsLike,
  type NotificationShower,
  type NotificationSpec,
  QUIET_TAG,
  SETTLED_BODY,
  type WindowClientLike,
  type WorkerMessage,
  closeSettled,
  handlePush,
  openFromNotification,
  openSessionTarget,
  openSessionUrl,
  reportDismissed,
} from "../src/core/sw-push";
import { fakeCaches } from "./fixtures/fake-push";

interface Shown {
  title: string;
  options: NotificationSpec;
  closed: boolean;
}

function expectSingleNotification(shown: Shown[]): {
  title: string;
  options: NotificationSpec;
} {
  expect(shown).toHaveLength(1);
  const first = shown[0];
  if (first === undefined) throw new Error("no notification");
  return { title: first.title, options: first.options };
}

/** A registration keeping every notification it showed, open until closed. */
function fakeRegistration() {
  const shown: Shown[] = [];
  const registration: NotificationShower = {
    async showNotification(title, options) {
      // A new notification under a tag already showing replaces it.
      for (const earlier of shown)
        if (earlier.options.tag === options.tag) earlier.closed = true;
      shown.push({ title, options, closed: false });
    },
    async getNotifications(filter) {
      return shown
        .filter(({ closed, options }) => {
          if (closed) return false;
          if (filter === undefined) return true;
          return options.tag === filter.tag;
        })
        .map((notification) => ({
          tag: notification.options.tag,
          title: notification.title,
          data: notification.options.data,
          close: () => {
            notification.closed = true;
          },
        }));
    },
  };
  return { registration, shown };
}

/** This app's windows in the browser; one the worker doesn't control yet shows only to `includeUncontrolled`. */
function fakeClients(
  windows: readonly { visible: boolean; controlled?: boolean }[],
): ClientsLike {
  return {
    async matchAll({ includeUncontrolled }) {
      return windows
        .filter(({ controlled = true }) => controlled || includeUncontrolled)
        .map(
          ({ visible }): WindowClientLike => ({
            visibilityState: visible ? "visible" : "hidden",
            focus: async () => undefined,
            postMessage: () => {},
          }),
        );
    },
    async openWindow() {
      return null;
    },
  };
}

/** A window of the app that records what the worker does to it. */
function recordingWindow() {
  const seen: { focused: number; messages: WorkerMessage[] } = {
    focused: 0,
    messages: [],
  };
  const window: WindowClientLike = {
    visibilityState: "hidden",
    async focus() {
      seen.focused += 1;
      return undefined;
    },
    postMessage(message) {
      seen.messages.push(message);
    },
  };
  return { window, seen };
}

/** The app's windows (`open`), recording the address a new one opens at. */
function recordingClients(open: readonly WindowClientLike[]) {
  const opened: string[] = [];
  const clients: ClientsLike = {
    async matchAll() {
      return open;
    },
    async openWindow(url) {
      opened.push(url);
      return null;
    },
  };
  return { clients, opened };
}

const ICONS = { icon: "/icons/icon-192.png", badge: "/icons/badge-96.png" };
/** The one generic attention notification, still showing. */
const GENERIC = {
  title: ATTENTION_TITLE,
  options: {
    body: ATTENTION_BODY,
    tag: ATTENTION_TAG,
    renotify: true,
    ...ICONS,
  },
  closed: false,
};
/**
 * A push that shows nothing: shown silently under the quiet tag, and closed.
 * If the close loses the race with the browser, what is left says only what
 * is true: its session's notification, or that nothing waits.
 */
function quieted(
  title: string,
  body: string,
  data?: { machineId: string; sessionId: string },
) {
  return {
    title,
    options: { body, tag: QUIET_TAG, silent: true, ...ICONS, data },
    closed: true,
  };
}
/** A quiet push this device can't open: it names no session, so nothing waits. */
const QUIETED_UNNAMED = quieted(ATTENTION_TITLE, SETTLED_BODY);

/** A day, as the costly removals count it. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** What a worker needs only for clear notices, for pushes that carry none. */
function noClears() {
  return {
    removals: new CostlyRemovals(fakeCaches().caches),
    now: () => 0,
  };
}

/** Count `n` costly removals at `now`, as that many clears would have. */
async function spendRemovals(
  removals: CostlyRemovals,
  now: number,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) await removals.remove(now, async () => true);
}

/** How a test sets up its paired worker. */
interface WorkerOpts {
  quietWhileOpen?: boolean;
  notifyDetail?: "private" | "session" | "preview";
  badge?: BadgeApi;
  /** Wrap the worker's costly-removal count, as `landingTogether` does. */
  ledger?: (removals: CostlyRemovals) => Pick<CostlyRemovals, "remove">;
}

/**
 * Machine m1 paired with this phone as the agent and the page each hold it:
 * the agent seals notices with `notifyKey(tx)`; the page saved
 * `notifyKey(rx)` for the worker, with the name it shows ("Laptop").
 */
async function pairedWorker(opts: WorkerOpts = {}) {
  const phone = await newIdentity();
  const host = await newIdentity();
  const phoneKeys = await clientSessionKeys(phone, host.publicKey);
  const hostKeys = await serverSessionKeys(host, phone.publicKey);
  const agentKey = await notifyKey(hostKeys.tx);
  const storage = fakeCaches();
  await saveNotifyKeys(
    storage.caches,
    new Map([["m1", { key: await notifyKey(phoneKeys.rx), label: "Laptop" }]]),
  );
  if (opts.notifyDetail !== undefined) {
    await saveNotifyDetail(storage.caches, opts.notifyDetail);
  }
  const { registration, shown } = fakeRegistration();
  const dismissed = new DismissedNotices(storage.caches);
  const removals = new CostlyRemovals(storage.caches);
  const ledger = opts.ledger?.(removals) ?? removals;
  /** The worker's clock; a test moves it on by setting `now`. */
  const clock = { now: 1_000 * DAY_MS };
  const push = (
    notice: NotifyNotice,
    windows: readonly { visible: boolean }[] = [],
  ) =>
    sealNotice(agentKey, "m1", notice).then((envelope) =>
      handlePush(
        {
          clients: fakeClients(windows),
          registration,
          quietWhileOpen: async () => opts.quietWhileOpen ?? true,
          notifyKeys: () => readNotifyKeys(storage.caches),
          notifyDetail: () => readNotifyDetail(storage.caches),
          forgetDismissed: (target) => dismissed.forget(target),
          removals: ledger,
          now: () => clock.now,
          badge: opts.badge,
        },
        JSON.stringify(envelope),
      ),
    );
  return {
    push,
    registration,
    shown,
    agentKey,
    storage,
    dismissed,
    removals,
    clock,
  };
}

test("an attention notice shows its session's notification: named after it, where it runs and what it waits for", async () => {
  const { push, shown } = await pairedWorker();
  await push({
    kind: "attention",
    sessionId: "s1",
    reason: "question",
    title: "Fix the login bug",
    project: "omp-remote",
    detail: "Which branch should I use?",
  });
  expect(shown).toEqual([
    {
      title: "Fix the login bug",
      options: {
        body: "Laptop · omp-remote\nQuestion: Which branch should I use?",
        tag: "session:m1:s1",
        renotify: true,
        ...ICONS,
        data: { machineId: "m1", sessionId: "s1" },
      },
      closed: false,
    },
  ]);

  // An untitled session goes by its project; no detail, no colon. The same
  // session's next notice replaces its notification.
  await push({
    kind: "attention",
    sessionId: "s1",
    reason: "approval",
    title: "",
    project: "omp-remote",
    detail: "",
  });
  await push({
    kind: "attention",
    sessionId: "s2",
    reason: "idle",
    title: "",
    project: "",
    detail: "",
  });
  expect(
    shown
      .filter(({ closed }) => !closed)
      .map(({ title, options }) => [title, options.tag, options.body]),
  ).toEqual([
    ["omp-remote", "session:m1:s1", "Laptop · omp-remote\nNeeds approval"],
    ["Session", "session:m1:s2", "Laptop\nWaiting for you"],
  ]);
});

test("notification detail: preview shows full text (default)", async () => {
  const { push, shown } = await pairedWorker();
  await push({
    kind: "attention",
    sessionId: "s1",
    reason: "question",
    title: "Fix the login bug",
    project: "omp-remote",
    detail: "Which branch should I use?",
  });
  const { title, options } = expectSingleNotification(shown);
  expect(title).toBe("Fix the login bug");
  expect(options.body).toBe(
    "Laptop · omp-remote\nQuestion: Which branch should I use?",
  );
});

test("notification detail: session shows reason only, no detail text", async () => {
  const { push, shown } = await pairedWorker({ notifyDetail: "session" });
  await push({
    kind: "attention",
    sessionId: "s1",
    reason: "question",
    title: "Fix the login bug",
    project: "omp-remote",
    detail: "Which branch should I use?",
  });
  const { title, options } = expectSingleNotification(shown);
  expect(title).toBe("Fix the login bug");
  expect(options.body).toBe("Laptop · omp-remote\nQuestion");
});

test("notification detail: private shows generic title and body", async () => {
  const { push, shown } = await pairedWorker({ notifyDetail: "private" });
  await push({
    kind: "attention",
    sessionId: "s1",
    reason: "question",
    title: "Fix the login bug",
    project: "omp-remote",
    detail: "Which branch should I use?",
  });
  const { title, options } = expectSingleNotification(shown);
  expect(title).toBe(ATTENTION_TITLE);
  expect(options.body).toBe(ATTENTION_BODY);
});

test("notification detail: tag and data are identical across levels", async () => {
  const notice = {
    kind: "attention" as const,
    sessionId: "s1",
    reason: "question" as const,
    title: "Fix the login bug",
    project: "omp-remote",
    detail: "Which branch?",
  };

  const levels = ["private", "session", "preview"] as const;
  const tags: string[] = [];
  const serializedData: string[] = [];
  for (const level of levels) {
    const { push, shown } = await pairedWorker({ notifyDetail: level });
    await push(notice);
    const { options } = expectSingleNotification(shown);
    tags.push(options.tag);
    serializedData.push(JSON.stringify(options.data));
  }
  expect(tags.every((t) => t === tags[0])).toBe(true);
  expect(serializedData.every((d) => d === serializedData[0])).toBe(true);
  expect(tags[0]).toBe("session:m1:s1");
});

test("default detail is preview when pref is missing", async () => {
  const { push, shown } = await pairedWorker();
  await push({
    kind: "attention",
    sessionId: "s1",
    reason: "question",
    title: "Fix bug",
    project: "app",
    detail: "Which branch?",
  });
  const { title, options } = expectSingleNotification(shown);
  expect(title).toBe("Fix bug");
  expect(options.body).toContain("Which branch?");
});

test("unreadable detail pref falls back to preview", async () => {
  const { push, shown, storage } = await pairedWorker();
  // Corrupt the pref: save an invalid value
  const prefs = await storage.caches.open(PREFS_CACHE);
  await prefs.put("/__prefs/notify-detail", new Response("garbage"));
  await push({
    kind: "attention",
    sessionId: "s1",
    reason: "question",
    title: "Fix bug",
    project: "app",
    detail: "Which branch?",
  });
  const { title, options } = expectSingleNotification(shown);
  expect(title).toBe("Fix bug");
  expect(options.body).toContain("Which branch?");
});

test("with quiet on, an attention notice while a window is on screen is shown silently with its session's content and closed at once", async () => {
  const { push, shown } = await pairedWorker();
  await push(
    {
      kind: "attention",
      sessionId: "s1",
      reason: "idle",
      title: "T",
      project: "p",
      detail: "",
    },
    // A page the worker doesn't control yet counts too (see fakeClients).
    [{ visible: false }, { visible: true }],
  );
  // Left showing by a close that lost its race, it reads as the session's
  // own notification, and a tap on it opens the session.
  expect(shown).toEqual([
    quieted("T", "Laptop · p\nWaiting for you", {
      machineId: "m1",
      sessionId: "s1",
    }),
  ]);
});

test("a clear notice closes only its session's notification, and still shows and closes a silent one", async () => {
  for (const windows of [[], [{ visible: false }], [{ visible: true }]]) {
    const { push, registration, shown } = await pairedWorker();
    const attention = (sessionId: string) =>
      push({
        kind: "attention",
        sessionId,
        reason: "idle",
        title: sessionId,
        project: "p",
        detail: "",
      });
    await attention("s1");
    await attention("s2");
    // The generic notification of an undecodable push, from before.
    await handlePush(
      {
        clients: fakeClients([]),
        registration,
        quietWhileOpen: async () => true,
        notifyKeys: async () => new Map(),
        notifyDetail: () => readNotifyDetail(fakeCaches().caches),
        forgetDismissed: async () => undefined,
        ...noClears(),
      },
      undefined,
    );
    await push({ kind: "clear", sessionId: "s1" }, windows);
    const openAfterClear = shown.filter(({ closed }) => !closed);
    expect(openAfterClear.map(({ options }) => options.tag)).toEqual([
      "session:m1:s2",
      ATTENTION_TAG,
    ]);
    // Closing one is not showing one: every push shows its own, even with a
    // window of the app on screen, or WebKit drops the subscription. It says
    // the session no longer waits.
    expect(shown.at(-1)).toEqual(
      quieted("s1", SETTLED_BODY, { machineId: "m1", sessionId: "s1" }),
    );
  }
});

test("a clear finding its notification already gone never says a session waits", async () => {
  for (const windows of [[], [{ visible: true }]]) {
    const { push, shown } = await pairedWorker();
    // The user swiped the notification away before the session was answered.
    await push({ kind: "clear", sessionId: "s1" }, windows);
    expect(shown).toEqual([
      quieted("Laptop", SETTLED_BODY, { machineId: "m1", sessionId: "s1" }),
    ]);
  }
});

test("a push this device can't open raises the generic notification", async () => {
  const { registration, shown, agentKey, storage } = await pairedWorker();
  const sealed = await sealNotice(agentKey, "m1", {
    kind: "clear",
    sessionId: "s1",
  });
  const stranger = await sealNotice(
    await notifyKey(crypto.getRandomValues(new Uint8Array(32))),
    "m1",
    { kind: "clear", sessionId: "s1" },
  );
  const payloads = [
    undefined, // an older agent's push carries no data
    "not json",
    JSON.stringify({ hello: "world" }),
    JSON.stringify({ ...sealed, m: "m2" }), // a machine not paired here
    JSON.stringify(stranger), // sealed with another pairing's key
    // Altered in transit: its first character changed.
    JSON.stringify({
      ...sealed,
      ct: `${sealed.ct.startsWith("A") ? "B" : "A"}${sealed.ct.slice(1)}`,
    }),
  ];
  for (const payload of payloads) {
    shown.length = 0;
    await handlePush(
      {
        clients: fakeClients([{ visible: false }]),
        registration,
        quietWhileOpen: async () => true,
        notifyKeys: () => readNotifyKeys(storage.caches),
        notifyDetail: () => readNotifyDetail(storage.caches),
        forgetDismissed: async () => undefined,
        ...noClears(),
      },
      payload,
    );
    expect(shown).toEqual([GENERIC]);
  }
});

test("a worker whose saved keys are missing or unreadable opens nothing", async () => {
  expect(await readNotifyKeys(fakeCaches().caches)).toEqual(new Map());
  expect(await readNotifyKeys(fakeCaches({ unreadable: true }).caches)).toEqual(
    new Map(),
  );
});

test("a failed window lookup still raises the generic notification", async () => {
  const { registration, shown } = fakeRegistration();
  await handlePush(
    {
      clients: {
        matchAll: () => Promise.reject(new Error("worker shutting down")),
        openWindow: async () => null,
      },
      registration,
      quietWhileOpen: async () => true,
      notifyKeys: async () => new Map(),
      notifyDetail: () => readNotifyDetail(fakeCaches().caches),
      forgetDismissed: async () => undefined,
      ...noClears(),
    },
    undefined,
  );
  expect(shown).toEqual([GENERIC]);
});

test("with quiet on, a push while a window is on screen is shown silently and closed at once", async () => {
  const { registration, shown } = fakeRegistration();
  const deps = (
    windows: readonly { visible: boolean; controlled?: boolean }[],
  ) => ({
    clients: fakeClients(windows),
    registration,
    quietWhileOpen: async () => true,
    notifyKeys: async () => new Map(),
    notifyDetail: () => readNotifyDetail(fakeCaches().caches),
    forgetDismissed: async () => undefined,
    ...noClears(),
  });
  // An attention notification from before the app came on screen.
  await handlePush(deps([]), undefined);

  // A page the worker doesn't control yet (a first load, a hard reload) counts too.
  await handlePush(
    deps([{ visible: false }, { visible: true, controlled: false }]),
    undefined,
  );
  // Every push shows a notification, so no browser drops the subscription for
  // pushes that show nothing: this one silently, closed at once. No attention
  // notification is added, and the earlier one stays.
  expect(shown).toEqual([GENERIC, QUIETED_UNNAMED]);
});

test("with quiet off, a push while the app is on screen raises its notification", async () => {
  const { registration, shown } = fakeRegistration();
  await handlePush(
    {
      clients: fakeClients([{ visible: true }]),
      registration,
      quietWhileOpen: async () => false,
      notifyKeys: async () => new Map(),
      notifyDetail: () => readNotifyDetail(fakeCaches().caches),
      forgetDismissed: async () => undefined,
      ...noClears(),
    },
    undefined,
  );
  expect(shown).toEqual([GENERIC]);

  const worker = await pairedWorker({ quietWhileOpen: false });
  await worker.push(
    {
      kind: "attention",
      sessionId: "s1",
      reason: "idle",
      title: "T",
      project: "",
      detail: "",
    },
    [{ visible: true }],
  );
  expect(worker.shown.map(({ options }) => options.tag)).toEqual([
    "session:m1:s1",
  ]);
});

test("a device that never saved the quiet choice, or can't read it, has quiet on", async () => {
  for (const storage of [fakeCaches(), fakeCaches({ unreadable: true })]) {
    const { registration, shown } = fakeRegistration();
    await handlePush(
      {
        clients: fakeClients([{ visible: true }]),
        registration,
        quietWhileOpen: () => readQuietWhileOpen(storage.caches),
        notifyKeys: () => readNotifyKeys(storage.caches),
        notifyDetail: () => readNotifyDetail(storage.caches),
        forgetDismissed: async () => undefined,
        ...noClears(),
      },
      undefined,
    );
    expect(shown).toEqual([QUIETED_UNNAMED]);
  }
});

test("activating a deploy deletes the shells of earlier deploys and keeps the prefs cache", () => {
  expect(
    staleShellCaches(
      ["omp-remote-shell-1111111", PREFS_CACHE, "omp-remote-shell-2222222"],
      "omp-remote-shell-2222222",
    ),
  ).toEqual(["omp-remote-shell-1111111"]);
});

test("a tap on a session's notification, waiting or settled, opens that session in the open window", async () => {
  const { window, seen } = recordingWindow();
  const { clients } = recordingClients([window]);
  await openFromNotification(clients, { machineId: "m1", sessionId: "s1" });
  await openFromNotification(clients, {
    machineId: "m1",
    sessionId: "s2",
    settled: true,
  });
  expect(seen.focused).toBe(2);
  expect(seen.messages).toEqual([
    { type: "open-session", machineId: "m1", sessionId: "s1" },
    { type: "open-session", machineId: "m1", sessionId: "s2" },
  ]);
});

test("a tap with no window open starts a new one on the session", async () => {
  const { clients, opened } = recordingClients([]);
  await openFromNotification(clients, { machineId: "m1", sessionId: "s1" });
  expect(opened).toEqual([
    openSessionUrl({ machineId: "m1", sessionId: "s1" }),
  ]);
});

test("a tap on the generic notification just brings the app forward", async () => {
  const { window, seen } = recordingWindow();
  const { clients } = recordingClients([window]);
  await openFromNotification(clients, {});
  expect(seen.focused).toBe(1);
  expect(seen.messages).toEqual([]);

  // With no window open, it opens one on the list.
  const none = recordingClients([]);
  await openFromNotification(none.clients, undefined);
  expect(none.opened).toEqual(["/"]);
});

test("the page reads a tapped session from its address only for a machine paired here", () => {
  expect(openSessionTarget("?open=m1:s1", ["m1", "m2"])).toEqual({
    machineId: "m1",
    sessionId: "s1",
  });
  // A machine not paired here: the address is read, but the notification is not opened.
  expect(openSessionTarget("?open=m3:s1", ["m1", "m2"])).toBeUndefined();
  // A machine id may contain colons: the longest paired id that fits wins.
  expect(openSessionTarget("?open=a:b:s1", ["a", "a:b"])).toEqual({
    machineId: "a:b",
    sessionId: "s1",
  });
  // The address a tapped notification opens reads back as its session, colons
  // in either id and all.
  const address = openSessionUrl({ machineId: "lab:2", sessionId: "s:1" });
  expect(
    openSessionTarget(address.slice(address.indexOf("?")), ["lab", "lab:2"]),
  ).toEqual({ machineId: "lab:2", sessionId: "s:1" });
  expect(openSessionTarget("", ["m1"])).toBeUndefined();
});

/** An app badge recording each number it is set to; a clear is 0. */
function recordingBadge(opts: { refuse?: boolean } = {}) {
  const set: number[] = [];
  const badge: BadgeApi = {
    async setAppBadge(contents) {
      if (opts.refuse) throw new Error("not allowed");
      set.push(contents ?? 0);
    },
    async clearAppBadge() {
      if (opts.refuse) throw new Error("not allowed");
      set.push(0);
    },
  };
  return { badge, set };
}

test("each session notification shown or closed sets the app badge to the sessions with one showing", async () => {
  const { badge, set } = recordingBadge();
  const { push, registration } = await pairedWorker({ badge });
  const attention = (
    sessionId: string,
    windows: readonly { visible: boolean }[] = [],
  ) =>
    push(
      {
        kind: "attention",
        sessionId,
        reason: "idle",
        title: sessionId,
        project: "p",
        detail: "",
      },
      windows,
    );
  await attention("s1");
  await attention("s2");
  // The same session's next notice replaces its notification.
  await attention("s2");
  // The generic notification names no session, and a quieted push shows
  // none (the page on screen keeps the badge): neither sets it.
  await handlePush(
    {
      clients: fakeClients([]),
      registration,
      quietWhileOpen: async () => true,
      notifyKeys: async () => new Map(),
      notifyDetail: async () => "preview",
      forgetDismissed: async () => undefined,
      ...noClears(),
      badge,
    },
    undefined,
  );
  await attention("s3", [{ visible: true }]);
  expect(set).toEqual([1, 2, 2]);

  await push({ kind: "clear", sessionId: "s1" });
  await push({ kind: "clear", sessionId: "s2" });
  expect(set).toEqual([1, 2, 2, 1, 0]);
});

test("a worker whose badge is refused still shows and closes notifications", async () => {
  const { badge, set } = recordingBadge({ refuse: true });
  const { push, shown } = await pairedWorker({ badge });
  for (const sessionId of ["s1", "s2"])
    await push({
      kind: "attention",
      sessionId,
      reason: "idle",
      title: "T",
      project: "p",
      detail: "",
    });
  await push({ kind: "clear", sessionId: "s1" });
  expect(set).toEqual([]);
  expect(shown[0]?.options.tag).toBe("session:m1:s1");
  expect(shown[0]?.closed).toBe(true);
});

/** A worker with a question waiting per session, and what it shows. */
async function questionWorker(opts: WorkerOpts = {}) {
  const worker = await pairedWorker(opts);
  const open = () => worker.shown.filter(({ closed }) => !closed);
  const attention = (sessionId: string) =>
    worker.push({
      kind: "attention",
      sessionId,
      reason: "question",
      title: `Fix ${sessionId}`,
      project: "omp-remote",
      detail: "Which branch?",
    });
  const clear = (
    sessionId: string,
    windows: readonly { visible: boolean }[] = [],
  ) => worker.push({ kind: "clear", sessionId }, windows);
  return { ...worker, open, attention, clear };
}

test("a clear closes its notification outright, and one leaving another waiting or a window on screen never counts against the day's cap", async () => {
  const { open, attention, clear, shown } = await questionWorker();
  // Twice the cap of closes the browser charges nothing for.
  for (let i = 0; i < COSTLY_REMOVALS_PER_DAY; i++) {
    await attention("s1");
    await attention("s2");
    await clear("s1"); // s2 still waits
    expect(open().map(({ options }) => options.tag)).toEqual(["session:m1:s2"]);
    await clear("s2", [{ visible: true }]); // the app is on screen
    expect(open()).toEqual([]);
    expect(shown.at(-1)).toEqual(
      quieted("Fix s2", SETTLED_BODY, { machineId: "m1", sessionId: "s2" }),
    );
  }
  // Closes that leave none showing with no window on screen: up to the cap
  // they close outright too, with nothing left saying the session settled.
  for (let i = 0; i < COSTLY_REMOVALS_PER_DAY; i++) {
    await attention("s1");
    await clear("s1");
    expect(open()).toEqual([]);
  }
});

test("past the day's cap, a clear for the last notification showing says its session no longer waits, so the browser never shows its own contentless one", async () => {
  const { badge, set } = recordingBadge();
  const { open, attention, clear, registration, removals, clock } =
    await questionWorker({ badge });
  await spendRemovals(removals, clock.now, COSTLY_REMOVALS_PER_DAY);
  await attention("s1");
  // No window of the app on screen: closing it would leave none showing.
  await clear("s1");
  expect(open()).toEqual([
    {
      title: "Fix s1",
      options: {
        body: SETTLED_BODY,
        tag: "session:m1:s1",
        silent: true,
        ...ICONS,
        data: { machineId: "m1", sessionId: "s1", settled: true },
      },
      closed: false,
    },
  ]);

  // The next notification to show takes its place.
  await attention("s2");
  expect(open().map(({ options }) => options.tag)).toEqual(["session:m1:s2"]);
  // With a window of the app on screen, the browser needs none showing.
  await clear("s2", [{ visible: true }]);
  expect(open()).toEqual([]);
  // A session that no longer waits counts for nothing on the badge.
  expect(set).toEqual([1, 0, 1, 0]);

  // The page on screen closes one left from before.
  await attention("s3");
  await clear("s3");
  expect(open()).toHaveLength(1);
  await closeSettled(registration);
  expect(open()).toEqual([]);

  // A settled notification of another session (one left while s4's attention
  // push landed) doesn't spare a clear its replacement: the next attention
  // push or the page may close it before the browser counts what shows.
  await attention("s4");
  await registration.showNotification("Fix s9", {
    body: SETTLED_BODY,
    tag: "session:m1:s9",
    silent: true,
    data: { machineId: "m1", sessionId: "s9", settled: true },
  });
  await clear("s4");
  expect(open().map(({ options }) => options.data)).toEqual([
    { machineId: "m1", sessionId: "s9", settled: true },
    { machineId: "m1", sessionId: "s4", settled: true },
  ]);
});

test("a costly clear counts for a day, then no longer", async () => {
  const { open, attention, clear, removals, clock } = await questionWorker();
  const start = clock.now;
  await spendRemovals(removals, start, COSTLY_REMOVALS_PER_DAY);
  clock.now = start + DAY_MS - 1;
  await attention("s1");
  await clear("s1");
  expect(open().map(({ options }) => options.data)).toEqual([
    { machineId: "m1", sessionId: "s1", settled: true },
  ]);
  clock.now = start + DAY_MS;
  await attention("s2");
  await clear("s2");
  expect(open()).toEqual([]);
});

test("a clear finding its notification gone counts against the cap when nothing else shows and no window is on screen", async () => {
  const { open, attention, clear } = await questionWorker();
  for (let i = 0; i < COSTLY_REMOVALS_PER_DAY; i++)
    await clear("gone", [{ visible: true }]);
  for (let i = 0; i < COSTLY_REMOVALS_PER_DAY - 1; i++) await clear("gone");
  await attention("s1");
  await clear("s1");
  expect(open()).toEqual([]);
  await attention("s2");
  await clear("s2");
  expect(open().map(({ options }) => options.data)).toEqual([
    { machineId: "m1", sessionId: "s2", settled: true },
  ]);
});

/**
 * A count that holds each group of clears (`sizes`, in the order they reach
 * it) until the whole group has, then lets it on at once, as clears landing
 * together would.
 */
function landingTogether(
  removals: CostlyRemovals,
  sizes: readonly number[],
): Pick<CostlyRemovals, "remove"> {
  const groups = sizes.map((size) => ({
    size,
    arrived: Promise.withResolvers<void>(),
  }));
  let calls = 0;
  return {
    async remove(now, removal) {
      const index = calls;
      calls += 1;
      let first = 0;
      for (const group of groups) {
        if (index < first + group.size) {
          if (index === first + group.size - 1) group.arrived.resolve();
          await group.arrived.promise;
          break;
        }
        first += group.size;
      }
      return removals.remove(now, removal);
    },
  };
}

test("clears landing together each count, and never both close on the other's notification", async () => {
  const { open, attention, clear } = await questionWorker({
    ledger: (removals) =>
      landingTogether(removals, [COSTLY_REMOVALS_PER_DAY - 2, 2]),
  });
  await Promise.all(
    Array.from({ length: COSTLY_REMOVALS_PER_DAY - 2 }, () => clear("gone")),
  );
  await attention("s1");
  await attention("s2");
  // One closes while the other still shows, for free; the other is the
  // last, and counts.
  await Promise.all([clear("s1"), clear("s2")]);
  expect(open()).toEqual([]);
  await attention("s3");
  await clear("s3"); // the cap's last
  expect(open()).toEqual([]);
  await attention("s4");
  await clear("s4");
  expect(open().map(({ options }) => options.data)).toEqual([
    { machineId: "m1", sessionId: "s4", settled: true },
  ]);
});

/** Every machine's channel ready (or those `ready` names), recording the frames each is sent. */
function recordingMachines(ready: (machineId: string) => boolean = () => true) {
  const sent: { machineId: string; frame: SealedFrame }[] = [];
  const machines: SeenReceivers = {
    channelReady: ready,
    channelFor: (machineId) => ({
      sendFrame: (frame) => {
        sent.push({ machineId, frame });
      },
    }),
  };
  return { machines, sent };
}

test("dismissing a session's notification that still waits is recorded for the page and told to the open windows; settled, quiet and generic ones are not", async () => {
  const { push, registration, shown, dismissed, removals, clock } =
    await pairedWorker();
  await spendRemovals(removals, clock.now, COSTLY_REMOVALS_PER_DAY);
  const attention = (
    sessionId: string,
    windows: readonly { visible: boolean }[] = [],
  ) =>
    push(
      {
        kind: "attention",
        sessionId,
        reason: "question",
        title: sessionId,
        project: "p",
        detail: "",
      },
      windows,
    );
  await attention("s1"); // a session's notification, still waiting
  await push({ kind: "clear", sessionId: "s1" }); // past the cap: replaced by a settled one
  await attention("s2"); // a session's notification, still waiting
  await attention("s3", [{ visible: true }]); // quiet, with its session's content
  await push({ kind: "clear", sessionId: "s4" }); // quiet, its session named
  await handlePush(
    {
      clients: fakeClients([]),
      registration,
      quietWhileOpen: async () => true,
      notifyKeys: async () => new Map(),
      notifyDetail: async () => "preview",
      forgetDismissed: async () => undefined,
      ...noClears(),
    },
    undefined,
  ); // the generic one

  const { window, seen } = recordingWindow();
  const { clients } = recordingClients([window]);
  // The user swipes each away, in turn; s1's first was replaced by its
  // settled one before it could be.
  expect(shown[1]?.options.data).toEqual({
    machineId: "m1",
    sessionId: "s1",
    settled: true,
  });
  for (const { options } of shown.slice(1))
    await reportDismissed(
      { clients, recordDismissed: (target) => dismissed.record(target) },
      { tag: options.tag, data: options.data },
    );

  expect(seen.messages).toEqual([
    { type: "notice-dismissed", machineId: "m1", sessionId: "s2" },
  ]);
  const { machines, sent } = recordingMachines();
  await dismissed.report(machines);
  expect(sent).toEqual([
    { machineId: "m1", frame: { t: "noticeSeen", sessionId: "s2" } },
  ]);
});

test("a new notice for a session supersedes the dismissal of its last one, so the page never reports the new one seen", async () => {
  const { push, shown, dismissed } = await pairedWorker();
  const attention = (
    sessionId: string,
    windows: readonly { visible: boolean }[] = [],
  ) =>
    push(
      {
        kind: "attention",
        sessionId,
        reason: "idle",
        title: sessionId,
        project: "p",
        detail: "",
      },
      windows,
    );
  await attention("s1");
  await attention("s2");
  const { clients } = recordingClients([]);
  for (const { options } of shown)
    await reportDismissed(
      { clients, recordDismissed: (target) => dismissed.record(target) },
      { tag: options.tag, data: options.data },
    );
  // s1 waits again: shown, or quiet while the app is on screen.
  await attention("s1");
  await attention("s2", [{ visible: true }]);

  const { machines, sent } = recordingMachines();
  await dismissed.report(machines);
  expect(sent).toEqual([]);
});

test("the dismissal record keeps the newest, each session once, and only what the page could not tell yet", async () => {
  const storage = fakeCaches();
  const dismissed = new DismissedNotices(storage.caches);
  const past = DISMISSED_NOTICES_MAX + 8;
  // A "clear all" dismisses every one at once: each lands, and past the
  // bound the oldest go (s0..s7).
  await Promise.all(
    Array.from({ length: past }, (_, i) =>
      dismissed.record({ machineId: "m1", sessionId: `s${i}` }),
    ),
  );
  // Dismissed again, a session moves to the newest end instead of doubling.
  const again = `s${past - DISMISSED_NOTICES_MAX}`;
  await dismissed.record({ machineId: "m1", sessionId: again });
  // One more pushes out the oldest left (s9).
  await dismissed.record({ machineId: "m2", sessionId: "s1" });

  // m2's channel is not ready: its dismissal stays for the next report.
  const early = recordingMachines((machineId) => machineId === "m1");
  await dismissed.report(early.machines);
  const kept = [
    ...Array.from(
      { length: DISMISSED_NOTICES_MAX - 2 },
      (_, i) => `s${past - DISMISSED_NOTICES_MAX + 2 + i}`,
    ),
    again,
  ];
  expect(early.sent.map(({ frame }) => frame)).toEqual(
    kept.map((sessionId) => ({ t: "noticeSeen", sessionId })),
  );

  const later = recordingMachines();
  await dismissed.report(later.machines);
  expect(later.sent).toEqual([
    { machineId: "m2", frame: { t: "noticeSeen", sessionId: "s1" } },
  ]);
});
