import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { installSessionHistory } from "../src/core/history-nav";
import { PushPreferences } from "../src/core/push-preferences";
import { PushEnrolment, type PushState } from "../src/core/push-subscribe";
import { readQuietWhileOpen } from "../src/core/sw-caches";
import { type ControlHandlers, renderTree } from "../src/ui/render";
import { FakeHistory } from "./fixtures/fake-history";
import {
  RELAY,
  type RelayCall,
  fakeCaches,
  fakePushManager,
  fakeRelay,
} from "./fixtures/fake-push";

// Register a DOM only for this file so happy-dom's globals never leak into the
// crypto/WebSocket-based suites in the same process.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => document.body.replaceChildren());
beforeEach(() => localStorage.clear());

/**
 * Mount the workspace with push as main.ts wires it: an enrolment over this
 * browser's push preferences and a relay at `routes`, a redraw on every push
 * state change, and the Cache Storage the service worker reads the quiet
 * choice from. Signed in; Settings open.
 */
async function openNotifications(
  opts: {
    routes?: Record<string, unknown>;
    permission?: PermissionState;
  } = {},
) {
  const history = new FakeHistory();
  const nav = installSessionHistory({
    history,
    select: () => {},
    onPopState: (handler) => history.onPop(handler),
  });
  const fake = fakePushManager({ permission: opts.permission });
  const calls: RelayCall[] = [];
  const worker = fakeCaches();
  const booted = worker.written();
  const preferences = new PushPreferences(worker.caches);
  await booted;
  const push = new PushEnrolment({
    baseUrl: "https://rp.test",
    fetch: fakeRelay(opts.routes ?? RELAY, calls),
    pushManager: async () => fake.pushManager,
    requestPermission: fake.prompt,
    preferences,
  });
  const handlers: ControlHandlers = {
    onSelect: (id) => nav.open(id),
    onBack: () => nav.back(),
    onOverlay: (close) => nav.overlay(close),
    onPrompt: async () => true,
    onInterrupt: async () => true,
    onServiceTier: async () => true,
    onSetModel: async () => true,
    onSetThinkingLevel: async () => true,
    onCompact: async () => true,
    onCloseSession: async () => true,
    onUpload: async () => "resource",
    onSpawn: async () => true,
    onCancelSpawn: () => {},
    onInteractionReply: async () => true,
    onRenameMachine: () => true,
    push,
  };
  const root = document.createElement("div");
  document.body.append(root);
  const draw = () =>
    renderTree(
      root,
      [{ machineId: "m1", label: "m1", projects: [] }],
      handlers,
    );
  push.subscribe(draw);
  draw();
  await push.signedIn("token");
  [...root.querySelectorAll("button")]
    .find((node) => node.textContent === "Settings")
    ?.click();
  const settings = root.querySelector<HTMLDialogElement>("dialog[open]");
  if (!settings) throw new Error("Settings did not open");
  const section = [...settings.querySelectorAll("section")].find(
    (node) => node.querySelector("h3")?.textContent === "Notifications",
  );
  if (!section) throw new Error("no Notifications section");

  /** A switch as assistive technology finds it: by its role and label. */
  const toggle = (label: string): HTMLInputElement => {
    const match = [
      ...section.querySelectorAll<HTMLInputElement>('input[role="switch"]'),
    ].find((node) => node.labels?.[0]?.textContent === label);
    if (!match) throw new Error(`no "${label}" switch`);
    return match;
  };
  const turn = (label: string, on: boolean): void => {
    const input = toggle(label);
    if (input.checked === on) throw new Error(`"${label}" is already ${on}`);
    input.click();
  };
  /** Resolves at the next push state change that `done` accepts. */
  const settles = (done: (state: PushState) => boolean): Promise<void> => {
    const settled = Promise.withResolvers<void>();
    const stop = push.subscribe(() => {
      if (!done(push.state)) return;
      stop();
      settled.resolve();
    });
    return settled.promise;
  };
  const retry = (): HTMLButtonElement | undefined =>
    [...section.querySelectorAll("button")].find(
      (node) =>
        node.textContent === "Try again" && node.closest("[hidden]") === null,
    );
  return {
    settings,
    section,
    toggle,
    turn,
    settles,
    retry,
    fake,
    push,
    worker,
    registrations: () =>
      calls.filter((call) => call.path === "/push/subscription"),
  };
}

test("Notifications follows Chat; the quiet choice there is saved and reaches the service worker", async () => {
  const { settings, turn, worker } = await openNotifications();
  const titles = [...settings.querySelectorAll("h3")]
    .filter((node) => node.closest("[hidden]") === null)
    .map((node) => node.textContent);
  expect(titles.indexOf("Notifications")).toBe(titles.indexOf("Chat") + 1);
  expect(titles.indexOf("Notifications")).toBeLessThan(titles.indexOf("About"));

  const copied = worker.written();
  turn("Quiet while the app is open", false);
  await copied;
  expect(new PushPreferences().quietWhileOpen).toBe(false);
  expect(await readQuietWhileOpen(worker.caches)).toBe(false);
});

test("turning push off unsubscribes and sets the quiet choice aside; turning it on registers again", async () => {
  const { toggle, turn, settles, fake, registrations } =
    await openNotifications();
  expect(toggle("Quiet while the app is open").disabled).toBe(false);

  const off = settles((state) => state.status === "off");
  turn("Push notifications", false);
  await off;
  expect(fake.subscribed()).toBe(false);
  expect(new PushPreferences().enabled).toBe(false);
  expect(toggle("Quiet while the app is open").disabled).toBe(true);

  const on = settles((state) => state.status === "on");
  turn("Push notifications", true);
  await on;
  expect(fake.subscribed()).toBe(true);
  expect(registrations()).toHaveLength(2);
  expect(new PushPreferences().enabled).toBe(true);
  expect(toggle("Quiet while the app is open").disabled).toBe(false);
});

test("a failed turn-on says why and shows push off", async () => {
  new PushPreferences().setEnabled(false);
  // This relay has no push configured.
  const { section, toggle, turn, settles } = await openNotifications({
    routes: {},
  });

  const failed = settles((state) => state.status === "off");
  turn("Push notifications", true);
  await failed;
  expect(toggle("Push notifications").checked).toBe(false);
  expect(new PushPreferences().enabled).toBe(false);
  expect(section.textContent).toContain(
    "the relay doesn't send push notifications",
  );
});

test("blocked notifications offer Try again, which registers once the browser allows them", async () => {
  const { toggle, settles, retry, fake, registrations } =
    await openNotifications({ permission: "denied" });
  expect(registrations()).toEqual([]);
  expect(toggle("Push notifications").checked).toBe(true);
  const offered = retry();
  if (!offered) throw new Error("blocked push offers no Try again");

  fake.allow();
  const on = settles((state) => state.status === "on");
  offered.click();
  await on;
  expect(registrations()).toHaveLength(1);
  expect(retry()).toBeUndefined();
});
