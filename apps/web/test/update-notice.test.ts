import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { InteractionFrame, SessionMeta } from "@omp-remote/protocol";
import { emptyTranscript } from "../src/core/transcript";
import {
  type HistoryStorage,
  type MarkerStorage,
  UPDATE_HISTORY_KEY,
  UPDATE_RELOADED_KEY,
  decideUpdateAction,
  readUpdateHistory,
} from "../src/core/update-policy";
import {
  type ControlHandlers,
  hasUnsentDraft,
  renderSessionView,
} from "../src/ui/render";
import { UpdateNotice } from "../src/ui/update-notice";

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
afterEach(() => document.body.replaceChildren());

/** Stands in for `sessionStorage`, which survives the reload in one tab. */
class TabStorage implements MarkerStorage {
  readonly #items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
}

/**
 * One page load: a fresh body holding only this load's notice. `history`
 * stands in for `localStorage`, which outlives the tab.
 */
function load(
  storage: MarkerStorage,
  reload: () => void = () => {},
  history: HistoryStorage = new TabStorage(),
  now: () => number = () => 0,
) {
  document.body.replaceChildren();
  return new UpdateNotice({ storage, history, reload, now });
}

const statusText = (): string =>
  document.querySelector('[role="status"]')?.textContent ?? "";

test("a draft or an open passkey prompt asks before reloading; otherwise it reloads at once", () => {
  expect(decideUpdateAction({ hasDraft: true, passkeyOpen: false })).toBe(
    "prompt",
  );
  expect(decideUpdateAction({ hasDraft: false, passkeyOpen: true })).toBe(
    "prompt",
  );
  expect(decideUpdateAction({ hasDraft: false, passkeyOpen: false })).toBe(
    "reload",
  );
});

test("the load after an update reload names the new build once and consumes the marker", () => {
  const storage = new TabStorage();
  let reloads = 0;
  load(storage, () => {
    reloads += 1;
  }).apply("reload");
  expect(reloads).toBe(1);

  load(storage).announce("abc1234");
  expect(statusText()).toContain("abc1234");
  expect(storage.getItem(UPDATE_RELOADED_KEY)).toBeNull();

  // A later reload in the same tab (not an update) says nothing.
  load(storage).announce("abc1234");
  expect(statusText()).toBe("");
});

test("a plain load with no marker shows nothing", () => {
  load(new TabStorage()).announce("abc1234");
  expect(statusText()).toBe("");
});

test("an offered update waits for Reload, which leaves the marker and reloads", () => {
  const storage = new TabStorage();
  let reloads = 0;
  load(storage, () => {
    reloads += 1;
  }).apply("prompt");
  expect(reloads).toBe(0);
  expect(storage.getItem(UPDATE_RELOADED_KEY)).toBeNull();
  const reload = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="status"] button'),
  ].find((node) => node.textContent === "Reload");
  if (!reload) throw new Error("no Reload button in the notice");

  reload.click();
  expect(reloads).toBe(1);
  load(storage).announce("def5678");
  expect(statusText()).toContain("def5678");
});

test("each update is recorded newest first and the latest ten outlast reloads; a plain reload records none", () => {
  const tab = new TabStorage();
  const device = new TabStorage();
  const start = Date.UTC(2026, 8, 23, 9, 0);
  for (let n = 1; n <= 12; n += 1) {
    load(tab, () => {}, device).apply("reload");
    load(
      tab,
      () => {},
      device,
      () => start + n * 60_000,
    ).announce(`b${n}`);
  }
  load(
    tab,
    () => {},
    device,
    () => start + 13 * 60_000,
  ).announce("b12");

  const history = readUpdateHistory(device);
  expect(history.map(({ sha }) => sha)).toEqual([
    "b12",
    "b11",
    "b10",
    "b9",
    "b8",
    "b7",
    "b6",
    "b5",
    "b4",
    "b3",
  ]);
  expect(history[0]?.at).toBe(start + 12 * 60_000);
});

test("a malformed update record is dropped on its own; unreadable history is empty", () => {
  const device = new TabStorage();
  device.setItem(
    UPDATE_HISTORY_KEY,
    JSON.stringify([{ sha: "abc1234", at: 5 }, { sha: 7 }, "junk"]),
  );
  expect(readUpdateHistory(device)).toEqual([{ sha: "abc1234", at: 5 }]);
  device.setItem(UPDATE_HISTORY_KEY, "{not json");
  expect(readUpdateHistory(device)).toEqual([]);
});

function session(id: string): SessionMeta {
  return {
    id,
    cwd: "/p/alpha",
    project: "alpha",
    model: "host/model",
    title: id,
    pid: 1,
    startedAt: 1,
  };
}

const handlers: ControlHandlers = {
  onSelect: () => {},
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

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}

function textarea(root: HTMLElement, selector: string): HTMLTextAreaElement {
  const node = root.querySelector<HTMLTextAreaElement>(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node;
}

test("composer text is a draft, whitespace is not, and it counts from a session in the background", () => {
  const root = mount();
  expect(hasUnsentDraft(root)).toBe(false);
  renderSessionView(root, session("a"), emptyTranscript(), handlers);
  const input = textarea(root, ".composer-input");
  input.value = "  \n\t ";
  expect(hasUnsentDraft(root)).toBe(false);
  input.value = "fix the flaky test";
  expect(hasUnsentDraft(root)).toBe(true);

  renderSessionView(root, session("b"), emptyTranscript(), handlers);
  expect(hasUnsentDraft(root)).toBe(true);
});

test("an attached image is a draft", () => {
  const root = mount();
  renderSessionView(root, session("a"), emptyTranscript(), handlers);
  const picker = root.querySelector<HTMLInputElement>('input[type="file"]');
  if (!picker) throw new Error("no attachment picker");
  Object.defineProperty(picker, "files", {
    value: [new File(["png"], "shot.png", { type: "image/png" })],
    configurable: true,
  });
  picker.dispatchEvent(new Event("change"));
  expect(hasUnsentDraft(root)).toBe(true);
});

test("an answer typed into a pending question is a draft", () => {
  const ask: InteractionFrame = {
    t: "interaction",
    sessionId: "a",
    id: "q1",
    payload: { kind: "ask", questions: [{ question: "Which branch?" }] },
  };
  const root = mount();
  renderSessionView(root, session("a"), emptyTranscript(), handlers, [ask]);
  const answer = textarea(root, ".question-input");
  answer.value = "   ";
  expect(hasUnsentDraft(root)).toBe(false);
  answer.value = "main";
  expect(hasUnsentDraft(root)).toBe(true);
});
