import { expect, test } from "bun:test";
import {
  clientSessionKeys,
  newIdentity,
  notifyKey,
  serverSessionKeys,
} from "@omp-remote/crypto";
import { type NotifyNotice, sealNotice } from "@omp-remote/protocol";
import {
  PREFS_CACHE,
  readNotifyKeys,
  readQuietWhileOpen,
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
  type OpenSessionMessage,
  QUIET_TAG,
  type WindowClientLike,
  handlePush,
  openFromNotification,
  openSessionTarget,
  openSessionUrl,
} from "../src/core/sw-push";
import { fakeCaches } from "./fixtures/fake-push";

interface Shown {
  title: string;
  options: NotificationSpec;
  closed: boolean;
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
    async getNotifications({ tag }) {
      return shown
        .filter(({ closed, options }) => !closed && options.tag === tag)
        .map((notification) => ({
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
  const seen: { focused: number; messages: OpenSessionMessage[] } = {
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
/** A push that shows nothing: shown silently under the quiet tag, and closed. */
const QUIETED = {
  title: ATTENTION_TITLE,
  options: { body: ATTENTION_BODY, tag: QUIET_TAG, silent: true },
  closed: true,
};

/**
 * Machine m1 paired with this phone as the agent and the page each hold it:
 * the agent seals notices with `notifyKey(tx)`; the page saved
 * `notifyKey(rx)` for the worker, with the name it shows ("Laptop").
 */
async function pairedWorker(opts: { quietWhileOpen?: boolean } = {}) {
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
  const { registration, shown } = fakeRegistration();
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
        },
        JSON.stringify(envelope),
      ),
    );
  return { push, registration, shown, agentKey, storage };
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

test("with quiet on, an attention notice while a window is on screen is shown silently and closed at once", async () => {
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
  expect(shown).toEqual([QUIETED]);
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
      },
      undefined,
    );

    await push({ kind: "clear", sessionId: "s1" }, windows);
    const open = shown.filter(({ closed }) => !closed);
    expect(open.map(({ options }) => options.tag)).toEqual([
      "session:m1:s2",
      ATTENTION_TAG,
    ]);
    // Closing one is not showing one: every push shows its own, even with a
    // window of the app on screen, or WebKit drops the subscription.
    expect(shown.at(-1)).toEqual(QUIETED);
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
  expect(shown).toEqual([GENERIC, QUIETED]);
});

test("with quiet off, a push while the app is on screen raises its notification", async () => {
  const { registration, shown } = fakeRegistration();
  await handlePush(
    {
      clients: fakeClients([{ visible: true }]),
      registration,
      quietWhileOpen: async () => false,
      notifyKeys: async () => new Map(),
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
      },
      undefined,
    );
    expect(shown).toEqual([QUIETED]);
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

test("a tap on a session's notification opens that session in the open window", async () => {
  const { window, seen } = recordingWindow();
  const { clients, opened } = recordingClients([window]);
  await openFromNotification(clients, { machineId: "m1", sessionId: "s1" });
  expect(seen).toEqual({
    focused: 1,
    messages: [{ type: "open-session", machineId: "m1", sessionId: "s1" }],
  });
  expect(opened).toEqual([]);
});

test("a tap with no window open starts a new one on the session", async () => {
  const { clients, opened } = recordingClients([]);
  await openFromNotification(clients, { machineId: "m1", sessionId: "s1" });
  expect(opened).toEqual(["/?open=m1:s1"]);
});

test("a tap on the generic notification just brings the app forward", async () => {
  const { window, seen } = recordingWindow();
  await openFromNotification(recordingClients([window]).clients, null);
  expect(seen).toEqual({ focused: 1, messages: [] });

  const none = recordingClients([]);
  await openFromNotification(none.clients, undefined);
  expect(none.opened).toEqual(["/"]);
});

test("the page reads a tapped session from its address only for a machine paired here", () => {
  const address = (machineId: string, sessionId: string) =>
    openSessionUrl({ machineId, sessionId }).slice(1);
  expect(openSessionTarget(address("m1", "s1"), ["m0", "m1"])).toEqual({
    machineId: "m1",
    sessionId: "s1",
  });
  // A machine id with a colon of its own still splits where it ends.
  expect(openSessionTarget(address("lab:2", "s:1"), ["lab", "lab:2"])).toEqual({
    machineId: "lab:2",
    sessionId: "s:1",
  });
  expect(openSessionTarget(address("m9", "s1"), ["m1"])).toBeUndefined();
  expect(openSessionTarget("", ["m1"])).toBeUndefined();
});
