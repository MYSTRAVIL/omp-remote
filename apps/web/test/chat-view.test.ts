import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionMeta, UplinkFrame } from "@omp-remote/protocol";
import { ChatPreferences } from "../src/core/chat-preferences";
import { ComposerPreferences } from "../src/core/composer-preferences";
import { installSessionHistory } from "../src/core/history-nav";
import {
  type TranscriptState,
  emptyTranscript,
  reduceTranscript,
} from "../src/core/transcript";
import { SessionView } from "../src/ui/conversation";
import { type ControlHandlers, renderTree } from "../src/ui/render";
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
// Chat preferences persist in this device's storage.
beforeEach(() => localStorage.clear());
afterEach(() => document.body.replaceChildren());

const META: SessionMeta = {
  id: "s1",
  cwd: "/p/alpha",
  project: "alpha",
  model: "host/model",
  title: "s1",
  pid: 1,
  startedAt: 1,
};

const handlers: ControlHandlers = {
  onSelect: () => {},
  onBack: () => {},
  onOverlay: () => ({ dismiss: () => {} }),
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

function msg(
  msgId: string,
  role: string,
  text: string,
  at?: number,
): UplinkFrame {
  return { t: "msg", sessionId: "s1", phase: "end", msgId, role, text, at };
}

function tool(callId: string): UplinkFrame {
  return {
    t: "tool",
    sessionId: "s1",
    phase: "end",
    callId,
    name: "bash",
    status: "ok",
    preview: "done",
  };
}

/** A session view on screen, redrawn with `frames` folded into its transcript. */
function mount(chat: ChatPreferences) {
  const view = new SessionView(META, handlers, new ComposerPreferences(), chat);
  document.body.append(view.node);
  const transcript: TranscriptState = emptyTranscript();
  const draw = (...frames: UplinkFrame[]): void => {
    for (const frame of frames) reduceTranscript(transcript, frame);
    view.update(META, transcript, handlers, [], { models: [], roles: [] });
  };
  return { view, draw };
}

/** A mounted session view with the layout a browser would measure (happy-dom
 *  has none): the feed scrolls within [0, scrollHeight - clientHeight], and
 *  `resized()` fires its resize observers as a size change would. */
function mountMeasured(chat: ChatPreferences) {
  const observers: { fire(): void }[] = [];
  const RealResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    readonly #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
      observers.push(this);
    }
    fire(): void {
      this.#callback([], this);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  const mounted = (() => {
    try {
      return mount(chat);
    } finally {
      globalThis.ResizeObserver = RealResizeObserver;
    }
  })();
  const box = { scrollTop: 0, scrollHeight: 600, clientHeight: 600 };
  const feed = mounted.view.node.querySelector(".feed");
  const jump = mounted.view.node.querySelector(".jump-latest");
  if (!feed || !(jump instanceof HTMLButtonElement)) throw new Error("no feed");
  Object.defineProperties(feed, {
    scrollHeight: { get: () => box.scrollHeight, configurable: true },
    clientHeight: { get: () => box.clientHeight, configurable: true },
    scrollTop: {
      get: () => box.scrollTop,
      set: (top: number) => {
        box.scrollTop = Math.max(
          0,
          Math.min(top, box.scrollHeight - box.clientHeight),
        );
      },
      configurable: true,
    },
  });
  const resized = (): void => {
    for (const observer of observers) observer.fire();
  };
  /** What the reader sees: whether they are at the newest content, and
   *  whether Jump to latest shows and flags new messages. */
  const seen = () => ({
    atBottom: box.scrollTop === box.scrollHeight - box.clientHeight,
    jump: !jump.hidden,
    unseen: jump.classList.contains("has-new"),
  });
  return { ...mounted, box, feed, resized, seen };
}

const visible = (node: Element): boolean => node.closest("[hidden]") === null;

/** The message whose text is `text`. */
function message(scope: ParentNode, text: string): HTMLElement {
  const match = [...scope.querySelectorAll<HTMLElement>(".message")].find(
    (node) => node.querySelector(".text")?.textContent === text,
  );
  if (!match) throw new Error(`no message "${text}"`);
  return match;
}

/** The time a reader sees on a message, or undefined when none shows. */
function shownTime(node: HTMLElement): string | undefined {
  const time = node.querySelector("time");
  return time && visible(time) ? (time.dateTime ?? "") : undefined;
}

test("each chat preference persists: a new preference object reads it back", () => {
  const chat = new ChatPreferences();
  expect([
    chat.autoScroll,
    chat.textSize,
    chat.timestamps,
    chat.thinkingExpanded,
    chat.toolOutputExpanded,
    chat.toolGrouping,
  ]).toEqual([true, "default", false, false, false, "3"]);
  chat.setAutoScroll(false);
  chat.setTextSize("large");
  chat.setTimestamps(true);
  chat.setThinkingExpanded(true);
  chat.setToolOutputExpanded(true);
  chat.setToolGrouping("off");

  const reloaded = new ChatPreferences();
  expect([
    reloaded.autoScroll,
    reloaded.textSize,
    reloaded.timestamps,
    reloaded.thinkingExpanded,
    reloaded.toolOutputExpanded,
    reloaded.toolGrouping,
  ]).toEqual([false, "large", true, true, true, "off"]);
});

test("a stored value the app no longer knows falls back alone, keeping the rest", () => {
  localStorage.setItem(
    "omp-remote.chat.preferences",
    JSON.stringify({ autoScroll: false, textSize: "huge", timestamps: true }),
  );
  const chat = new ChatPreferences();
  expect([chat.autoScroll, chat.textSize, chat.timestamps]).toEqual([
    false,
    "default",
    true,
  ]);
});

test("text size applies to an open conversation at once", () => {
  const chat = new ChatPreferences();
  const { view, draw } = mount(chat);
  draw(msg("a1", "assistant", "Hello"));
  const transcript = view.node.querySelector(".transcript");
  if (!transcript) throw new Error("no transcript");
  expect(transcript.classList.contains("text-large")).toBe(false);
  chat.setTextSize("large");
  expect(transcript.classList.contains("text-large")).toBe(true);
  chat.setTextSize("small");
  expect(transcript.classList.contains("text-large")).toBe(false);
  expect(transcript.classList.contains("text-small")).toBe(true);
  view.dispose();
});

test("with auto-scroll off, a session opened before its transcript arrives still opens at its newest message", () => {
  const chat = new ChatPreferences();
  chat.setAutoScroll(false);
  const { view, draw, box, seen } = mountMeasured(chat);
  draw();
  box.scrollHeight = 2000;
  draw(msg("u1", "user", "first"), msg("a1", "assistant", "last"));
  expect(seen()).toEqual({ atBottom: true, jump: false, unseen: false });
  view.dispose();
});

test("with auto-scroll off, a resize keeps a reader at the bottom there; only new content waits below", () => {
  const chat = new ChatPreferences();
  chat.setAutoScroll(false);
  const { view, draw, box, feed, resized, seen } = mountMeasured(chat);
  box.scrollHeight = 2000;
  draw(msg("a1", "assistant", "Hello"));
  expect(seen()).toEqual({ atBottom: true, jump: false, unseen: false });
  // The reader wheels the feed: the view has landed, the reader is in charge.
  feed.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));

  // The keyboard opens: the feed shrinks, nothing new arrived.
  box.clientHeight = 300;
  resized();
  expect(seen()).toEqual({ atBottom: true, jump: false, unseen: false });

  // Content grows (an image decodes): the view stays put and flags it.
  const top = box.scrollTop;
  box.scrollHeight = 2600;
  resized();
  expect(box.scrollTop).toBe(top);
  expect(seen()).toEqual({ atBottom: false, jump: true, unseen: true });
  view.dispose();
});

test("reopening a chat the reader left scrolled up lands at its newest message and stays there as layout settles, until the reader moves", () => {
  const chat = new ChatPreferences();
  chat.setAutoScroll(false);
  const { view, draw, box, feed, resized, seen } = mountMeasured(chat);
  box.scrollHeight = 2000;
  draw(msg("a1", "assistant", "Hello"));
  // The reader scrolls up to read, then leaves the chat.
  box.scrollTop = 300;
  feed.dispatchEvent(new Event("scroll"));
  expect(seen().atBottom).toBe(false);
  view.hide();

  // Back in the chat, with more content: it opens at the newest message.
  box.scrollHeight = 2600;
  draw(msg("a2", "assistant", "More"));
  expect(seen()).toEqual({ atBottom: true, jump: false, unseen: false });
  // An image decodes after the draw: still pinned, auto-scroll off or not.
  box.scrollHeight = 2900;
  resized();
  expect(seen()).toEqual({ atBottom: true, jump: false, unseen: false });

  // The reader wheels up and scrolls: now new content waits below.
  feed.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
  box.scrollTop = 1800;
  feed.dispatchEvent(new Event("scroll"));
  box.scrollHeight = 3300;
  resized();
  expect(box.scrollTop).toBe(1800);
  expect(seen()).toEqual({ atBottom: false, jump: true, unseen: true });
  view.dispose();
});

test("timestamps show the host time a message carries, none without one, and follow the setting live", () => {
  const chat = new ChatPreferences();
  chat.setTimestamps(true);
  const { view, draw } = mount(chat);
  const at = Date.UTC(2026, 8, 23, 9, 30);
  draw(msg("u1", "user", "timed", at), msg("u2", "user", "untimed"));
  const timed = message(view.node, "timed");
  const untimed = message(view.node, "untimed");
  expect(shownTime(timed)).toBe(new Date(at).toISOString());
  expect(shownTime(untimed)).toBeUndefined();

  chat.setTimestamps(false);
  expect(shownTime(timed)).toBeUndefined();
  chat.setTimestamps(true);
  expect(shownTime(timed)).toBe(new Date(at).toISOString());
  view.dispose();
});

test("new thinking and tool cards start as the settings say, and a reader's own toggle is never redrawn over", () => {
  const chat = new ChatPreferences();
  chat.setThinkingExpanded(true);
  const { view, draw } = mount(chat);
  draw(msg("t1", "thinking", "pondering"), tool("c1"));
  const thinking = view.node.querySelector("details.message-thinking");
  const card = view.node.querySelector("details.tool-card");
  if (!(thinking instanceof HTMLDetailsElement)) throw new Error("no thinking");
  if (!(card instanceof HTMLDetailsElement)) throw new Error("no tool card");
  expect(thinking.open).toBe(true);
  expect(card.open).toBe(false);

  // The reader opens the tool card themselves.
  card.querySelector("summary")?.click();
  card.open = true;
  chat.setToolOutputExpanded(false);
  draw(tool("c1"));
  expect(card.open).toBe(true);

  // Untouched cards follow a change; cards created after it start that way.
  chat.setThinkingExpanded(false);
  expect(thinking.open).toBe(false);
  chat.setToolOutputExpanded(true);
  draw(tool("c2"));
  const cards =
    view.node.querySelectorAll<HTMLDetailsElement>("details.tool-card");
  expect([...cards].map((node) => node.open)).toEqual([true, true]);
  view.dispose();
});

test("runs of tool calls fold into a closed group; a message ends a run, and the setting regroups live", () => {
  const chat = new ChatPreferences();
  const { view, draw } = mount(chat);
  draw(
    msg("u1", "user", "go"),
    tool("a1"),
    msg("t1", "thinking", "hmm"),
    tool("a2"),
    tool("a3"),
    msg("r1", "assistant", "halfway"),
    tool("b1"),
    tool("b2"),
  );
  const groups = (): HTMLDetailsElement[] => [
    ...view.node.querySelectorAll<HTMLDetailsElement>("details.tool-group"),
  ];
  const counts = (): string[] =>
    groups().map((g) => g.querySelector(".tool-name")?.textContent ?? "");
  // Thinking between calls stays inside the run; the reply ends it, and the
  // two calls after the reply are below the default of three.
  expect(counts()).toEqual(["3 tool calls"]);
  const [first] = groups();
  expect(first?.open).toBe(false);
  expect(first?.querySelectorAll("details.tool-card").length).toBe(3);
  expect(first?.querySelector(".message-thinking")).not.toBeNull();

  // A third call after the reply starts its own group.
  draw(tool("b3"));
  expect(counts()).toEqual(["3 tool calls", "3 tool calls"]);

  chat.setToolGrouping("5");
  expect(counts()).toEqual([]);
  expect(view.node.querySelectorAll("details.tool-card").length).toBe(6);
  chat.setToolGrouping("2");
  expect(counts()).toEqual(["3 tool calls", "3 tool calls"]);
  chat.setToolGrouping("off");
  expect(counts()).toEqual([]);
  view.dispose();
});

test("Settings > Chat saves each choice for the next load", () => {
  const history = new FakeHistory();
  const nav = installSessionHistory({
    history,
    select: () => {},
    onPopState: (handler) => history.onPop(handler),
  });
  const root = document.createElement("div");
  document.body.append(root);
  renderTree(root, [{ machineId: "m1", label: "m1", projects: [] }], {
    ...handlers,
    onOverlay: (close) => nav.overlay(close),
  });
  const settingsButton = [...root.querySelectorAll("button")].find(
    (node) =>
      (node.getAttribute("aria-label") ?? node.textContent) === "Settings",
  );
  settingsButton?.click();
  /** A control as assistive technology finds it: by its role and label. */
  const labelled = <T extends HTMLInputElement | HTMLSelectElement>(
    selector: string,
    label: string,
  ): T => {
    const match = [...root.querySelectorAll<T>(selector)].find(
      (node) => node.labels?.[0]?.textContent === label,
    );
    if (!match) throw new Error(`no ${selector} labelled "${label}"`);
    return match;
  };
  const turn = (label: string, on: boolean): void => {
    const toggle = labelled<HTMLInputElement>('input[role="switch"]', label);
    if (toggle.checked !== on) toggle.click();
  };
  const choose = (label: string, value: string): void => {
    const select = labelled<HTMLSelectElement>("select", label);
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
  turn("Auto-scroll", false);
  choose("Text size", "small");
  turn("Timestamps", true);
  turn("Expand thinking", true);
  turn("Expand tool output", true);
  choose("Group tool calls", "10");

  const saved = new ChatPreferences();
  expect([
    saved.autoScroll,
    saved.textSize,
    saved.timestamps,
    saved.thinkingExpanded,
    saved.toolOutputExpanded,
    saved.toolGrouping,
  ]).toEqual([false, "small", true, true, true, "10"]);
});

test("a system message shows as a collapsed notice card: its kind's label, a first-line preview, and the unwrapped body with no raw HTML", () => {
  const chat = new ChatPreferences();
  // Expanding tool output is about tool cards; notices still start closed.
  chat.setToolOutputExpanded(true);
  const { view, draw } = mount(chat);
  draw(
    {
      t: "msg",
      sessionId: "s1",
      phase: "end",
      msgId: "n1",
      role: "system",
      kind: "async-result",
      text: "<system-notice>\nBackground job bg_5 has completed.\n<img src=x onerror=alert(1)>\nEXIT=0\n</system-notice>",
    },
    msg("n2", "system", "Restart OMP to restore Queue and Steer."),
  );
  const cards = [
    ...view.node.querySelectorAll<HTMLDetailsElement>("details.notice-card"),
  ];
  expect(cards).toHaveLength(2);
  const [result, plain] = cards;
  if (!result || !plain) throw new Error("no notice cards");
  expect(result.open).toBe(false);
  const summary = (card: HTMLDetailsElement) => ({
    label: card.querySelector(".tool-name")?.textContent,
    preview: card.querySelector(".tool-detail")?.textContent,
  });
  expect(summary(result)).toEqual({
    label: "Background result",
    preview: "Background job bg_5 has completed.",
  });
  expect(summary(plain)).toEqual({
    label: "System",
    preview: "Restart OMP to restore Queue and Steer.",
  });
  const body = result.querySelector(".notice-body");
  expect(body?.textContent).not.toContain("system-notice");
  expect(body?.textContent).toContain("EXIT=0");
  // The HTML in the body reads as text; nothing is injected.
  expect(body?.querySelector("img")).toBeNull();
  expect(body?.textContent).toContain("<img src=x onerror=alert(1)>");
  view.dispose();
});
