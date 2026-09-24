import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  ApprovalMode,
  CatalogModel,
  CatalogRole,
  SessionMeta,
  SpawnThinkingLevel,
} from "@omp-remote/protocol";
import { ChatPreferences } from "../src/core/chat-preferences";
import { ComposerPreferences } from "../src/core/composer-preferences";
import { installSessionHistory } from "../src/core/history-nav";
import { type MachineNode, assembleTree } from "../src/core/session-tree";
import { emptyTranscript } from "../src/core/transcript";
import { SessionView } from "../src/ui/conversation";
import {
  type ControlHandlers,
  renderSessionView,
  renderTree,
} from "../src/ui/render";
import { FakeHistory } from "./fixtures/fake-history";

// Register a DOM only for this file so happy-dom's globals never leak into the
// crypto/WebSocket-based suites in the same process.
beforeAll(() => {
  GlobalRegistrator.register();
  // happy-dom has no FontFaceSet; the composer only awaits it to re-measure.
  if (!Reflect.has(document, "fonts"))
    Object.defineProperty(document, "fonts", {
      value: { ready: Promise.resolve() },
      configurable: true,
    });
});
afterAll(() => GlobalRegistrator.unregister());
// Remembered, hidden and removed projects persist in this device's storage.
beforeEach(() => localStorage.clear());
afterEach(() => document.body.replaceChildren());

interface Spawned {
  machineId: string;
  cwd: string;
  model?: string;
  thinkingLevel?: SpawnThinkingLevel;
  approvalMode: ApprovalMode;
}

function session(id: string, cwd: string, model = "host/model"): SessionMeta {
  const project = cwd.split("/").pop() ?? cwd;
  return { id, cwd, project, model, title: id, pid: 1, startedAt: 1 };
}

function model(id: string, name: string): CatalogModel {
  return { id, name, provider: id.split("/")[0] ?? "", efforts: [] };
}

const OPUS = model("anthropic/opus", "Opus");
const CODER = model("qwen/coder", "Coder");
const TASK: CatalogRole = {
  role: "task",
  modelId: CODER.id,
  modelName: CODER.name,
  effort: "high",
};

/** Desk has two projects and a cached catalog; the laptop has one project and none. */
function tree(): MachineNode[] {
  return assembleTree([
    {
      machineId: "desk",
      label: "desk",
      sessions: [session("a", "/p/alpha"), session("b", "/p/beta")],
    },
    {
      machineId: "laptop",
      label: "laptop",
      sessions: [session("c", "/home/me/gamma")],
    },
  ]).map((machine) =>
    machine.machineId === "desk"
      ? { ...machine, catalog: { models: [OPUS, CODER], roles: [TASK] } }
      : machine,
  );
}

/** Mount the workspace the way main.ts does, recording what spawn is sent. */
function workspace(overrides: Partial<ControlHandlers> = {}) {
  const history = new FakeHistory();
  const nav = installSessionHistory({
    history,
    select: () => {},
    onPopState: (handler) => history.onPop(handler),
  });
  const spawned: Spawned[] = [];
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
    onSpawn: async (machineId, opts) => {
      spawned.push({ machineId, ...opts });
      return true;
    },
    onCancelSpawn: () => {},
    onInteractionReply: async () => true,
    onRenameMachine: () => true,
    ...overrides,
  };
  const root = document.createElement("div");
  document.body.append(root);
  const draw = () => renderTree(root, tree(), handlers);
  draw();
  return { root, history, draw, spawned, handlers };
}

const visible = (node: Element): boolean => node.closest("[hidden]") === null;

const nameOf = (node: Element): string =>
  node.getAttribute("aria-label") ?? node.textContent ?? "";

function buttonNamed(scope: ParentNode, name: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find(
    (node) => visible(node) && nameOf(node) === name,
  );
  if (!match) throw new Error(`no visible button named "${name}"`);
  return match;
}

/** A drill-in row such as "Models", whose name continues with its current value. */
function buttonStarting(scope: ParentNode, name: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find(
    (node) => visible(node) && nameOf(node).startsWith(name),
  );
  if (!match) throw new Error(`no visible button starting "${name}"`);
  return match;
}

function dialog(root: HTMLElement, title: string): HTMLDialogElement {
  const match = [...root.querySelectorAll("dialog")].find(
    (node) =>
      document.getElementById(node.getAttribute("aria-labelledby") ?? "")
        ?.textContent === title,
  );
  if (!match) throw new Error(`no dialog titled "${title}"`);
  return match;
}

/** The group a user finds by its label, e.g. "Project". */
function group(scope: ParentNode, name: string): HTMLElement {
  const match = [
    ...scope.querySelectorAll<HTMLElement>("[aria-labelledby]"),
  ].find(
    (node) =>
      document.getElementById(node.getAttribute("aria-labelledby") ?? "")
        ?.textContent === name,
  );
  if (!match) throw new Error(`no group labelled "${name}"`);
  return match;
}

/** The dropdown a user finds by its label, e.g. "Project". */
function selectLabelled(scope: ParentNode, label: string): HTMLSelectElement {
  const match = [...scope.querySelectorAll("select")].find(
    (node) => visible(node) && node.labels?.[0]?.textContent === label,
  );
  if (!match) throw new Error(`no visible select labelled "${label}"`);
  return match;
}

/** The options a dropdown offers, as read out. */
function options(scope: ParentNode, label: string): string[] {
  return [...selectLabelled(scope, label).options].map(
    (option) => option.textContent ?? "",
  );
}

/** Pick the one option of a dropdown whose text includes `text`. */
function choose(scope: ParentNode, label: string, text: string): void {
  const node = selectLabelled(scope, label);
  const matches = [...node.options].filter((option) =>
    option.textContent?.includes(text),
  );
  const [match] = matches;
  if (matches.length !== 1 || !match)
    throw new Error(`${matches.length} options of "${label}" match "${text}"`);
  select(node, match.value);
}

/** The chosen option of a dropdown, as read out. */
function chosen(scope: ParentNode, label: string): string | undefined {
  const node = selectLabelled(scope, label);
  return node.options[node.selectedIndex]?.textContent?.trim();
}

function select(node: HTMLSelectElement, value: string): void {
  node.value = value;
  node.dispatchEvent(new Event("change", { bubbles: true }));
}

function typeInto(scope: ParentNode, label: string, text: string): void {
  const input = [...scope.querySelectorAll("input")].find(
    (node) => visible(node) && node.labels?.[0]?.textContent === label,
  );
  if (!input) throw new Error(`no visible field labelled "${label}"`);
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function openSpawn(root: HTMLElement): HTMLDialogElement {
  buttonNamed(root, "New session").click();
  const spawn = dialog(root, "New session");
  expect(spawn.open).toBe(true);
  return spawn;
}

test("New session's dropdowns pick the machine, project and approval mode that Start sends", () => {
  const { root, spawned } = workspace();
  const spawn = openSpawn(root);

  choose(spawn, "Machine", "laptop");
  choose(spawn, "Machine", "desk");
  choose(spawn, "Project", "/p/beta");
  choose(spawn, "Approval mode", "Write mode");
  buttonNamed(spawn, "Start session").click();

  expect(spawned).toEqual([
    {
      machineId: "desk",
      cwd: "/p/beta",
      model: undefined,
      approvalMode: "write",
    },
  ]);
});

test("each machine keeps its own directory while switching between them", () => {
  const { root, spawned } = workspace();
  const spawn = openSpawn(root);
  choose(spawn, "Machine", "laptop");
  choose(spawn, "Project", "Custom directory");
  typeInto(spawn, "Working directory (cwd)", "/srv/scratch");
  choose(spawn, "Machine", "desk");
  choose(spawn, "Project", "/p/beta");
  choose(spawn, "Machine", "laptop");
  buttonNamed(spawn, "Start session").click();

  expect(spawned.map(({ machineId, cwd }) => ({ machineId, cwd }))).toEqual([
    { machineId: "laptop", cwd: "/srv/scratch" },
  ]);
});

test("Remove drops a project, and it stays gone as the same sessions keep reporting and after a reload", () => {
  const { root, draw } = workspace();
  const spawn = openSpawn(root);
  const projects = (): string[] => options(spawn, "Project");
  expect(projects().some((label) => label.includes("/p/alpha"))).toBe(true);

  buttonNamed(spawn, "Manage").click();
  buttonNamed(spawn, "Remove alpha from this device's list").click();
  expect(projects().some((label) => label.includes("/p/alpha"))).toBe(false);
  draw();
  expect(projects().some((label) => label.includes("/p/alpha"))).toBe(false);

  const reloaded = workspace();
  const again = openSpawn(reloaded.root);
  const listed = options(again, "Project");
  expect(listed.some((label) => label.includes("/p/alpha"))).toBe(false);
  expect(listed.some((label) => label.includes("/p/beta"))).toBe(true);
});

test("Hide drops a project, Settings > Projects lists it, and Unhide brings it back", () => {
  const { root, history } = workspace();
  let spawn = openSpawn(root);
  buttonNamed(spawn, "Manage").click();
  buttonNamed(spawn, "Hide alpha").click();
  expect(
    options(spawn, "Project").some((label) => label.includes("/p/alpha")),
  ).toBe(false);
  buttonNamed(spawn, "Close new session").click();
  history.flush();

  buttonNamed(root, "Settings").click();
  const settings = dialog(root, "Settings");
  const hidden = group(settings, "Hidden projects");
  expect(hidden.textContent).toContain("/p/alpha");
  buttonNamed(settings, "Unhide alpha on desk").click();
  expect(hidden.textContent).not.toContain("/p/alpha");
  buttonNamed(settings, "Close settings").click();
  history.flush();

  spawn = openSpawn(root);
  expect(
    options(spawn, "Project").some((label) => label.includes("/p/alpha")),
  ).toBe(true);
});

test("a machine's cached catalog is offered, and the model picked from it is what Start sends", () => {
  const { root, spawned } = workspace();
  const spawn = openSpawn(root);
  choose(spawn, "Machine", "desk");
  const picker = group(spawn, "Model (optional)");

  buttonStarting(picker, "Models").click();
  const offered = [...picker.querySelectorAll("button")]
    .filter(visible)
    .map(nameOf);
  expect(offered).toEqual(expect.arrayContaining(["Opus", "Coder"]));
  buttonNamed(picker, "Opus").click();
  buttonNamed(spawn, "Start session").click();
  expect(spawned.at(-1)?.model).toBe(OPUS.id);
});

test("a model picked from one machine's catalog is not sent to another machine", () => {
  const { root, spawned } = workspace();
  const spawn = openSpawn(root);
  choose(spawn, "Machine", "desk");
  const picker = group(spawn, "Model (optional)");
  buttonStarting(picker, "Models").click();
  buttonNamed(picker, "Opus").click();

  choose(spawn, "Machine", "laptop");
  buttonNamed(spawn, "Start session").click();
  expect(spawned.at(-1)?.machineId).toBe("laptop");
  expect(spawned.at(-1)?.model).toBeUndefined();
});

test("a model picked in a cancelled New session does not come back when it is opened from a session", () => {
  const { root, history, spawned, handlers } = workspace();
  let spawn = openSpawn(root);
  choose(spawn, "Machine", "desk");
  const picker = group(spawn, "Model (optional)");
  buttonStarting(picker, "Models").click();
  buttonNamed(picker, "Opus").click();
  buttonNamed(spawn, "Close new session").click();
  history.flush();

  // From a laptop session, then over to desk: desk starts at its (unset)
  // saved default, not at the abandoned pick.
  renderSessionView(
    root,
    session("c", "/home/me/gamma"),
    emptyTranscript(),
    handlers,
    [],
    { models: [], roles: [] },
    { tree: tree(), sessionPulse: () => null, orbState: () => null },
  );
  spawn = openSpawn(root);
  expect(chosen(spawn, "Machine")).toContain("laptop");
  choose(spawn, "Machine", "desk");
  buttonNamed(spawn, "Start session").click();
  expect(spawned.at(-1)?.machineId).toBe("desk");
  expect(spawned.at(-1)?.model).toBeUndefined();
});

test("a machine with no cached catalog offers only a typed model id", () => {
  const { root, spawned } = workspace();
  const spawn = openSpawn(root);
  choose(spawn, "Machine", "laptop");
  const models = group(spawn, "Model (optional)");
  expect([...models.querySelectorAll("button")].filter(visible)).toEqual([]);

  typeInto(models, "Model id", "  local/qwen  ");
  buttonNamed(spawn, "Start session").click();
  expect(spawned.at(-1)).toEqual({
    machineId: "laptop",
    cwd: "/home/me/gamma",
    model: "local/qwen",
    approvalMode: "always-ask",
  });
});

test("the composer's picker still sets the session's model and effort, closing with one history entry", () => {
  const history = new FakeHistory();
  const nav = installSessionHistory({
    history,
    select: () => {},
    onPopState: (handler) => history.onPop(handler),
  });
  const calls: string[][] = [];
  const handlers: ControlHandlers = {
    onSelect: () => {},
    onBack: () => {},
    onOverlay: (close) => nav.overlay(close),
    onPrompt: async () => true,
    onInterrupt: async () => true,
    onServiceTier: async () => true,
    onSetModel: async (sessionId, id) => {
      calls.push(["model", sessionId, id]);
      return true;
    },
    onSetThinkingLevel: async (sessionId, level) => {
      calls.push(["effort", sessionId, level]);
      return true;
    },
    onCompact: async () => true,
    onCloseSession: async () => true,
    onUpload: async () => "resource",
    onSpawn: async () => true,
    onCancelSpawn: () => {},
    onInteractionReply: async () => true,
    onRenameMachine: () => true,
  };
  const meta = session("s1", "/p/alpha", OPUS.id);
  const view = new SessionView(
    meta,
    handlers,
    new ComposerPreferences(),
    new ChatPreferences(),
  );
  document.body.append(view.node);
  view.update(meta, emptyTranscript(), handlers, [], {
    models: [OPUS, CODER],
    roles: [TASK],
    currentId: OPUS.id,
    currentEffort: "low",
  });
  const drawer = view.node.querySelector("dialog");
  if (!drawer) throw new Error("no model drawer");
  const pick = (list: string, row: string): void => {
    buttonStarting(view.node, "Change model").click();
    expect(history.position()).toBe(1);
    buttonStarting(drawer, list).click();
    buttonStarting(drawer, row).click();
    expect(drawer.open).toBe(false);
    history.flush();
    expect(history.position()).toBe(0);
  };

  pick("Models", "Coder");
  pick("Roles", "task");
  pick("Effort", "high");
  expect(calls).toEqual([
    ["model", "s1", CODER.id],
    ["model", "s1", CODER.id],
    ["effort", "s1", "high"],
    ["effort", "s1", "high"],
  ]);

  // Back inside the drawer returns to its root list without a history entry.
  buttonStarting(view.node, "Change model").click();
  buttonStarting(drawer, "Models").click();
  buttonNamed(drawer, "Back").click();
  expect(nameOf(buttonStarting(drawer, "Models"))).toContain(OPUS.name);
  expect(history.position()).toBe(1);
  view.dispose();
});

function openSettings(root: HTMLElement): HTMLDialogElement {
  buttonNamed(root, "Settings").click();
  return dialog(root, "Settings");
}

test("a dropdown shows its saved choice even when that choice means none", () => {
  const { root, history } = workspace();
  const settings = openSettings(root);
  expect(chosen(settings, "Default machine")).toBe("No default");
  expect(chosen(settings, "desk")).toBe("None");
  expect(chosen(settings, "Default effort")).toBe("omp default");
  buttonNamed(settings, "Close settings").click();
  history.flush();

  const spawn = openSpawn(root);
  expect(chosen(spawn, "Effort")).toBe("omp default");
  choose(spawn, "Project", "Custom directory");
  expect(chosen(spawn, "Project")).toBe("Custom directory…");
});

test("the default machine, its typed default model and the default effort preselect New session and are what Start sends", () => {
  const { root, history, spawned } = workspace();
  const settings = openSettings(root);
  select(selectLabelled(settings, "Default machine"), "laptop");
  select(selectLabelled(settings, "Default effort"), "high");
  // The laptop has no cached catalog: its default model is typed.
  typeInto(group(settings, "laptop"), "Model id", "local/qwen");
  buttonNamed(settings, "Close settings").click();
  history.flush();

  const spawn = openSpawn(root);
  expect(chosen(spawn, "Machine")).toContain("laptop");
  expect(chosen(spawn, "Effort")).toBe("High");
  buttonNamed(spawn, "Start session").click();
  expect(spawned.at(-1)).toEqual({
    machineId: "laptop",
    cwd: "/home/me/gamma",
    model: "local/qwen",
    thinkingLevel: "high",
    approvalMode: "always-ask",
  });
});

test("a machine's default project and a default model picked from its catalog in Settings start New session there", () => {
  const { root, history, spawned } = workspace();
  const settings = openSettings(root);
  select(selectLabelled(settings, "desk"), "/p/beta");
  const deskModel = group(settings, "desk");
  buttonStarting(deskModel, "Models").click();
  buttonNamed(deskModel, "Opus").click();
  buttonNamed(settings, "Close settings").click();
  history.flush();

  const spawn = openSpawn(root);
  choose(spawn, "Machine", "desk");
  expect(chosen(spawn, "Project")).toContain("/p/beta");
  // Without a saved effort, New session leaves it to omp; one chosen here is sent.
  expect(chosen(spawn, "Effort")).toBe("omp default");
  choose(spawn, "Effort", "Low");
  buttonNamed(spawn, "Start session").click();
  expect(spawned.at(-1)).toEqual({
    machineId: "desk",
    cwd: "/p/beta",
    model: OPUS.id,
    thinkingLevel: "low",
    approvalMode: "always-ask",
  });
});

test("hiding the default project in New session clears it in Settings", () => {
  const { root, history } = workspace();
  let settings = openSettings(root);
  select(selectLabelled(settings, "desk"), "/p/alpha");
  buttonNamed(settings, "Close settings").click();
  history.flush();

  const spawn = openSpawn(root);
  choose(spawn, "Machine", "desk");
  buttonNamed(spawn, "Manage").click();
  buttonNamed(spawn, "Hide alpha").click();
  buttonNamed(spawn, "Close new session").click();
  history.flush();

  settings = openSettings(root);
  expect(selectLabelled(settings, "desk").value).toBe("");
});
