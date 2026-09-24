import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PushPreferences } from "../src/core/push-preferences";
import {
  PushEnrolment,
  type PushManagerLike,
  subscribeToPush,
} from "../src/core/push-subscribe";
import {
  RELAY,
  type RelayCall,
  SUB_JSON,
  fakePushManager,
  fakeRelay,
} from "./fixtures/fake-push";

// Register a DOM only for this file (for the push preferences' localStorage)
// so happy-dom's globals never leak into the other suites in the same process.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => localStorage.clear());

/** An enrolment over this browser's saved push preferences and a relay at `routes`. */
function enrolment(
  pushManager: PushManagerLike,
  opts: {
    routes?: Record<string, unknown>;
    permission?: () => Promise<NotificationPermission>;
    started?: () => void;
  } = {},
) {
  const calls: RelayCall[] = [];
  const preferences = new PushPreferences();
  const push = new PushEnrolment({
    baseUrl: "https://rp.test",
    fetch: fakeRelay(opts.routes ?? RELAY, calls),
    pushManager: async () => {
      opts.started?.();
      return pushManager;
    },
    requestPermission: opts.permission ?? (async () => "granted"),
    preferences,
  });
  const registrations = () =>
    calls.filter((call) => call.path === "/push/subscription");
  return { push, preferences, registrations };
}

test("subscribes via the PushManager and posts the subscription, exactly as the browser gives it, with a Bearer token", async () => {
  const calls: RelayCall[] = [];
  let subscribeArgs:
    | { userVisibleOnly: boolean; applicationServerKey: Uint8Array }
    | undefined;
  const { pushManager } = fakePushManager();
  const ok = await subscribeToPush({
    baseUrl: "https://rp.test",
    fetch: fakeRelay(RELAY, calls),
    pushManager: {
      ...pushManager,
      async subscribe(opts) {
        subscribeArgs = opts;
        return pushManager.subscribe(opts);
      },
    },
    token: "sess-token",
  });

  expect(ok).toBe(true);
  // Requested a real byte key, not a string.
  expect(subscribeArgs?.userVisibleOnly).toBe(true);
  expect(subscribeArgs?.applicationServerKey).toBeInstanceOf(Uint8Array);
  expect((subscribeArgs?.applicationServerKey.length ?? 0) > 0).toBe(true);

  const post = calls.find((c) => c.path === "/push/subscription");
  expect(post?.headers.authorization).toBe("Bearer sess-token");
  // The browser's subscription and nothing more: no device tag.
  expect(post?.body).toEqual(SUB_JSON);
});

test("reuses an existing subscription instead of creating a new one", async () => {
  const calls: RelayCall[] = [];
  const { pushManager, seen } = fakePushManager({ subscribed: true });
  await subscribeToPush({
    baseUrl: "https://rp.test",
    fetch: fakeRelay(RELAY, calls),
    pushManager,
    token: "t",
  });
  expect(seen.subscribes).toBe(0);
  expect(calls.some((c) => c.path === "/push/subscription")).toBe(true);
});

test("is a no-op when the browser has no push support", async () => {
  const calls: RelayCall[] = [];
  const ok = await subscribeToPush({
    baseUrl: "https://rp.test",
    fetch: fakeRelay({}, calls),
    pushManager: undefined,
    token: "t",
  });
  expect(ok).toBe(false);
  expect(calls).toHaveLength(0);
});

test("signing in registers this device while push is on", async () => {
  const { pushManager } = fakePushManager();
  const { push, registrations } = enrolment(pushManager);
  await push.signedIn("t");
  expect(registrations().map((call) => call.body)).toEqual([SUB_JSON]);
  expect(push.state.status).toBe("on");
});

test("signing in while push is off registers nothing and drops a leftover subscription", async () => {
  new PushPreferences().setEnabled(false);
  const fake = fakePushManager({ subscribed: true });
  const { push, registrations } = enrolment(fake.pushManager);
  await push.signedIn("t");
  expect(registrations()).toEqual([]);
  expect(fake.subscribed()).toBe(false);
  expect(push.state.status).toBe("off");
});

test("turning push off saves at once, then unsubscribes this device", async () => {
  const fake = fakePushManager();
  const { push } = enrolment(fake.pushManager);
  await push.signedIn("t");
  expect(fake.subscribed()).toBe(true);

  const done = push.setEnabled(false);
  // Saved before the unsubscribe finishes, so a reload in between keeps it off.
  expect(new PushPreferences().enabled).toBe(false);
  await done;
  expect(fake.seen.unsubscribes).toBe(1);
  expect(fake.subscribed()).toBe(false);
  expect(push.state.status).toBe("off");
});

test("turning push on asks for permission within the tap, and saves it only once this device is registered", async () => {
  new PushPreferences().setEnabled(false);
  let asked = false;
  const { pushManager } = fakePushManager();
  const { push, preferences, registrations } = enrolment(pushManager, {
    permission: async () => {
      asked = true;
      return "granted";
    },
  });
  await push.signedIn("t");

  const done = push.setEnabled(true);
  expect(asked).toBe(true);
  expect(preferences.enabled).toBe(false);
  await done;
  expect(registrations()).toHaveLength(1);
  expect(new PushPreferences().enabled).toBe(true);
  expect(push.state.status).toBe("on");
});

test("a failed turn-on leaves push off and says why", async () => {
  new PushPreferences().setEnabled(false);
  const { pushManager } = fakePushManager();
  // This relay has no push configured.
  const { push, registrations } = enrolment(pushManager, { routes: {} });
  await push.signedIn("t");
  await push.setEnabled(true);
  expect(registrations()).toEqual([]);
  expect(new PushPreferences().enabled).toBe(false);
  expect(push.state).toEqual({
    status: "off",
    problem: "the relay doesn't send push notifications",
  });
});

test("notifications the browser blocks show as blocked, and nothing subscribes", async () => {
  const fake = fakePushManager({ permission: "denied" });
  const { push, registrations } = enrolment(fake.pushManager, {
    permission: async () => "denied",
  });
  await push.signedIn("t");
  expect(push.state.status).toBe("blocked");

  push.preferences.setEnabled(false);
  await push.setEnabled(true);
  expect(push.state.status).toBe("blocked");
  expect(push.preferences.enabled).toBe(false);
  expect(fake.seen.subscribes).toBe(0);
  expect(registrations()).toEqual([]);
});

test("turning push off while a turn-on still waits for permission wins", async () => {
  new PushPreferences().setEnabled(false);
  const permission = Promise.withResolvers<NotificationPermission>();
  const started = Promise.withResolvers<void>();
  const hook: { turnOnStarted?: () => void } = {};
  const fake = fakePushManager();
  const { push, registrations } = enrolment(fake.pushManager, {
    permission: () => permission.promise,
    started: () => hook.turnOnStarted?.(),
  });
  await push.signedIn("t");
  hook.turnOnStarted = () => started.resolve();
  const turningOn = push.setEnabled(true);
  // The turn-on is under way, waiting on the permission prompt.
  await started.promise;
  const turningOff = push.setEnabled(false);
  permission.resolve("granted");
  await Promise.all([turningOn, turningOff]);

  // The turn-on still registered, but it must not save "on" over the newer off.
  expect(registrations()).toHaveLength(1);
  expect(new PushPreferences().enabled).toBe(false);
  expect(push.state.status).toBe("off");
  expect(fake.subscribed()).toBe(false);
});
