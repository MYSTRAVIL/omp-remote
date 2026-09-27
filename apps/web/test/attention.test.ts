import { expect, test } from "bun:test";
import type {
  InteractionFrame,
  SealedFrame,
  SessionMeta,
  SessionsFrame,
} from "@omp-remote/protocol";
import { AppStore } from "../src/core/store";

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    id: "s",
    cwd: "/home/me/proj",
    project: "proj",
    model: "m",
    title: "T",
    pid: 1,
    startedAt: 0,
    ...over,
  };
}
const sessions = (list: SessionMeta[]): SessionsFrame => ({
  t: "sessions",
  sessions: list,
});

function interaction(
  sessionId: string,
  id: string,
  kind: "ask" | "approval" = "ask",
): InteractionFrame {
  return {
    t: "interaction",
    sessionId,
    id,
    payload:
      kind === "ask"
        ? { kind: "ask", questions: [{ question: "test?" }] }
        : { kind: "approval", tool: "bash", choices: ["allow", "deny"] },
  };
}
/** An interaction as a host that stamps its frames sends it: with its `at`. */
function stamped(sessionId: string, id: string, at: number): InteractionFrame {
  return { ...interaction(sessionId, id), at };
}
/** A wait as a host that stamps its frames sends it: with its `at`. */
function waitFrame(
  sessionId: string,
  at: number,
  reason: "idle" | "approval" = "idle",
): SealedFrame {
  return { t: "attention", sessionId, reason, at };
}
function state(sessionId: string, streaming = false): SealedFrame {
  return { t: "state", sessionId, model: "m", streaming, title: "T" };
}
function said(sessionId: string, role: string): SealedFrame {
  return {
    t: "msg",
    sessionId,
    phase: "end",
    msgId: `${role}-${sessionId}`,
    role,
    text: "words",
    at: 1,
  };
}
const toolStarted: SealedFrame = {
  t: "tool",
  sessionId: "s1",
  phase: "start",
  callId: "c1",
  name: "bash",
  status: "running",
  preview: "",
};
/** The bracket every replay comes in. */
const START: SealedFrame = { t: "replayStart" };
const END: SealedFrame = { t: "replayEnd" };

test("the badge counts listed sessions waiting on the user on every machine, and stays unset while a list is in doubt", () => {
  const store = new AppStore();
  expect(store.waitingCount()).toBeUndefined();
  store.setMachineList(["m1", "m2"]);
  // Both lists are on their way: waits may be missing.
  expect(store.waitingCount()).toBeUndefined();
  store.applyFrame(
    "m1",
    sessions([meta({ id: "a" }), meta({ id: "c" }), meta({ id: "idle" })]),
  );
  store.applyFrame("m2", sessions([meta({ id: "b" })]));
  expect(store.waitingCount()).toBe(0);

  store.applyFrame("m2", { t: "attention", sessionId: "b", reason: "idle" });
  store.applyFrame("m1", interaction("c", "c1", "approval"));
  store.applyFrame("m1", interaction("a", "a1"));
  // A second ask in a waiting session is still one session waiting.
  store.applyFrame("m1", interaction("c", "c2"));
  // An ask for a session no list carries yet has no row to open.
  store.applyFrame("m2", interaction("unlisted", "u1"));
  expect(store.waitingCount()).toBe(3);

  // Off the relay, a machine's asks go with it; its replay brings them back.
  store.setMachineList(["m2"]);
  expect(store.waitingCount()).toBe(1);
  store.setMachineList(["m1", "m2"]);
  store.applyFrame(
    "m1",
    sessions([meta({ id: "a" }), meta({ id: "c" }), meta({ id: "idle" })]),
  );
  store.applyFrame("m1", interaction("a", "a1"));
  expect(store.waitingCount()).toBe(2);
});

test("an ask answered at the desk while this phone was away is retired at replayEnd; a still-pending one stays", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  const list = sessions([meta({ id: "s1" }), meta({ id: "s2" })]);
  store.applyFrame("m1", list);
  store.applyFrame("m1", interaction("s1", "i1"));
  store.applyFrame("m1", interaction("s1", "i2"));
  store.applyFrame("m1", waitFrame("s2", 300));

  // The socket drops. Meanwhile i1 is answered at the desk and s2's turn is
  // taken; neither end reaches this phone. The replay, which this phone did
  // not have to ask for, carries only what is still pending.
  store.awaitSnapshots();
  store.applyFrame("m1", START);
  store.applyFrame("m1", list);
  store.applyFrame("m1", state("s1"));
  store.applyFrame("m1", interaction("s1", "i2"));
  store.applyFrame("m1", said("s2", "user"));
  // Until the end nothing is retired.
  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual([
    "i1",
    "i2",
  ]);
  expect(store.needsAttention("s2")).toBe(true);

  store.applyFrame("m1", END);
  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual(["i2"]);
  expect(store.needsAttention("s2")).toBe(false);
  expect(store.waitingCount()).toBe(1);
});

test("a live frame inside a replay applies as it would outside one", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  const list = sessions([meta({ id: "s1" }), meta({ id: "s2" })]);
  store.applyFrame("m1", list);
  store.applyFrame("m1", stamped("s1", "i1", 100));
  store.applyFrame("m1", stamped("s1", "i2", 110));
  store.applyFrame("m1", waitFrame("s2", 120));
  store.applyFrame("m1", START);
  store.applyFrame("m1", list);
  // Ended live: gone at once.
  store.applyFrame("m1", {
    t: "interactionEnd",
    sessionId: "s1",
    id: "i1",
    reason: "resolved",
  });
  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual(["i2"]);
  // Asked live: new since the replay began, so its end keeps it.
  store.applyFrame("m1", stamped("s1", "i3", 130));
  // A new wait live: it replaces the one shown from before, so the end keeps it.
  store.applyFrame("m1", waitFrame("s2", 140));
  store.applyFrame("m1", stamped("s1", "i2", 110));
  store.applyFrame("m1", END);
  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual([
    "i2",
    "i3",
  ]);
  expect(store.needsAttention("s2")).toBe(true);
});

test("replays never overlap: another phone's replay confirms again, one cut short gives way to the next, and a stray end changes nothing", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  const list = sessions([meta({ id: "s1" })]);
  store.applyFrame("m1", list);
  store.applyFrame("m1", stamped("s1", "i1", 100));
  const shown = () => store.pendingInteractions("s1").map((p) => p.id);

  store.applyFrame("m1", END);
  expect(shown()).toEqual(["i1"]);

  // Two phones syncing: the host sends one whole replay after the other.
  const whole = [START, list, stamped("s1", "i1", 100), END];
  for (const frame of [...whole, ...whole]) store.applyFrame("m1", frame);
  expect(shown()).toEqual(["i1"]);

  // A replay cut short (its host's socket dropped before the end) gives way
  // to the next, complete one, which no longer carries i1.
  for (const frame of [START, list, START, list, END])
    store.applyFrame("m1", frame);
  expect(shown()).toEqual([]);
});

test("a wait opened here stays seen when a replay re-sends it; a new wait shows again", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "s1" })]));
  store.applyFrame("m1", waitFrame("s1", 100));
  store.select("s1");
  store.select(undefined);
  store.applyFrame("m1", waitFrame("s1", 100));
  expect(store.needsAttention("s1")).toBe(false);
  // One flagged while the session is open is seen too.
  store.select("s1");
  store.applyFrame("m1", waitFrame("s1", 200));
  store.select(undefined);
  store.applyFrame("m1", waitFrame("s1", 200));
  expect(store.needsAttention("s1")).toBe(false);
  store.applyFrame("m1", waitFrame("s1", 300));
  expect(store.needsAttention("s1")).toBe(true);
});

test("a wait ends on the frames that settle its host's retained wait and clear its push", () => {
  const cases: [string, "idle" | "approval", SealedFrame[], boolean][] = [
    ["idle, then a user message", "idle", [said("s1", "user")], false],
    ["idle, then back at work", "idle", [state("s1", true)], false],
    ["idle, then a new question", "idle", [stamped("s1", "q9", 150)], false],
    ["idle, then its own words", "idle", [said("s1", "assistant")], true],
    ["idle, then a tool", "idle", [toolStarted], true],
    ["approval, then the tools move on", "approval", [toolStarted], false],
    [
      "approval, then the agent speaks",
      "approval",
      [said("s1", "assistant")],
      false,
    ],
    ["approval, still working", "approval", [state("s1", true)], true],
    [
      "approval, stopped then working again",
      "approval",
      [state("s1"), state("s1", true)],
      false,
    ],
  ];
  for (const [name, reason, after, kept] of cases) {
    const store = new AppStore();
    store.setMachineList(["m1"]);
    store.applyFrame("m1", sessions([meta({ id: "s1" })]));
    store.applyFrame("m1", state("s1", true));
    store.applyFrame("m1", waitFrame("s1", 100, reason));
    for (const frame of after) store.applyFrame("m1", frame);
    // Only the wait is asked about: answer any question the frames raised.
    for (const { id } of store.pendingInteractions("s1"))
      store.dismissInteraction("s1", id);
    expect([name, store.needsAttention("s1")]).toEqual([name, kept]);
  }
});
