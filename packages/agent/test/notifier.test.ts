import { expect, test } from "bun:test";
import {
  type ClientMessage,
  NotifyEnvelope,
  type NotifyNotice,
  type Scheduler,
  type SessionMeta,
  openNotice,
} from "@omp-remote/protocol";
import type { AgentDiagnostic } from "../src/diagnostics";
import { Notifier } from "../src/notifier";
import { NotifyPolicy } from "../src/notify-policy";

const key = crypto.getRandomValues(new Uint8Array(32));

/** Timers fire only when the test says so; their delays are kept. */
class ManualScheduler implements Scheduler {
  readonly #timers = new Set<{ fn: () => void; ms: number }>();
  setTimer(fn: () => void, ms: number): () => void {
    const timer = { fn, ms };
    this.#timers.add(timer);
    return () => {
      this.#timers.delete(timer);
    };
  }
  setInterval(): () => void {
    throw new Error("the notifier sets no interval");
  }
  /** The delays of the timers still pending. */
  delays(): number[] {
    return [...this.#timers].map((timer) => timer.ms);
  }
  /** Fire every pending timer, as if its delay passed. */
  fire(): void {
    const due = [...this.#timers];
    this.#timers.clear();
    for (const timer of due) timer.fn();
  }
}

function meta(id: string, title: string): SessionMeta {
  return {
    id,
    cwd: `/work/${id}`,
    project: "web",
    model: "m",
    title,
    pid: 1,
    startedAt: 0,
  };
}

/** A notifier on a fake link. No clock: idle time and timers are the test's. */
function harness(opts: { idle?: number | null; awaySec?: number } = {}) {
  let idle = opts.idle ?? null;
  let linkUp = true;
  const sent: string[] = [];
  const diagnostics: AgentDiagnostic[] = [];
  const scheduler = new ManualScheduler();
  const policy = new NotifyPolicy();
  if (opts.awaySec !== undefined) void policy.set(opts.awaySec);
  const notifier = new Notifier({
    machineId: "m1",
    key,
    send: (notice) => {
      if (linkUp) sent.push(notice);
      return linkUp;
    },
    policy,
    idleMs: () => idle,
    scheduler,
    diagnostic: (event) => diagnostics.push(event),
  });
  notifier.start();
  notifier.observe({
    t: "sessions",
    sessions: [meta("s1", "Fix login"), meta("s2", "Refactor")],
  });
  return {
    notifier,
    scheduler,
    diagnostics,
    policy,
    feed(...frames: ClientMessage[]): void {
      for (const frame of frames) notifier.observe(frame);
    },
    setIdle(ms: number | null): void {
      idle = ms;
    },
    setLink(up: boolean): void {
      linkUp = up;
    },
    /** Every notice sent so far, opened as the phone opens them. */
    async notices(): Promise<NotifyNotice[]> {
      await notifier.settled();
      return Promise.all(
        sent.map((line) =>
          openNotice(key, NotifyEnvelope.parse(JSON.parse(line))),
        ),
      );
    },
  };
}

const reply: ClientMessage = {
  t: "msg",
  sessionId: "s1",
  phase: "end",
  msgId: "a1",
  role: "assistant",
  text: "All tests pass.",
};
const settledIdle: ClientMessage = {
  t: "attention",
  sessionId: "s1",
  reason: "idle",
};
const running: ClientMessage = {
  t: "state",
  sessionId: "s1",
  model: "m",
  streaming: true,
  title: "Fix login",
};
const question: ClientMessage = {
  t: "interaction",
  sessionId: "s1",
  id: "q1",
  payload: {
    kind: "ask",
    questions: [
      { question: "Deploy to production?" },
      { question: "Which region?" },
    ],
  },
};
const questionEnded: ClientMessage = {
  t: "interactionEnd",
  sessionId: "s1",
  id: "q1",
  reason: "cancelled",
};
const idleNotice: NotifyNotice = {
  kind: "attention",
  sessionId: "s1",
  reason: "idle",
  title: "Fix login",
  project: "web",
  detail: "All tests pass.",
};
const questionNotice: NotifyNotice = {
  kind: "attention",
  sessionId: "s1",
  reason: "question",
  title: "Fix login",
  project: "web",
  detail: "Deploy to production?",
};
const cleared: NotifyNotice = { kind: "clear", sessionId: "s1" };

test("a need raised while the user is at the machine waits, then pushes once they have been away long enough", async () => {
  const h = harness({ idle: 30_000, awaySec: 120 });
  h.feed(reply, settledIdle);
  expect(await h.notices()).toEqual([]);
  expect(h.diagnostics).toEqual([
    {
      event: "notify_push_deferred",
      sessionId: "s1",
      reason: "idle",
      code: "user-present",
      awaySec: 120,
    },
  ]);
  // Idle time only grows while the user stays away: 90 s from now is the
  // soonest it can reach 120 s.
  expect(h.scheduler.delays()).toEqual([90_000]);

  // They touched the machine meanwhile: still present, so it looks again later.
  h.setIdle(5_000);
  h.scheduler.fire();
  expect(await h.notices()).toEqual([]);
  expect(h.scheduler.delays()).toEqual([115_000]);

  h.setIdle(120_000);
  h.scheduler.fire();
  expect(await h.notices()).toEqual([idleNotice]);
  expect(h.scheduler.delays()).toEqual([]);
  // The wait was reported once, the push once.
  expect(h.diagnostics.slice(1)).toEqual([
    { event: "notify_push_sent", sessionId: "s1", reason: "idle" },
  ]);
});

test("a need answered at the machine before the user is away never pushes", async () => {
  const h = harness({ idle: 10_000, awaySec: 120 });
  // The question is answered at the desk; then, once idle, the user prompts
  // again and the loop runs.
  h.feed(question, questionEnded, reply, settledIdle, running);
  h.setIdle(600_000);
  h.scheduler.fire();
  expect(await h.notices()).toEqual([]);
  expect(h.scheduler.delays()).toEqual([]);
});

const answers: [string, ClientMessage[], (notifier: Notifier) => void][] = [
  [
    "the user writes to the session",
    [reply, settledIdle],
    (n) =>
      n.observe({
        t: "msg",
        sessionId: "s1",
        phase: "end",
        msgId: "u1",
        role: "user",
        text: "yes",
      }),
  ],
  [
    "its agent loop runs again",
    [reply, settledIdle],
    (n) => n.observe(running),
  ],
  [
    "its question is answered at the desk",
    [question],
    (n) => n.observe(questionEnded),
  ],
  [
    "the phone answers its question",
    [question],
    (n) =>
      n.command({
        t: "interactionReply",
        sessionId: "s1",
        id: "q1",
        response: { kind: "ask", answers: ["yes"] },
      }),
  ],
  [
    "the agent moves past its native approval",
    [{ t: "attention", sessionId: "s1", reason: "approval" }],
    (n) =>
      n.observe({
        t: "tool",
        sessionId: "s1",
        phase: "end",
        callId: "c1",
        name: "bash",
        status: "done",
        preview: "",
      }),
  ],
  [
    "the agent speaks again after its question",
    [question],
    (n) => n.observe({ ...reply, msgId: "a2", text: "Deployed." }),
  ],
  [
    "the session leaves the list",
    [reply, settledIdle],
    (n) => n.observe({ t: "sessions", sessions: [meta("s2", "Refactor")] }),
  ],
  [
    "the session says bye",
    [question],
    (n) => n.observe({ t: "bye", sessionId: "s1" }),
  ],
];

test.each(answers)(
  "a pushed notice is cleared when %s",
  async (_answer, need, answer) => {
    const h = harness();
    h.feed(...need);
    const [pushed] = await h.notices();
    if (pushed?.kind !== "attention") throw new Error("nothing was pushed");

    answer(h.notifier);
    expect(await h.notices()).toEqual([pushed, cleared]);
    expect(h.diagnostics.at(-1)).toEqual({
      event: "notify_push_cleared",
      sessionId: "s1",
    });
  },
);

test("an approval notice names the tool, with the reason when it has one", async () => {
  const h = harness();
  h.feed(
    {
      t: "interaction",
      sessionId: "s1",
      id: "ap1",
      payload: {
        kind: "approval",
        tool: "bash",
        reason: "deletes build/",
        choices: ["Approve", "Deny"],
      },
    },
    // A native approval names no tool: it holds the one running.
    {
      t: "tool",
      sessionId: "s2",
      phase: "start",
      callId: "c1",
      name: "edit",
      status: "running",
      preview: "",
    },
    { t: "attention", sessionId: "s2", reason: "approval" },
  );
  expect(await h.notices()).toEqual([
    {
      kind: "attention",
      sessionId: "s1",
      reason: "approval",
      title: "Fix login",
      project: "web",
      detail: "bash: deletes build/",
    },
    {
      kind: "attention",
      sessionId: "s2",
      reason: "approval",
      title: "Refactor",
      project: "web",
      detail: "edit",
    },
  ]);
});

const openGates: [string, number | null, number][] = [
  ["the user's presence is unknown", null, 120],
  ["the policy pushes always", 1_000, 0],
];

test.each(openGates)(
  "a need pushes at once when %s",
  async (_why, idle, awaySec) => {
    const h = harness({ idle, awaySec });
    h.feed(question);
    expect(await h.notices()).toEqual([questionNotice]);
    expect(h.scheduler.delays()).toEqual([]);
  },
);

test("the same need again pushes once; a newer need replaces it", async () => {
  const h = harness();
  h.feed(question);
  expect(await h.notices()).toEqual([questionNotice]);
  h.feed(question);
  expect(await h.notices()).toEqual([questionNotice]);

  h.feed({
    t: "interaction",
    sessionId: "s1",
    id: "ap1",
    payload: { kind: "approval", tool: "bash", choices: ["Approve", "Deny"] },
  });
  expect(await h.notices()).toEqual([
    questionNotice,
    { ...questionNotice, reason: "approval", detail: "bash" },
  ]);
});

test("lowering the away time releases a waiting need at once", async () => {
  const h = harness({ idle: 30_000, awaySec: 120 });
  h.feed(reply, settledIdle);
  expect(await h.notices()).toEqual([]);
  await h.policy.set(20);
  expect(await h.notices()).toEqual([idleNotice]);
  expect(h.scheduler.delays()).toEqual([]);
});

test("what the link could not carry while down is sent once it is back", async () => {
  const h = harness();
  h.setLink(false);
  h.feed(question);
  expect(await h.notices()).toEqual([]);
  h.setLink(true);
  h.notifier.resume();
  expect(await h.notices()).toEqual([questionNotice]);

  // Answered while the link is down again: the clear waits for it too.
  h.setLink(false);
  h.feed(questionEnded);
  expect(await h.notices()).toEqual([questionNotice]);
  h.setLink(true);
  h.notifier.resume();
  expect(await h.notices()).toEqual([questionNotice, cleared]);
});

test("a notice's text is cut to what the phone accepts", async () => {
  const h = harness();
  h.feed(
    { t: "sessions", sessions: [meta("s1", "T".repeat(200))] },
    { ...reply, text: "word ".repeat(100) },
    settledIdle,
  );
  // The phone parsed each against the contract's limits: cut, not dropped.
  const [notice] = await h.notices();
  if (notice?.kind !== "attention") throw new Error("no attention notice");
  expect(notice.title).toHaveLength(80);
  expect(notice.title.endsWith("…")).toBe(true);
  expect(notice.detail.startsWith("word word")).toBe(true);
  expect(notice.detail.endsWith("…")).toBe(true);
});
