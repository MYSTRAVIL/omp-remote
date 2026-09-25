import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type SessionMeta,
  type SessionsFrame,
  UplinkFrame,
} from "@omp-remote/protocol";
import { ChatPreferences } from "../src/core/chat-preferences";
import { ComposerPreferences } from "../src/core/composer-preferences";
import { AppStore } from "../src/core/store";
import {
  type TranscriptState,
  emptyTranscript,
  reduceTranscript,
} from "../src/core/transcript";
import { SessionView } from "../src/ui/conversation";
import type { ControlHandlers } from "../src/ui/render";

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

const views: SessionView[] = [];
afterEach(() => {
  // Disposing stops the strip's elapsed-time ticker.
  for (const view of views.splice(0)) view.dispose();
  document.body.replaceChildren();
});

const META: SessionMeta = {
  id: "s1",
  cwd: "/p/alpha",
  project: "alpha",
  model: "host/model",
  title: "s1",
  pid: 1,
  startedAt: 1,
};

/** Handlers that record every `closeSession` the view asks for. */
function recordingHandlers(): {
  handlers: ControlHandlers;
  closed: string[];
} {
  const closed: string[] = [];
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
    onCloseSession: async (sessionId) => {
      closed.push(sessionId);
      return true;
    },
    onUpload: async () => "resource",
    onSpawn: async () => true,
    onCancelSpawn: () => {},
    onInteractionReply: async () => true,
    onRenameMachine: () => true,
  };
  return { handlers, closed };
}

/** A session view on screen, redrawn with `frames` folded into its transcript. */
function mount(meta: SessionMeta = META) {
  const { handlers, closed } = recordingHandlers();
  const view = new SessionView(
    meta,
    handlers,
    new ComposerPreferences(),
    new ChatPreferences(),
  );
  views.push(view);
  document.body.append(view.node);
  const transcript: TranscriptState = emptyTranscript();
  const draw = (...frames: UplinkFrame[]): void => {
    for (const frame of frames) reduceTranscript(transcript, frame);
    view.update(meta, transcript, handlers, [], { models: [], roles: [] });
  };
  return { view, draw, closed };
}

function tool(
  callId: string,
  name: string,
  phase: "start" | "end",
  title?: string,
): UplinkFrame {
  return {
    t: "tool",
    sessionId: "s1",
    phase,
    callId,
    name,
    status: phase === "end" ? "ok" : "running",
    preview: "",
    title,
  };
}

function streaming(on: boolean): UplinkFrame {
  return {
    t: "state",
    sessionId: "s1",
    model: "m",
    streaming: on,
    title: "s1",
  };
}

/** What the strip shows, row by row, or undefined while it is hidden. */
function strip(
  view: SessionView,
): { label: string; type: string; elapsed?: string }[] | undefined {
  const node = view.node.querySelector<HTMLElement>(".jobs-strip");
  if (!node) throw new Error("no jobs strip");
  if (node.hidden) return undefined;
  return [...node.querySelectorAll(".jobs-strip-row")].map((row) => {
    const elapsed = row.querySelector<HTMLElement>(".jobs-strip-elapsed");
    return {
      label: row.querySelector(".jobs-strip-label")?.textContent ?? "",
      type: row.querySelector(".jobs-strip-type")?.textContent ?? "",
      ...(elapsed && !elapsed.hidden ? { elapsed: elapsed.textContent } : {}),
    };
  });
}

function endButton(view: SessionView): HTMLButtonElement {
  const node = view.node.querySelector<HTMLButtonElement>(
    '.session-header button[title="End this session"]',
  );
  if (!node) throw new Error("no End session action");
  return node;
}

function confirm(view: SessionView): HTMLDialogElement {
  const node = view.node.querySelector<HTMLDialogElement>(
    "dialog.workspace-dialog",
  );
  if (!node) throw new Error("no confirm dialog");
  return node;
}

function dialogButton(dialog: HTMLDialogElement, label: string) {
  const match = [
    ...dialog.querySelectorAll<HTMLButtonElement>(".dialog-footer button"),
  ].find((node) => node.textContent === label);
  if (!match) throw new Error(`no "${label}" button`);
  return match;
}

test("the strip lists async jobs and running task calls, and hides when nothing runs", () => {
  const { view, draw } = mount();
  draw(streaming(true));
  expect(strip(view)).toBeUndefined();

  const startMs = Date.now() - 125_000;
  draw(
    {
      t: "jobs",
      sessionId: "s1",
      recent: 0,
      running: [
        {
          id: "j1",
          type: "bash",
          label: "bun test",
          status: "running",
          startMs,
        },
      ],
    },
    tool("c1", "task", "start", "Scout the reducer"),
    // Neither a finished task nor another running tool is running work here.
    tool("c2", "task", "end", "Already done"),
    tool("c3", "bash", "start", "ls"),
  );
  const rows = strip(view);
  expect(rows?.map(({ label, type }) => ({ label, type }))).toEqual([
    { label: "bun test", type: "bash" },
    { label: "Scout the reducer", type: "task" },
  ]);
  // Time since the job's start; the task call has no start time to count from.
  expect(rows?.[0]?.elapsed).toMatch(/^2m 0\ds$/);
  expect(rows?.[1]?.elapsed).toBeUndefined();

  // The strip sits outside the scrolling feed, above the composer.
  const node = view.node.querySelector(".jobs-strip");
  expect(node?.closest(".feed")).toBeNull();
  expect(node?.nextElementSibling?.classList.contains("composer")).toBe(true);

  draw(
    { t: "jobs", sessionId: "s1", recent: 1, running: [] },
    tool("c1", "task", "end"),
  );
  expect(strip(view)).toBeUndefined();
});

test("an ended session shows no running work", () => {
  const { view, draw } = mount();
  draw(tool("c1", "task", "start", "Scout"));
  expect(strip(view)).toHaveLength(1);
  draw({ t: "bye", sessionId: "s1" });
  expect(strip(view)).toBeUndefined();
});

test("confirming End session sends one closeSession for this session", () => {
  const { view, draw, closed } = mount();
  draw(streaming(true));
  endButton(view).click();
  const dialog = confirm(view);
  expect(dialog.open).toBe(true);
  // A running turn is named: ending the session stops it.
  expect(dialog.textContent).toContain("A turn is running");
  expect(closed).toEqual([]);

  dialogButton(dialog, "End session").click();
  expect(closed).toEqual(["s1"]);
  expect(dialog.open).toBe(false);
});

test("an idle session's confirm does not mention a running turn", () => {
  const { view, draw } = mount();
  draw(streaming(false));
  endButton(view).click();
  expect(confirm(view).textContent).not.toContain("A turn is running");
});

test("cancelling End session sends nothing", () => {
  const { view, draw, closed } = mount();
  draw(streaming(false));
  endButton(view).click();
  const dialog = confirm(view);
  dialogButton(dialog, "Cancel").click();
  expect(dialog.open).toBe(false);
  // Closing another way (Esc, back, the Close button) confirms nothing either.
  endButton(view).click();
  dialog.close();
  expect(closed).toEqual([]);
});

test("End session is offered only while the session can be reached and has not ended", () => {
  const { view, draw } = mount();
  draw(streaming(false));
  expect(endButton(view).hidden).toBe(false);
  draw({ t: "bye", sessionId: "s1" });
  expect(endButton(view).hidden).toBe(true);

  const unreachable = mount({ ...META, reachable: false });
  unreachable.draw(streaming(false));
  expect(endButton(unreachable.view).hidden).toBe(true);
});

test("a host that cannot close the session says so in the conversation", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  const sessions: SessionsFrame = { t: "sessions", sessions: [META] };
  store.applyFrame("m1", sessions);
  // The same schema every inbound frame is checked against.
  const frame = UplinkFrame.parse({
    t: "controlError",
    sessionId: "s1",
    action: "closeSession",
    code: "close-unsupported",
    message: "This omp session cannot be ended from the phone.",
  });
  store.applyFrame("m1", frame);
  const transcript = store.transcriptFor("s1");
  if (!transcript) throw new Error("no transcript");

  const { handlers } = recordingHandlers();
  const view = new SessionView(
    META,
    handlers,
    new ComposerPreferences(),
    new ChatPreferences(),
  );
  views.push(view);
  document.body.append(view.node);
  view.update(META, transcript, handlers, [], { models: [], roles: [] });
  expect(view.node.querySelector(".feed")?.textContent).toContain(
    "This omp session cannot be ended from the phone.",
  );
});

test("an ended session offers Continue, which asks to reopen it and says when it cannot", async () => {
  const asked: string[] = [];
  const answer = Promise.withResolvers<boolean>();
  const { handlers: base } = recordingHandlers();
  const handlers: ControlHandlers = {
    ...base,
    onContinue: (sessionId) => {
      asked.push(sessionId);
      return answer.promise;
    },
  };
  const view = new SessionView(
    META,
    handlers,
    new ComposerPreferences(),
    new ChatPreferences(),
  );
  views.push(view);
  document.body.append(view.node);
  const transcript = emptyTranscript();
  const draw = (): void =>
    view.update(META, transcript, handlers, [], { models: [], roles: [] });
  const button = (): HTMLButtonElement => {
    const found =
      view.node.querySelector<HTMLButtonElement>(".composer-continue");
    if (!found) throw new Error("no Continue button");
    return found;
  };
  draw();
  // A live session has nothing to continue.
  expect(button().hidden).toBe(true);
  reduceTranscript(transcript, { t: "bye", sessionId: "s1" });
  draw();
  expect(button().hidden).toBe(false);
  button().click();
  // One tap sends once, even when tapped again while it is on its way.
  button().click();
  expect(asked).toEqual(["s1"]);
  expect(button().disabled).toBe(true);
  answer.resolve(false);
  await answer.promise;
  expect(button().disabled).toBe(false);
  expect(view.node.querySelector(".composer-error")?.textContent).toContain(
    "Couldn't reach this session's machine",
  );
  // An unreachable session is still running: there is nothing to continue.
  view.update({ ...META, reachable: false }, emptyTranscript(), handlers, [], {
    models: [],
    roles: [],
  });
  expect(button().hidden).toBe(true);
});

test("without a host to answer, an ended session offers no Continue", () => {
  const { draw, view } = mount();
  draw({ t: "bye", sessionId: "s1" });
  expect(
    view.node.querySelector<HTMLButtonElement>(".composer-continue")?.hidden,
  ).toBe(true);
});
