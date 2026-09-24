import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type AuthDeps,
  type Passkey,
  listPasskeys,
  registerPasskey,
  revokeMachine,
  revokePasskey,
  setPasswordSignIn,
  signOutEverywhere,
} from "../src/core/auth";
import { installSessionHistory } from "../src/core/history-nav";
import { MachineLabels } from "../src/core/machine-labels";
import { MachinePresence } from "../src/core/machine-presence";
import type { MachineNode } from "../src/core/session-tree";
import { AppStore } from "../src/core/store";
import {
  type AccountControls,
  type ControlHandlers,
  renderLoginView,
  renderTree,
} from "../src/ui/render";
import { FakeHistory, pressBack } from "./fixtures/fake-history";

// Register a DOM only for this file so happy-dom's globals never leak into the
// crypto/WebSocket-based suites in the same process.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => document.body.replaceChildren());
// Launch defaults persist in this device's storage.
beforeEach(() => localStorage.clear());

function machine(machineId: string): MachineNode {
  return { machineId, label: machineId, projects: [] };
}

/**
 * Mount the workspace the way main.ts does: selection and overlays go through
 * the real session history, here over a fake browser history. Handlers the
 * test doesn't pass stay undefined, as in local dev mode.
 */
function workspace(
  tree: () => MachineNode[],
  overrides: Partial<ControlHandlers> = {},
) {
  const history = new FakeHistory();
  const nav = installSessionHistory({
    history,
    select: () => {},
    onPopState: (handler) => history.onPop(handler),
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
    ...overrides,
  };
  const root = document.createElement("div");
  document.body.append(root);
  const draw = () => renderTree(root, tree(), handlers);
  draw();
  return { root, history, draw };
}

const visible = (node: Element): boolean => node.closest("[hidden]") === null;

/** Visible buttons by accessible name, as a user finds them. */
function buttonNames(scope: ParentNode): string[] {
  return [...scope.querySelectorAll("button")]
    .filter(visible)
    .map((node) => node.getAttribute("aria-label") ?? node.textContent ?? "");
}

function buttonNamed(scope: ParentNode, name: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find(
    (node) =>
      visible(node) &&
      (node.getAttribute("aria-label") ?? node.textContent) === name,
  );
  if (!match) throw new Error(`no visible button named "${name}"`);
  return match;
}

/** The dialog whose accessible name is `title`. */
function dialog(root: HTMLElement, title: string): HTMLDialogElement {
  const match = [...root.querySelectorAll("dialog")].find(
    (node) =>
      document.getElementById(node.getAttribute("aria-labelledby") ?? "")
        ?.textContent === title,
  );
  if (!match) throw new Error(`no dialog titled "${title}"`);
  return match;
}

/** Machine names as the rail's navigation shows them. */
function railMachines(root: HTMLElement): string[] {
  return [...root.querySelectorAll("nav h2")].map(
    (node) => node.textContent ?? "",
  );
}

test("Sign out sits in Settings > Account, and signing out there leaves history balanced", () => {
  let signedOut = 0;
  const { root, history } = workspace(() => [machine("m1")], {
    onSignOut: () => {
      signedOut += 1;
      // As main.ts does: the login screen replaces the workspace.
      renderLoginView(
        root,
        {
          methods: { password: true, passkey: false },
          passkeyAvailable: false,
          onPasswordLogin: async () => ({
            ok: false,
            reason: "wrong-password",
          }),
          onPasskeyLogin: async () => {},
        },
        document.createElement("p"),
      );
    },
  });
  buttonNamed(root, "Settings").click();
  expect(history.position()).toBe(1);
  buttonNamed(dialog(root, "Settings"), "Sign out").click();
  history.flush();
  expect(signedOut).toBe(1);
  expect(history.position()).toBe(0);
});

test("local dev mode (no sign-out or forget path) hides Account and Forget but keeps Rename", () => {
  const { root } = workspace(() => [machine("m1")]);
  buttonNamed(root, "Settings").click();
  const names = buttonNames(dialog(root, "Settings"));
  expect(names).toContain("Rename m1");
  expect(names).not.toContain("Sign out");
  expect(names).not.toContain("Forget m1 on this device");
});

test("Forget asks first: cancelling keeps the machine, confirming forgets only that one", () => {
  const forgotten: string[] = [];
  const { root } = workspace(() => [machine("m1"), machine("m2")], {
    onForgetMachine: async (machineId) => {
      forgotten.push(machineId);
      return true;
    },
  });
  buttonNamed(root, "Settings").click();
  const settings = dialog(root, "Settings");

  buttonNamed(settings, "Forget m1 on this device").click();
  // The confirm step takes keyboard focus, starting on the safe choice.
  const cancel = buttonNamed(settings, "Cancel");
  expect(document.activeElement).toBe(cancel);
  cancel.click();
  expect(forgotten).toEqual([]);

  buttonNamed(settings, "Forget m1 on this device").click();
  buttonNamed(settings, "Forget machine").click();
  expect(forgotten).toEqual(["m1"]);
});

test("a paired machine that is offline is still listed and can be forgotten", () => {
  const forgotten: string[] = [];
  const { root } = workspace(() => [machine("m1")], {
    onForgetMachine: async (machineId) => {
      forgotten.push(machineId);
      return true;
    },
    pairedMachines: () =>
      new Map([
        ["m1", "m1"],
        ["retired", "Old laptop"],
      ]),
  });
  buttonNamed(root, "Settings").click();
  const settings = dialog(root, "Settings");
  const names = buttonNames(settings);
  // Online machines are not listed twice.
  expect(names.filter((name) => name === "Rename m1")).toHaveLength(1);
  expect(names).toContain("Rename Old laptop");

  buttonNamed(settings, "Forget Old laptop on this device").click();
  buttonNamed(settings, "Forget machine").click();
  expect(forgotten).toEqual(["retired"]);
});

test("a forgotten machine is no longer the default machine when it is paired again", async () => {
  let machines = [machine("m1"), machine("m2")];
  const forgetting = Promise.withResolvers<boolean>();
  const { root, draw } = workspace(() => machines, {
    onForgetMachine: () => forgetting.promise,
  });
  buttonNamed(root, "Settings").click();
  const settings = dialog(root, "Settings");
  const defaultMachine = [...settings.querySelectorAll("select")].find(
    (node) => node.labels?.[0]?.textContent === "Default machine",
  );
  if (!defaultMachine) throw new Error("no default machine select");
  defaultMachine.value = "m1";
  defaultMachine.dispatchEvent(new Event("change", { bubbles: true }));

  buttonNamed(settings, "Forget m1 on this device").click();
  buttonNamed(settings, "Forget machine").click();
  machines = [machine("m2")];
  draw();
  forgetting.resolve(true);
  await forgetting.promise;

  machines = [machine("m1"), machine("m2")];
  draw();
  expect(defaultMachine.value).toBe("");
});

test("a name saved in Settings shows in the rail; saving it empty restores the machine ID", () => {
  const stored = new Map<string, string>();
  const labels = new MachineLabels({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => {
      stored.set(key, value);
    },
  });
  const store = new AppStore();
  store.setMachineList(["m1"]);
  const { root, draw } = workspace(() => store.tree(), {
    onRenameMachine: (machineId, label) => {
      const saved = labels.rename(machineId, label);
      store.setMachineLabels(labels.names);
      return saved;
    },
  });
  store.subscribe(draw);
  buttonNamed(root, "Settings").click();
  const settings = dialog(root, "Settings");

  const rename = (button: string, name: string): void => {
    buttonNamed(settings, button).click();
    const field = document.activeElement;
    if (!(field instanceof HTMLInputElement))
      throw new Error("Rename did not focus the name field");
    field.value = name;
    field.form?.requestSubmit();
  };
  rename("Rename m1", "Desk");
  expect(railMachines(root)).toEqual(["Desk"]);
  rename("Rename Desk", "");
  expect(railMachines(root)).toEqual(["m1"]);
});

test("About opens over Settings; back, Close and Back to settings each return to Settings with history balanced", () => {
  const { root, history } = workspace(() => [machine("m1")]);
  buttonNamed(root, "Settings").click();
  const settings = dialog(root, "Settings");
  const about = dialog(root, "About");
  expect(history.position()).toBe(1);

  buttonNamed(settings, "How your data is protected").click();
  expect([settings.open, about.open]).toEqual([true, true]);
  expect(history.position()).toBe(2);
  pressBack(history);
  expect([settings.open, about.open]).toEqual([true, false]);
  expect(history.position()).toBe(1);

  for (const leave of ["Close about", "Back to settings"]) {
    buttonNamed(settings, "How your data is protected").click();
    buttonNamed(about, leave).click();
    history.flush();
    expect([settings.open, about.open]).toEqual([true, false]);
    expect(history.position()).toBe(1);
  }

  buttonNamed(settings, "Close settings").click();
  history.flush();
  expect(settings.open).toBe(false);
  expect(history.position()).toBe(0);
});

test("Machines shows each machine online, or when this device last saw it, and that record survives a reload", () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  };
  const seenAt = Date.now() - 5 * 60_000;
  const store = new AppStore(
    () => seenAt,
    undefined,
    undefined,
    new MachinePresence(storage),
  );
  store.setMachineList(["m1", "m2"]);
  // m1 leaves; m2 stays online.
  store.setMachineList(["m2"]);
  const reloaded = new MachinePresence(storage);
  expect(reloaded.lastSeen("m1")).toBe(seenAt);

  const { root } = workspace(() => store.tree(), {
    pairedMachines: () =>
      new Map([
        ["m1", "m1"],
        ["m2", "m2"],
        ["m3", "m3"],
      ]),
    machineLastSeen: (machineId) => reloaded.lastSeen(machineId),
  });
  buttonNamed(root, "Settings").click();
  const settings = dialog(root, "Settings");
  const status = (name: string): string => {
    const row = [...settings.querySelectorAll(".settings-machine")].find(
      (node) =>
        node.querySelector(".settings-machine-name")?.textContent === name,
    );
    return row?.querySelector(".meta")?.textContent ?? "";
  };
  expect(status("m1")).toBe("Last seen 5 minutes ago");
  expect(status("m2")).toBe("Online · 0 sessions");
  expect(status("m3")).toBe("Not seen online on this device yet");
});

const PASSKEYS = "/auth/account/passkeys";
const CHALLENGE = "/auth/account/challenge";
const REVOKE = "/auth/account/passkeys/revoke";
const EVERYWHERE = "/auth/account/sign-out-everywhere";
/** The passkey this device signed in with. */
const DESK: Passkey = {
  id: "desk0001",
  createdAt: Date.UTC(2026, 8, 7, 12),
  lastUsedAt: Date.now() - 5 * 60_000,
  current: true,
};
/** Another device's passkey, registered before the relay kept dates. */
const PHONE: Passkey = {
  id: "phone002",
  createdAt: null,
  lastUsedAt: null,
  current: false,
};

/**
 * This device's account over the real passkey API client, against a relay
 * double answering each route from `answers` (404 when absent; status 200
 * unless given). Every relay call and passkey prompt lands in `log`, in order.
 */
function relayAccount(
  answers: Record<string, { status?: number; body: unknown }>,
  log: string[] = [],
): AccountControls {
  const deps: AuthDeps = {
    baseUrl: "https://relay.test",
    fetch: (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      log.push(path);
      const answer = answers[path];
      return new Response(
        JSON.stringify(answer?.body ?? { error: "not found" }),
        {
          status: answer === undefined ? 404 : (answer.status ?? 200),
          headers: { "content-type": "application/json" },
        },
      );
    }) as AuthDeps["fetch"],
    startRegistration: (async () => {
      throw new Error("unused");
    }) as unknown as AuthDeps["startRegistration"],
    startAuthentication: (async () => {
      log.push("passkey prompt");
      return { id: "cred", rawId: "cred", response: {}, type: "public-key" };
    }) as unknown as AuthDeps["startAuthentication"],
  };
  return {
    method: "passkey",
    passkeyAvailable: true,
    // Canned, so the log holds only the passkey requests these tests follow.
    methods: async () => ({ password: true, passkey: true }),
    passkeys: () => listPasskeys(deps, "sess.tok"),
    revokePasskey: (id, check) => revokePasskey(deps, "sess.tok", id, check),
    addPasskey: (check) => registerPasskey(deps, "sess.tok", check),
    machines: async () => [],
    revokeMachine: (id, check) => revokeMachine(deps, "sess.tok", id, check),
    setPasswordSignIn: (enabled, check) =>
      setPasswordSignIn(deps, "sess.tok", enabled, check),
    signOutEverywhere: (check) => signOutEverywhere(deps, "sess.tok", check),
  };
}

const stepUp = { body: { flowId: "f", options: { challenge: "c" } } };

/** Resolves once `holds()`, checked again after every change under `scope`. */
function until(scope: Node, holds: () => boolean): Promise<void> {
  const reached = Promise.withResolvers<void>();
  const observer = new MutationObserver(() => {
    if (!holds()) return;
    observer.disconnect();
    reached.resolve();
  });
  observer.observe(scope, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  if (holds()) {
    observer.disconnect();
    reached.resolve();
  }
  return reached.promise;
}

/** The rows of the list named "Passkeys", in order. */
function passkeyRows(settings: HTMLElement): Element[] {
  const list = [...settings.querySelectorAll("ul")].find(
    (node) =>
      document.getElementById(node.getAttribute("aria-labelledby") ?? "")
        ?.textContent === "Passkeys",
  );
  return list ? [...list.children] : [];
}

/** What a row shows: its text without the parts that are hidden. */
function shownText(node: Element): string {
  const copy = node.cloneNode(true);
  if (!(copy instanceof Element)) return "";
  for (const hidden of copy.querySelectorAll("[hidden]")) hidden.remove();
  return copy.textContent ?? "";
}

/** Open Settings and wait for its passkey list to show `count` rows. */
async function openAccount(
  root: HTMLElement,
  count: number,
): Promise<HTMLDialogElement> {
  buttonNamed(root, "Settings").click();
  const settings = dialog(root, "Settings");
  await until(settings, () => passkeyRows(settings).length === count);
  return settings;
}

test("Account lists each passkey with its dates, unknown where the relay has none, and marks this device's", async () => {
  const { root } = workspace(() => [machine("m1")], {
    onSignOut: () => {},
    account: relayAccount({
      [PASSKEYS]: { body: { passkeys: [PHONE, DESK] } },
    }),
  });
  const settings = await openAccount(root, 2);
  const [phone, desk] = passkeyRows(settings).map(shownText);
  expect(phone).toContain("Created unknown · Last used unknown");
  expect(phone).not.toContain("This device");
  expect(desk).toContain("This device");
  expect(desk).toContain("Last used 5 minutes ago");
});

test("revoking this device's passkey asks first, then checks a passkey, then signs this device out", async () => {
  const log: string[] = [];
  const signedOut = Promise.withResolvers<void>();
  const { root } = workspace(() => [machine("m1")], {
    onSignOut: () => signedOut.resolve(),
    account: relayAccount(
      {
        [PASSKEYS]: { body: { passkeys: [PHONE, DESK] } },
        [CHALLENGE]: stepUp,
        [REVOKE]: { body: { revoked: true, signedOut: true } },
      },
      log,
    ),
  });
  const settings = await openAccount(root, 2);

  buttonNamed(
    settings,
    "Revoke passkey desk0001, this device's passkey",
  ).click();
  // The confirm step takes focus on the safe choice; nothing is sent yet.
  expect(document.activeElement).toBe(buttonNamed(settings, "Cancel"));
  expect(log).toEqual([PASSKEYS]);

  buttonNamed(settings, "Revoke passkey").click();
  await signedOut.promise;
  expect(log).toEqual([PASSKEYS, CHALLENGE, "passkey prompt", REVOKE]);
});

test("revoking another passkey keeps this device signed in; with one left, Revoke is off and says why", async () => {
  let signOuts = 0;
  const { root } = workspace(() => [machine("m1")], {
    onSignOut: () => {
      signOuts += 1;
    },
    account: relayAccount({
      [PASSKEYS]: { body: { passkeys: [PHONE, DESK] } },
      [CHALLENGE]: stepUp,
      [REVOKE]: { body: { revoked: true, signedOut: false } },
    }),
  });
  const settings = await openAccount(root, 2);

  buttonNamed(settings, "Revoke passkey phone002").click();
  buttonNamed(settings, "Revoke passkey").click();
  await until(settings, () => passkeyRows(settings).length === 1);
  expect(signOuts).toBe(0);
  const revoke = buttonNamed(
    settings,
    "Revoke passkey desk0001, this device's passkey",
  );
  expect(revoke.disabled).toBe(true);
  // The reason is on screen and read out with the button.
  const reason = document.getElementById(
    revoke.getAttribute("aria-describedby") ?? "",
  );
  expect(reason?.textContent).toBe("You can't remove your only passkey.");
  expect(reason?.closest("[hidden]")).toBeNull();
});

test("a failed passkey check says so, signs nothing out, and keeps the step open to try again", async () => {
  let signOuts = 0;
  const { root } = workspace(() => [machine("m1")], {
    onSignOut: () => {
      signOuts += 1;
    },
    account: relayAccount({
      [PASSKEYS]: { body: { passkeys: [PHONE, DESK] } },
      [CHALLENGE]: stepUp,
      [REVOKE]: { status: 403, body: { error: "passkey check failed" } },
    }),
  });
  const settings = await openAccount(root, 2);

  buttonNamed(settings, "Revoke passkey phone002").click();
  buttonNamed(settings, "Revoke passkey").click();
  await until(
    settings,
    () => settings.textContent?.includes("Passkey check failed") ?? false,
  );
  expect(signOuts).toBe(0);
  expect(passkeyRows(settings)).toHaveLength(2);
  expect(document.activeElement).toBe(buttonNamed(settings, "Revoke passkey"));
});

test("Sign out everywhere says it includes this device, asks first, then checks a passkey and signs this device out", async () => {
  const log: string[] = [];
  const signedOut = Promise.withResolvers<void>();
  const { root } = workspace(() => [machine("m1")], {
    onSignOut: () => signedOut.resolve(),
    account: relayAccount(
      {
        [PASSKEYS]: { body: { passkeys: [DESK] } },
        [CHALLENGE]: stepUp,
        [EVERYWHERE]: { body: { signedOut: true } },
      },
      log,
    ),
  });
  const settings = await openAccount(root, 1);

  buttonNamed(settings, "Sign out everywhere, including this device").click();
  expect(document.activeElement).toBe(buttonNamed(settings, "Cancel"));
  expect(log).toEqual([PASSKEYS]);

  buttonNamed(settings, "Sign out everywhere").click();
  await signedOut.promise;
  expect(log).toEqual([PASSKEYS, CHALLENGE, "passkey prompt", EVERYWHERE]);
});

test("a sign-in the relay already ended (401) signs this device out instead of offering a retry", async () => {
  const signedOut = Promise.withResolvers<string | undefined>();
  const { root } = workspace(() => [machine("m1")], {
    onSignOut: (notice) => signedOut.resolve(notice),
    account: relayAccount({
      [PASSKEYS]: { body: { passkeys: [PHONE, DESK] } },
      [CHALLENGE]: stepUp,
      [REVOKE]: { status: 401, body: { error: "unauthorized" } },
    }),
  });
  const settings = await openAccount(root, 2);

  buttonNamed(settings, "Revoke passkey phone002").click();
  buttonNamed(settings, "Revoke passkey").click();
  expect(await signedOut.promise).toContain("has ended");
});

test("Settings > Machines shows each machine's away time, and a new one is saved for that machine", () => {
  const chosen = new Map([["m1", 300]]);
  const saved: [string, number][] = [];
  const { root } = workspace(() => [machine("m1"), machine("m2")], {
    notifyAway: {
      awaySec: (machineId) => chosen.get(machineId) ?? 120,
      setAwaySec: (machineId, awaySec) => {
        saved.push([machineId, awaySec]);
        chosen.set(machineId, awaySec);
        return true;
      },
    },
  });
  buttonNamed(root, "Settings").click();
  const settings = dialog(root, "Settings");
  const picker = (name: string): HTMLSelectElement => {
    const select = settings.querySelector<HTMLSelectElement>(
      `select[aria-label="Notify when away from ${name} for"]`,
    );
    if (!select || !visible(select)) throw new Error(`no picker for ${name}`);
    return select;
  };
  expect(picker("m1").value).toBe("300");
  expect(picker("m2").value).toBe("120");

  picker("m2").value = "0";
  picker("m2").dispatchEvent(new Event("change"));
  expect(saved).toEqual([["m2", 0]]);
  expect(settings.textContent).toContain(
    "m2 pushes whenever a session needs you.",
  );
});

test("without push (local dev), Settings > Machines offers no away time", () => {
  const { root } = workspace(() => [machine("m1")]);
  buttonNamed(root, "Settings").click();
  const select = dialog(root, "Settings").querySelector(
    'select[aria-label="Notify when away from m1 for"]',
  );
  expect(select === null || !visible(select)).toBe(true);
});

/** Run `body` with the page's secure-context flag set to `secure`. */
async function withSecureContext(
  secure: boolean,
  body: () => Promise<void>,
): Promise<void> {
  const before = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
  Object.defineProperty(globalThis, "isSecureContext", {
    value: secure,
    configurable: true,
  });
  try {
    await body();
  } finally {
    if (before) Object.defineProperty(globalThis, "isSecureContext", before);
    else Reflect.deleteProperty(globalThis, "isSecureContext");
  }
}

const HTTP_NOTICE = "Served over HTTP: push, install and passkeys are off.";

test("Settings on plain HTTP says once what is off and where HTTPS is explained; on HTTPS it says nothing", async () => {
  for (const secure of [false, true])
    await withSecureContext(secure, async () => {
      const { root } = workspace(() => [machine("m1")], {
        onSignOut: () => {},
        account: relayAccount({ [PASSKEYS]: { body: { passkeys: [DESK] } } }),
      });
      const settings = await openAccount(root, 1);
      const notices = [...settings.querySelectorAll("p")].filter(
        (node) => visible(node) && node.textContent === HTTP_NOTICE,
      );
      expect(notices).toHaveLength(secure ? 0 : 1);
      expect(shownText(settings).includes("docs/SELF-HOSTING.md")).toBe(
        !secure,
      );
      root.remove();
    });
});

test("the server's machines are listed; Revoke asks, takes the password after a password sign-in, and removes the row", async () => {
  const revoked: [string, unknown][] = [];
  const { root } = workspace(() => [machine("m1")], {
    onSignOut: () => {},
    account: {
      ...relayAccount({ [PASSKEYS]: { body: { passkeys: [] } } }),
      method: "password",
      machines: async () => [
        { machineId: "desk", joinedAt: Date.UTC(2026, 8, 1), online: true },
        {
          machineId: "nas",
          joinedAt: Date.UTC(2026, 8, 2),
          lastSeenAt: Date.now() - 60 * 60_000,
          online: false,
        },
      ],
      revokeMachine: async (machineId, check) => {
        revoked.push([machineId, check]);
      },
    },
  });
  buttonNamed(root, "Settings").click();
  const settings = dialog(root, "Settings");
  await until(settings, () => buttonNames(settings).includes("Revoke nas"));
  expect(buttonNames(settings)).toContain("Revoke desk");

  buttonNamed(settings, "Revoke nas").click();
  expect(revoked).toEqual([]);
  // No password yet: confirming waits for it instead of sending anything.
  buttonNamed(settings, "Revoke machine").click();
  const password = [...settings.querySelectorAll("input[type=password]")].find(
    (node): node is HTMLInputElement =>
      node instanceof HTMLInputElement && visible(node),
  );
  if (!password) throw new Error("the step asks for no password");
  expect(document.activeElement).toBe(password);
  expect(revoked).toEqual([]);

  password.value = "correct horse";
  buttonNamed(settings, "Revoke machine").click();
  await until(settings, () => !buttonNames(settings).includes("Revoke nas"));
  expect(revoked).toEqual([
    ["nas", { kind: "password", password: "correct horse" }],
  ]);
  expect(buttonNames(settings)).toContain("Revoke desk");
});

test("Add a passkey shows only while the server and this browser both do passkeys", async () => {
  const cases = [
    [true, true, true],
    [true, false, false],
    [false, true, false],
  ] as const;
  for (const [offered, available, shown] of cases) {
    const { root } = workspace(() => [machine("m1")], {
      onSignOut: () => {},
      account: {
        ...relayAccount({ [PASSKEYS]: { body: { passkeys: [DESK] } } }),
        passkeyAvailable: available,
        methods: async () => ({ password: true, passkey: offered }),
      },
    });
    const settings = await openAccount(root, 1);
    // The methods land together with the passkey list.
    expect(buttonNames(settings).includes("Add a passkey")).toBe(shown);
    root.remove();
  }
});

test("Passkeys is hidden only when the server offers none and none are registered", async () => {
  const cases = [
    [false, [], false],
    [false, [DESK], true],
    [true, [], true],
  ] as const;
  for (const [offered, passkeys, shown] of cases) {
    const { root } = workspace(() => [machine("m1")], {
      onSignOut: () => {},
      account: {
        ...relayAccount({ [PASSKEYS]: { body: { passkeys } } }),
        methods: async () => ({ password: true, passkey: offered }),
      },
    });
    buttonNamed(root, "Settings").click();
    const settings = dialog(root, "Settings");
    // Methods, passkeys and machines land together.
    await until(
      settings,
      () => !settings.textContent?.includes("Loading passkeys…"),
    );
    const heading = [...settings.querySelectorAll("h4")].find(
      (node) => node.textContent === "Passkeys",
    );
    if (heading === undefined) throw new Error("no Passkeys heading");
    expect(visible(heading)).toBe(shown);
    expect(shownText(settings).includes("These passkeys can sign in")).toBe(
      shown,
    );
    root.remove();
  }
});

test("password sign-in turns off only from a passkey sign-in, with a passkey check", async () => {
  const switchFor = (settings: HTMLElement): HTMLInputElement => {
    const input = [...settings.querySelectorAll("input[role=switch]")].find(
      (node): node is HTMLInputElement =>
        node instanceof HTMLInputElement &&
        node.labels?.[0]?.textContent === "Password sign-in",
    );
    if (!input) throw new Error("no Password sign-in switch");
    return input;
  };
  const password = workspace(() => [machine("m1")], {
    onSignOut: () => {},
    account: {
      ...relayAccount({ [PASSKEYS]: { body: { passkeys: [DESK] } } }),
      method: "password",
    },
  });
  const fromPassword = await openAccount(password.root, 1);
  await until(fromPassword, () => switchFor(fromPassword).checked);
  expect(switchFor(fromPassword).disabled).toBe(true);
  password.root.remove();

  const set: [boolean, unknown][] = [];
  const passkey = workspace(() => [machine("m1")], {
    onSignOut: () => {},
    account: {
      ...relayAccount({ [PASSKEYS]: { body: { passkeys: [DESK] } } }),
      setPasswordSignIn: async (enabled, check) => {
        set.push([enabled, check]);
        return enabled;
      },
    },
  });
  const fromPasskey = await openAccount(passkey.root, 1);
  const toggle = switchFor(fromPasskey);
  await until(fromPasskey, () => toggle.checked && !toggle.disabled);
  toggle.click();
  await until(fromPasskey, () =>
    shownText(fromPasskey).includes("Password sign-in is off."),
  );
  expect(set).toEqual([[false, { kind: "passkey" }]]);
  expect(toggle.checked).toBe(false);
});
