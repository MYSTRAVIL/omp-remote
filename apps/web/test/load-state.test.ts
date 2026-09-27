import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionMeta } from "@omp-remote/protocol";
import type { MachineNode } from "../src/core/session-tree";
import { AppStore } from "../src/core/store";
import { type ControlHandlers, renderTree } from "../src/ui/render";

// Register a DOM only for this file so happy-dom's globals never leak into the
// crypto/WebSocket-based suites in the same process.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => document.body.replaceChildren());

function session(id: string, title: string): SessionMeta {
  return {
    id,
    cwd: "/work/app",
    project: "app",
    model: "host/model",
    title,
    pid: 1,
    startedAt: 1,
  };
}

function machine(stale: boolean): MachineNode {
  return {
    machineId: "tower",
    label: "tower",
    projects: [
      {
        project: "app",
        sessions: [session("s1", "Fix the login"), session("s2", "Ship it")],
      },
    ],
    // A cached machine awaits its live list, as the store marks it.
    ...(stale ? { stale: true, syncing: true } : {}),
  };
}

function mount(selected: string[] = []) {
  const handlers: ControlHandlers = {
    onSelect: (id) => selected.push(id),
    onBack: () => {},
    onOverlay: () => ({ dismiss() {} }),
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
  };
  const root = document.createElement("div");
  document.body.append(root);
  const draw = (tree: MachineNode[], connecting: boolean) =>
    renderTree(
      root,
      tree,
      handlers,
      () => null,
      () => null,
      connecting,
    );
  return { root, draw };
}

/** The rail's navigation, where the empty and connecting states render. */
function rail(root: HTMLElement): HTMLElement {
  const nav = root.querySelector<HTMLElement>(".tree");
  if (!nav) throw new Error("navigation not rendered");
  return nav;
}

test("an empty tree while connecting waits instead of asking to pair", () => {
  const { root, draw } = mount();
  draw([], true);
  const nav = rail(root);
  const status = nav.querySelector('[role="status"]');
  expect(status?.textContent).toContain("Connecting to your machines…");
  expect(nav.textContent).not.toContain("Your machines belong here.");
  expect(nav.querySelector(".empty-pair")).toBeNull();
});

test("an empty tree once connected shows the pair empty state", () => {
  const { root, draw } = mount();
  draw([], true);
  draw([], false);
  const nav = rail(root);
  expect(nav.textContent).toContain("Your machines belong here.");
  expect(nav.textContent).not.toContain("Connecting to your machines…");
  expect(nav.querySelector(".empty-pair")).not.toBeNull();
});

test("a stale machine says it is updating until its live list lands", () => {
  const selected: string[] = [];
  const { root, draw } = mount(selected);
  const updating = () =>
    [...root.querySelectorAll(".machine-updating")].filter(
      (node) => node.closest("[hidden]") === null,
    );
  const row = () => {
    const node = root.querySelector<HTMLButtonElement>(
      '.session[data-session-id="s1"]',
    );
    if (!node) throw new Error("row s1 not rendered");
    return node;
  };

  draw([machine(true)], true);
  expect(updating().map((node) => node.textContent)).toEqual(["Updating…"]);
  const cached = row();
  expect(cached.textContent).toContain("Fix the login");
  cached.click();
  expect(selected).toEqual(["s1"]);

  draw([machine(false)], false);
  expect(updating()).toEqual([]);
  expect(row()).toBe(cached);
  expect(row().querySelector(".session-row-title")?.textContent).toBe(
    "Fix the login",
  );
});

/** What the node shows: its text without the parts hidden from view. */
function shown(node: Element): string {
  const copy = node.cloneNode(true);
  if (!(copy instanceof Element)) throw new Error("not an element");
  for (const hidden of copy.querySelectorAll("[hidden]")) hidden.remove();
  return copy.textContent ?? "";
}

test("the main view lists only machines with a session: a machine without one shows as syncing while its list is in doubt, never 0, and as no live sessions after", () => {
  const { root, draw } = mount();
  const store = new AppStore();
  const nav = () => {
    draw(store.tree(), store.connecting());
    return rail(root);
  };

  // Listed by the relay, its snapshot not in yet.
  store.setMachineList(["tower", "laptop"]);
  const syncing = shown(nav());
  expect(syncing).toContain("Syncing sessions…");
  expect(syncing).not.toContain("0");
  expect(syncing).not.toContain("No live sessions");
  expect(nav().querySelector(".machine-group")).toBeNull();

  // Only the machine with a session is listed.
  store.applyFrame("tower", { t: "sessions", sessions: [] });
  store.applyFrame("laptop", {
    t: "sessions",
    sessions: [session("s1", "Fix the login")],
  });
  const listed = [...nav().querySelectorAll(".machine-group .machine")].map(
    (node) => node.textContent,
  );
  expect(listed).toEqual(["laptop"]);
  expect(shown(nav())).not.toContain("No live sessions");

  // Its session ends: nothing is left to list.
  store.applyFrame("laptop", { t: "sessions", sessions: [] });
  const empty = shown(nav());
  expect(empty).not.toContain("Syncing");
  expect(empty).toContain("No live sessions.");
  expect(nav().querySelector(".machine-group")).toBeNull();
  expect(nav().querySelector(".empty-pair")).toBeNull();
});

test("an unreachable headless session is not listed; an unreachable interactive one says so", () => {
  const { root, draw } = mount();
  const store = new AppStore();
  store.setMachineList(["tower", "laptop"]);
  store.applyFrame("tower", {
    t: "sessions",
    sessions: [
      { ...session("tui", "At the desk"), reachable: false },
      { ...session("run", "Coral run"), reachable: false, headless: true },
    ],
  });
  store.applyFrame("laptop", {
    t: "sessions",
    sessions: [
      { ...session("print", "Print run"), reachable: false, headless: true },
    ],
  });
  draw(store.tree(), store.connecting());
  const rows = [...rail(root).querySelectorAll<HTMLElement>(".session")];
  expect(rows.map((row) => row.dataset.sessionId)).toEqual(["tui"]);
  expect(rows[0]?.textContent).toContain("Unreachable");
  // A machine whose only session is hidden is not listed either.
  expect(
    [...rail(root).querySelectorAll(".machine-group .machine")].map(
      (node) => node.textContent,
    ),
  ).toEqual(["tower"]);

  // A headless run its host reaches is listed like any other.
  store.applyFrame("laptop", {
    t: "sessions",
    sessions: [{ ...session("print", "Print run"), headless: true }],
  });
  draw(store.tree(), store.connecting());
  expect(
    [...rail(root).querySelectorAll<HTMLElement>(".session")].map(
      (row) => row.dataset.sessionId,
    ),
  ).toEqual(["print", "tui"]);
});

test("a machine this phone has to pair with again says so with a way to re-pair instead of syncing forever, until an exchange opens here", () => {
  const { root, draw } = mount();
  const store = new AppStore();
  const nav = () => {
    draw(store.tree(), store.connecting());
    return rail(root);
  };
  store.setMachineList(["tower", "laptop"]);
  store.setMachineLabels(new Map([["tower", "Desk"]]));
  store.applyFrame("laptop", {
    t: "sessions",
    sessions: [session("s1", "Fix the login")],
  });
  store.markUnpaired("tower");

  const notice = nav().querySelector(".tree-repair");
  expect(notice?.textContent).toContain(
    "This phone is no longer paired with Desk",
  );
  expect(notice?.querySelector("button")?.textContent).toContain("Re-pair");
  expect(shown(nav())).not.toContain("Syncing");
  // The badge counts again: no list from that machine is awaited.
  expect(store.waitingCount()).toBe(0);

  // Its ack, or any frame, opened under this phone's keys: paired after all,
  // and its list is awaited again.
  store.markPaired("tower");
  expect(nav().querySelector(".tree-repair")).toBeNull();
  expect(store.waitingCount()).toBeUndefined();
});
