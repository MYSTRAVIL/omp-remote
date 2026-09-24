import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RelayState } from "../src/core/client";
import { installSessionHistory } from "../src/core/history-nav";
import type { MachineNode } from "../src/core/session-tree";
import {
  type UpdateRecord,
  readUpdateHistory,
  recordUpdate,
} from "../src/core/update-policy";
import { type ControlHandlers, renderTree } from "../src/ui/render";
import { FakeHistory } from "./fixtures/fake-history";

// Register a DOM only for this file so happy-dom's globals never leak into the
// crypto/WebSocket-based suites in the same process.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => localStorage.clear());
afterEach(() => document.body.replaceChildren());

function machine(machineId: string, stale = false): MachineNode {
  return stale
    ? { machineId, label: machineId, projects: [], stale: true }
    : { machineId, label: machineId, projects: [] };
}

/**
 * The workspace as main.ts mounts it, with Settings open. `draw` redraws from
 * the current `tree()` and handlers, as a store change or a relay change does.
 */
function openSettings(
  tree: () => MachineNode[],
  overrides: Partial<ControlHandlers>,
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
  const draw = (): void => renderTree(root, tree(), handlers);
  draw();
  [...root.querySelectorAll("button")]
    .find((node) => node.textContent === "Settings")
    ?.click();
  const about = [
    ...root.querySelectorAll<HTMLElement>("dialog[open] section"),
  ].find((node) => node.querySelector("h3")?.textContent === "About");
  if (!about) throw new Error("no About section in the open Settings");
  return { about, draw };
}

/** Each line under Connection: its name and what it says. */
function connection(about: HTMLElement): [string, string][] {
  const names = [...about.querySelectorAll("dl dt")];
  return names.map((name) => [
    name.textContent ?? "",
    name.nextElementSibling?.textContent ?? "",
  ]);
}

/** Whether a paragraph reading exactly `text` shows in `scope`. */
function shows(scope: HTMLElement, text: string): boolean {
  return [...scope.querySelectorAll("p")].some(
    (node) => node.textContent === text && node.closest("[hidden]") === null,
  );
}

test("About names this build and lists the updates this browser took, newest first, at their local time", () => {
  const first = Date.UTC(2026, 8, 20, 8, 15);
  const second = Date.UTC(2026, 8, 22, 17, 40);
  recordUpdate(localStorage, "1a2b3c4", first);
  recordUpdate(localStorage, "5d6e7f8", second);
  const { about } = openSettings(() => [machine("m1")], {
    build: {
      id: "5d6e7f8",
      updates: () => readUpdateHistory(localStorage),
    },
  });

  expect(shows(about, "Build 5d6e7f8")).toBe(true);
  const updates = [...about.querySelectorAll("ol li")].map((item) => ({
    sha: item.querySelector("span")?.textContent,
    at: item.querySelector("time")?.dateTime,
  }));
  expect(updates).toEqual([
    { sha: "5d6e7f8", at: new Date(second).toISOString() },
    { sha: "1a2b3c4", at: new Date(first).toISOString() },
  ]);
  expect(shows(about, "No updates recorded in this browser yet.")).toBe(false);
});

test("with no update recorded, About says so", () => {
  const history: readonly UpdateRecord[] = [];
  const { about } = openSettings(() => [machine("m1")], {
    build: { id: "abc1234", updates: () => history },
  });
  expect(about.querySelectorAll("ol li").length).toBe(0);
  expect(shows(about, "No updates recorded in this browser yet.")).toBe(true);
});

test("Connection follows the relay link and each paired machine live while Settings is open", () => {
  let relay: RelayState = "connected";
  let tree = [machine("m1")];
  const seenAt = Date.now() - 5 * 60_000;
  const lastSeen = new Map([
    ["m1", seenAt],
    ["m2", seenAt],
  ]);
  const { about, draw } = openSettings(() => tree, {
    relayState: () => relay,
    pairedMachines: () =>
      new Map([
        ["m1", "m1"],
        ["m2", "m2"],
        ["m3", "m3"],
      ]),
    machineLastSeen: (machineId) => lastSeen.get(machineId),
  });
  expect(connection(about)).toEqual([
    ["Relay", "Connected"],
    ["m1", "Online"],
    ["m2", "Last seen 5 minutes ago"],
    ["m3", "Not seen online on this device yet"],
  ]);

  // The relay drops: the tree still lists m1, but nothing is known online.
  relay = "offline";
  draw();
  expect(connection(about).slice(0, 2)).toEqual([
    ["Relay", "Offline"],
    ["m1", "Last seen 5 minutes ago"],
  ]);

  relay = "connecting";
  draw();
  expect(connection(about)[0]).toEqual(["Relay", "Connecting…"]);

  // Back, with m2 listed live and m1 only a cached row awaiting its snapshot.
  relay = "connected";
  tree = [machine("m1", true), machine("m2")];
  draw();
  expect(connection(about)).toEqual([
    ["Relay", "Connected"],
    ["m1", "Last seen 5 minutes ago"],
    ["m2", "Online"],
    ["m3", "Not seen online on this device yet"],
  ]);
});

test("without a relay (local dev) Connection lists only the machines", () => {
  const { about } = openSettings(() => [machine("local")], {});
  expect(connection(about)).toEqual([["local", "Online"]]);
});
