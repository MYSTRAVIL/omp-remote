import { expect, test } from "bun:test";
import type {
  ModelCatalogFrame,
  SessionMeta,
  SessionsFrame,
} from "@omp-remote/protocol";
import { MachineCatalogs } from "../src/core/machine-catalogs";
import { AppStore } from "../src/core/store";

/** In-memory storage standing in for `localStorage`. */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

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
) {
  return {
    t: "interaction" as const,
    sessionId,
    id,
    payload:
      kind === "ask"
        ? { kind: "ask" as const, questions: [{ question: "test?" }] }
        : {
            kind: "approval" as const,
            tool: "bash",
            choices: ["allow", "deny"],
          },
  };
}
function interactionEnd(sessionId: string, id: string) {
  return {
    t: "interactionEnd" as const,
    sessionId,
    id,
    reason: "resolved" as const,
  };
}

test("a machine list creates an entry per connected machine (empty until its snapshot)", () => {
  const store = new AppStore();
  store.setMachineList(["m2", "m1"]);
  expect(store.tree().map((m) => m.machineId)).toEqual(["m1", "m2"]);
  expect(store.tree()[0]?.projects).toEqual([]);
});

test("a sessions snapshot replaces that machine's list and does not touch others", () => {
  const store = new AppStore();
  store.setMachineList(["m1", "m2"]);
  store.applyFrame("m1", sessions([meta({ id: "a", project: "p" })]));
  store.applyFrame("m2", sessions([meta({ id: "b", project: "q" })]));
  // A second snapshot for m1 REPLACES, never accumulates.
  store.applyFrame("m1", sessions([meta({ id: "c", project: "p" })]));

  const m1 = store.tree().find((m) => m.machineId === "m1");
  const m2 = store.tree().find((m) => m.machineId === "m2");
  expect(m1?.projects[0]?.sessions.map((s) => s.id)).toEqual(["c"]);
  expect(m2?.projects[0]?.sessions.map((s) => s.id)).toEqual(["b"]);
});

test("a machine that leaves the list stays in the tree offline, with its sessions and the selection", () => {
  const store = new AppStore();
  store.setMachineList(["m1", "m2"]);
  store.applyFrame("m1", sessions([meta({ id: "a" })]));
  store.select("a");
  store.setMachineList(["m2"]);
  expect(store.tree().map((m) => [m.machineId, m.offline === true])).toEqual([
    ["m1", true],
    ["m2", false],
  ]);
  expect(store.tree()[0]?.projects[0]?.sessions.map((s) => s.id)).toEqual([
    "a",
  ]);
  expect(store.selectedSession()?.id).toBe("a");
  expect(store.selectedMachineId()).toBe("m1");
});

test("an offline machine is back online on the next list that carries it, or on any frame from it", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a" })]));
  store.setMachineList([]);
  expect(store.tree()[0]?.offline).toBe(true);
  store.setMachineList(["m1"]);
  expect(store.tree()[0]?.offline).toBeUndefined();

  // A relay that never pushes the list again: the agent's replay shows it back.
  store.setMachineList([]);
  store.applyFrame("m1", sessions([meta({ id: "b" })]));
  const [machine] = store.tree();
  expect(machine?.offline).toBeUndefined();
  expect(machine?.projects[0]?.sessions.map((s) => s.id)).toEqual(["b"]);
});

test("selectedMachineId resolves the machine owning the selected session", () => {
  const store = new AppStore();
  store.setMachineList(["m1", "m2"]);
  store.applyFrame("m1", sessions([meta({ id: "a" })]));
  store.applyFrame("m2", sessions([meta({ id: "b" })]));
  expect(store.selectedMachineId()).toBeUndefined();
  store.select("b");
  expect(store.selectedMachineId()).toBe("m2");
  store.select("nope");
  expect(store.selectedMachineId()).toBeUndefined();
});

test("selection routes to a session and resolves its metadata; unknown ids resolve to undefined", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a", title: "Alpha" })]));
  expect(store.getState().selectedSessionId).toBeUndefined();

  store.select("a");
  expect(store.getState().selectedSessionId).toBe("a");
  expect(store.selectedSession()?.title).toBe("Alpha");

  store.select("ghost");
  expect(store.selectedSession()).toBeUndefined();

  store.select(undefined);
  expect(store.getState().selectedSessionId).toBeUndefined();
});

test("subscribers are notified on every mutation and can unsubscribe", () => {
  const store = new AppStore();
  let calls = 0;
  const unsub = store.subscribe(() => {
    calls += 1;
  });
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a" })]));
  store.select("a");
  expect(calls).toBe(3);
  unsub();
  store.select(undefined);
  expect(calls).toBe(3);
});

test("transcript frames build the session transcript without touching the tree", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a", project: "p" })]));
  const before = store.tree();
  store.applyFrame("m1", {
    t: "msg",
    sessionId: "a",
    phase: "start",
    msgId: "x",
    role: "assistant",
    text: "hi",
  });
  store.applyFrame("m1", {
    t: "state",
    sessionId: "a",
    model: "m",
    contextPct: 3,
    streaming: true,
    title: "T",
  });
  store.applyFrame("m1", {
    t: "controlError",
    sessionId: "a",
    action: "prompt",
    code: "prompt-control-unavailable",
    message: "Restart OMP to restore Queue and Steer.",
  });
  // The machine tree is untouched by non-snapshot frames...
  expect(store.tree()).toEqual(before);
  // ...but the session transcript now reflects them.
  const t = store.transcriptFor("a");
  expect(t?.entries[0]).toMatchObject({ kind: "message", text: "hi" });
  expect(t?.entries[1]).toMatchObject({
    kind: "message",
    role: "system",
    text: "Restart OMP to restore Queue and Steer.",
  });
  expect(t?.footer?.model).toBe("m");
  expect(store.transcriptFor("unknown")).toBeUndefined();
});

test("a jobs frame reaches the session transcript", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a" })]));
  store.applyFrame("m1", {
    t: "jobs",
    sessionId: "a",
    recent: 0,
    running: [
      { id: "j1", type: "task", label: "scout", status: "running", startMs: 0 },
    ],
  });
  expect(store.transcriptFor("a")?.jobs?.running).toHaveLength(1);
  expect(store.transcriptFor("a")?.jobs?.running[0]?.label).toBe("scout");
});

test("a system message keeps the notice kind its frame carries", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a" })]));
  const text =
    "<system-notice>\nBackground job bg_5 has completed.\nEXIT=0\n</system-notice>";
  store.applyFrame("m1", {
    t: "msg",
    sessionId: "a",
    phase: "end",
    msgId: "n1",
    role: "system",
    text,
    kind: "async-result",
  });
  store.applyFrame("m1", {
    t: "msg",
    sessionId: "a",
    phase: "end",
    msgId: "m1",
    role: "system",
    text: "Restart OMP to restore Queue and Steer.",
  });
  const entries = store.transcriptFor("a")?.entries ?? [];
  expect(entries[0]).toMatchObject({
    kind: "message",
    role: "system",
    noticeKind: "async-result",
    text,
  });
  expect(entries[1]).toMatchObject({ kind: "message", role: "system" });
  expect(entries[1]).not.toHaveProperty("noticeKind");
});

test("an optimistic prompt echo lands in the session transcript", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a" })]));
  store.addPendingPrompt("a", "steer now", "steer");
  const entries = store.transcriptFor("a")?.entries ?? [];
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    role: "user",
    text: "steer now",
    pending: "steer",
  });
});

test("the agent's echo reconciles the optimistic prompt in place", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a" })]));
  store.addPendingPrompt("a", "steer now", "steer");
  store.applyFrame("m1", {
    t: "msg",
    sessionId: "a",
    phase: "end",
    msgId: "u1",
    role: "user",
    text: "steer now",
  });
  const entries = store.transcriptFor("a")?.entries ?? [];
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ msgId: "u1", text: "steer now" });
});

test("the sessions tree tracks a session's live title and updates", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a", title: "" })]));
  // The title lands a few minutes in, via a state frame.
  store.applyFrame("m1", {
    t: "state",
    sessionId: "a",
    model: "m",
    streaming: true,
    title: "Real title",
  });
  expect(store.tree()[0]?.projects[0]?.sessions[0]?.title).toBe("Real title");
  // A later re-title updates the list too.
  store.applyFrame("m1", {
    t: "state",
    sessionId: "a",
    model: "m",
    streaming: false,
    title: "Updated title",
  });
  expect(store.tree()[0]?.projects[0]?.sessions[0]?.title).toBe(
    "Updated title",
  );
});

test("two sessions keep isolated transcripts", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", {
    t: "msg",
    sessionId: "a",
    phase: "end",
    msgId: "x",
    role: "assistant",
    text: "alpha",
  });
  store.applyFrame("m1", {
    t: "msg",
    sessionId: "b",
    phase: "end",
    msgId: "y",
    role: "assistant",
    text: "beta",
  });
  expect(store.transcriptFor("a")?.entries[0]).toMatchObject({ text: "alpha" });
  expect(store.transcriptFor("b")?.entries[0]).toMatchObject({ text: "beta" });
});

test("an attention frame flags the session; opening it clears the flag", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a" }), meta({ id: "b" })]));

  store.applyFrame("m1", { t: "attention", sessionId: "a", reason: "idle" });
  expect(store.needsAttention("a")).toBe(true);
  expect(store.needsAttention("b")).toBe(false);

  store.select("a");
  expect(store.needsAttention("a")).toBe(false);
});

test("an attention frame for the already-open session is not flagged", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a" })]));
  store.select("a");
  store.applyFrame("m1", {
    t: "attention",
    sessionId: "a",
    reason: "approval",
  });
  expect(store.needsAttention("a")).toBe(false);
});

test("pending interactions: a duplicate frame with the same id is ignored", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "s1" })]));

  const first = interaction("s1", "i1");
  store.applyFrame("m1", first);
  store.applyFrame("m1", first);
  store.applyFrame("m1", interaction("s1", "i2"));

  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual([
    "i1",
    "i2",
  ]);
});

test("pending interactions: concurrent requests queue per session in first-seen order", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "s1" }), meta({ id: "s2" })]));

  store.applyFrame("m1", interaction("s1", "i1"));
  store.applyFrame("m1", interaction("s2", "i3"));
  store.applyFrame("m1", interaction("s1", "i2"));

  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual([
    "i1",
    "i2",
  ]);
  expect(store.pendingInteractions("s2").map((p) => p.id)).toEqual(["i3"]);
  expect(store.pendingInteractions("unknown")).toEqual([]);
});

test("a pending interaction lights needsAttention and survives select", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "s1" })]));

  // A pending interaction lights the badge on its own — no attention frame needed.
  store.applyFrame("m1", interaction("s1", "i1"));
  expect(store.needsAttention("s1")).toBe(true);

  // Opening the session clears an ordinary attention flag, but the pending
  // interaction keeps needsAttention lit — the decision outlives a glance.
  store.applyFrame("m1", { t: "attention", sessionId: "s1", reason: "idle" });
  store.select("s1");
  expect(store.needsAttention("s1")).toBe(true);
  expect(store.pendingInteractions("s1").length).toBe(1);

  // Only dismissing the last pending interaction finally clears the badge.
  store.dismissInteraction("s1", "i1");
  expect(store.needsAttention("s1")).toBe(false);
});

test("interactionEnd removes exactly the named id (unknown id / wrong session are no-ops)", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "s1" })]));

  store.applyFrame("m1", interaction("s1", "i1"));
  store.applyFrame("m1", interaction("s1", "i2"));
  store.applyFrame("m1", interaction("s1", "i3"));

  store.applyFrame("m1", interactionEnd("s1", "i2"));
  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual([
    "i1",
    "i3",
  ]);

  store.applyFrame("m1", interactionEnd("s1", "unknown"));
  store.applyFrame("m1", interactionEnd("s2", "i1"));
  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual([
    "i1",
    "i3",
  ]);
});

test("interactionEnd from a non-owning machine cannot retire a request", () => {
  const store = new AppStore();
  store.setMachineList(["mA", "mB"]);
  store.applyFrame("mA", sessions([meta({ id: "s1" })]));
  store.applyFrame("mA", interaction("s1", "i1"));

  // A stale end relayed by a machine that does not own s1 must not remove it.
  store.applyFrame("mB", interactionEnd("s1", "i1"));
  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual(["i1"]);

  // The owning machine's end does retire it.
  store.applyFrame("mA", interactionEnd("s1", "i1"));
  expect(store.pendingInteractions("s1")).toEqual([]);
});

test("dismissInteraction removes exactly one id and only touches that session", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "s1" }), meta({ id: "s2" })]));

  store.applyFrame("m1", interaction("s1", "i1"));
  store.applyFrame("m1", interaction("s1", "i2"));
  store.applyFrame("m1", interaction("s2", "i3"));

  store.dismissInteraction("s1", "i1");
  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual(["i2"]);
  expect(store.pendingInteractions("s2").map((p) => p.id)).toEqual(["i3"]);

  // Unknown id and unknown session are both no-ops.
  store.dismissInteraction("s1", "unknown");
  store.dismissInteraction("unknown", "i2");
  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual(["i2"]);
});

test("a bye retires the session's pending interactions and attention flag", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "s1" }), meta({ id: "s2" })]));

  store.applyFrame("m1", { t: "attention", sessionId: "s1", reason: "idle" });
  store.applyFrame("m1", interaction("s1", "i1"));
  store.applyFrame("m1", interaction("s2", "i2"));

  store.applyFrame("m1", { t: "bye", sessionId: "s1" });

  expect(store.needsAttention("s1")).toBe(false);
  expect(store.pendingInteractions("s1")).toEqual([]);
  // A sibling session on the same machine is untouched.
  expect(store.pendingInteractions("s2").length).toBe(1);
});

test("an unrelated machine's snapshot or disconnect never drops another machine's pending", () => {
  const store = new AppStore();
  store.setMachineList(["mA", "mB"]);
  // A request for a session on mB arrives before mB has sent any snapshot, so
  // the session is not yet listed by any machine.
  store.applyFrame("mB", interaction("sB", "i1"));

  // mA snapshotting its own sessions must not touch mB's orphan request...
  store.applyFrame("mA", sessions([meta({ id: "sA" })]));
  expect(store.pendingInteractions("sB").map((p) => p.id)).toEqual(["i1"]);

  // ...and neither must mA disconnecting.
  store.setMachineList(["mB"]);
  expect(store.pendingInteractions("sB").map((p) => p.id)).toEqual(["i1"]);
});

test("a machine's own snapshot retires a pending request it no longer lists", () => {
  const store = new AppStore();
  store.setMachineList(["mA", "mB"]);
  // Both machines hold an orphan request that predates their snapshots.
  store.applyFrame("mA", interaction("sA", "i1"));
  store.applyFrame("mB", interaction("sB", "i2"));

  // mB's authoritative snapshot omits sB → its request is retired...
  store.applyFrame("mB", sessions([meta({ id: "other" })]));
  expect(store.pendingInteractions("sB")).toEqual([]);
  // ...while mA's untouched request lives on.
  expect(store.pendingInteractions("sA").map((p) => p.id)).toEqual(["i1"]);
});

test("a machine disconnect retires the pending it owned and keeps the rest", () => {
  const store = new AppStore();
  store.setMachineList(["m1", "m2"]);
  store.applyFrame("m1", sessions([meta({ id: "s1" })]));
  store.applyFrame("m2", sessions([meta({ id: "s2" })]));
  store.applyFrame("m1", interaction("s1", "i1"));
  store.applyFrame("m2", interaction("s2", "i2"));

  store.setMachineList(["m2"]);

  expect(store.pendingInteractions("s1")).toEqual([]);
  expect(store.pendingInteractions("s2").map((p) => p.id)).toEqual(["i2"]);
});

test("a forgotten machine leaves the tree with everything it owned; other machines stay", () => {
  const store = new AppStore();
  store.setMachineList(["m1", "m2"]);
  store.applyFrame("m1", sessions([meta({ id: "s1" })]));
  store.applyFrame("m2", sessions([meta({ id: "s2" })]));
  store.applyFrame("m1", {
    t: "msg",
    sessionId: "s1",
    phase: "start",
    msgId: "x",
    role: "assistant",
    text: "private",
  });
  store.applyFrame("m1", { t: "attention", sessionId: "s1", reason: "idle" });
  store.applyFrame("m1", interaction("s1", "i1"));
  store.applyFrame("m2", interaction("s2", "i2"));

  store.forgetMachine("m1");

  expect(store.tree().map((m) => m.machineId)).toEqual(["m2"]);
  expect(store.machineIdForSession("s1")).toBeUndefined();
  expect(store.transcriptFor("s1")).toBeUndefined();
  expect(store.needsAttention("s1")).toBe(false);
  expect(store.pendingInteractions("s2").map((p) => p.id)).toEqual(["i2"]);
});

test("machineIdForSession resolves the owner and undefined for an unknown session", () => {
  const store = new AppStore();
  store.setMachineList(["m1", "m2"]);
  store.applyFrame("m1", sessions([meta({ id: "s1" })]));
  store.applyFrame("m2", sessions([meta({ id: "s2" })]));

  expect(store.machineIdForSession("s1")).toBe("m1");
  expect(store.machineIdForSession("s2")).toBe("m2");
  expect(store.machineIdForSession("unknown")).toBeUndefined();
});

test("an interaction that predates its session's first snapshot survives once listed", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  // The request lands before m1 has listed the session at all.
  store.applyFrame("m1", interaction("s1", "i1"));
  // m1's first snapshot lists the session → the request is kept, not retired.
  store.applyFrame("m1", sessions([meta({ id: "s1" })]));
  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual(["i1"]);
});

test("snapshot cleanup is isolated: removing one session leaves its siblings' pending", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame(
    "m1",
    sessions([meta({ id: "s1" }), meta({ id: "s2" }), meta({ id: "s3" })]),
  );

  store.applyFrame("m1", interaction("s1", "i1"));
  store.applyFrame("m1", interaction("s2", "i2"));
  store.applyFrame("m1", interaction("s3", "i3"));

  // A fresh snapshot drops only s2.
  store.applyFrame("m1", sessions([meta({ id: "s1" }), meta({ id: "s3" })]));

  expect(store.pendingInteractions("s1").map((p) => p.id)).toEqual(["i1"]);
  expect(store.pendingInteractions("s2")).toEqual([]);
  expect(store.pendingInteractions("s3").map((p) => p.id)).toEqual(["i3"]);
});

test("beginSpawn shows a waiting spawn labelled by the cwd's last segment", () => {
  const store = new AppStore();
  store.beginSpawn({ machineId: "m1", cwd: "/home/me/proj/", spawnId: "n1" });
  const pending = store.pendingSpawn();
  expect(pending).toEqual({
    machineId: "m1",
    cwd: "/home/me/proj/",
    project: "proj",
    spawnId: "n1",
    status: "waiting",
  });
});

test("resolveSpawn matches the session carrying the spawn nonce, not others", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.beginSpawn({ machineId: "m1", cwd: "/x/p", spawnId: "n1" });
  // A session without the nonce (e.g. an adopted desk session) never matches.
  store.applyFrame("m1", sessions([meta({ id: "other" })]));
  expect(store.resolveSpawn()).toBeUndefined();
  // The spawned session registers carrying the nonce.
  store.applyFrame(
    "m1",
    sessions([meta({ id: "other" }), meta({ id: "new", spawnId: "n1" })]),
  );
  expect(store.resolveSpawn()).toBe("new");
});

test("failSpawn stops resolution even once the session appears; clearSpawn drops it", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.beginSpawn({ machineId: "m1", cwd: "/x/p", spawnId: "n1" });
  store.failSpawn();
  expect(store.pendingSpawn()?.status).toBe("failed");
  store.applyFrame("m1", sessions([meta({ id: "new", spawnId: "n1" })]));
  // A failed spawn no longer resolves — the user dismisses it explicitly.
  expect(store.resolveSpawn()).toBeUndefined();
  store.clearSpawn();
  expect(store.pendingSpawn()).toBeUndefined();
});

test("a resume spawn also resolves to the resumed session's own id on its machine", () => {
  const store = new AppStore();
  store.setMachineList(["m1", "m2"]);
  store.beginSpawn({
    machineId: "m1",
    cwd: "/x/p",
    spawnId: "n1",
    resume: "0badc0de-0000",
  });
  expect(store.pendingSpawn()?.resume).toBe("0badc0de-0000");
  // The same id on another machine is not the session this phone resumed.
  store.applyFrame("m2", sessions([meta({ id: "0badc0de-0000" })]));
  expect(store.resolveSpawn()).toBeUndefined();
  // omp keeps the stored id on resume, even where no nonce is echoed.
  store.applyFrame("m1", sessions([meta({ id: "0badc0de-0000" })]));
  expect(store.resolveSpawn()).toBe("0badc0de-0000");
});

test("a history answer is held per machine and project; clearing one leaves the others", () => {
  const store = new AppStore();
  let emits = 0;
  store.subscribe(() => {
    emits += 1;
  });
  const entry = { sessionId: "abcdef01", startedAt: 1, lastActiveAt: 2 };
  expect(store.historyFor("m1", "/x/p")).toBeUndefined();
  store.applyFrame("m1", { t: "history", cwd: "/x/p", entries: [entry] });
  store.applyFrame("m1", { t: "history", cwd: "/x/q", entries: [] });
  expect(emits).toBe(2);
  expect(store.historyFor("m1", "/x/p")).toEqual([entry]);
  expect(store.historyFor("m1", "/x/q")).toEqual([]);
  // Another machine's project of the same path is its own.
  expect(store.historyFor("m2", "/x/p")).toBeUndefined();
  // Asking again drops the old answer, so the list shows loading until the new one.
  store.clearHistory("m1", "/x/p");
  expect(store.historyFor("m1", "/x/p")).toBeUndefined();
  expect(store.historyFor("m1", "/x/q")).toEqual([]);
  store.forgetMachine("m1");
  expect(store.historyFor("m1", "/x/q")).toBeUndefined();
});

test("an ended session stays open after the host stops listing it, and comes back live when resumed", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  const ended = meta({ id: "s1", pid: 10, cwd: "/x/p" });
  store.applyFrame("m1", sessions([ended]));
  store.select("s1");
  store.applyFrame("m1", {
    t: "msg",
    sessionId: "s1",
    msgId: "u1",
    phase: "end",
    role: "user",
    text: "hi",
  });
  store.applyFrame("m1", { t: "bye", sessionId: "s1" });
  store.applyFrame("m1", sessions([]));
  // The tab stays on the ended session, and Continue knows where it ran.
  expect(store.selectedSession()?.id).toBe("s1");
  expect(store.endedSession("s1")).toEqual({ machineId: "m1", meta: ended });
  expect(store.transcriptFor("s1")?.ended).toBe(true);
  // A stale listing of the same process does not revive it.
  store.applyFrame("m1", sessions([ended]));
  expect(store.transcriptFor("s1")?.ended).toBe(true);
  // The resumed process (same id, new pid) is live again, its history kept.
  store.applyFrame("m1", sessions([{ ...ended, pid: 11 }]));
  expect(store.transcriptFor("s1")?.ended).toBe(false);
  expect(store.transcriptFor("s1")?.entries).toHaveLength(1);
  expect(store.endedSession("s1")).toBeUndefined();
});

test("a session never selected still revives when resumed from Past sessions", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "s1", pid: 10 })]));
  store.applyFrame("m1", { t: "bye", sessionId: "s1" });
  store.applyFrame("m1", sessions([]));
  expect(store.selectedSession()).toBeUndefined();
  store.applyFrame("m1", sessions([meta({ id: "s1", pid: 12 })]));
  expect(store.transcriptFor("s1")?.ended).toBe(false);
});

function catalog(
  sessionId: string,
  over: Partial<ModelCatalogFrame> = {},
): ModelCatalogFrame {
  return { t: "modelCatalog", sessionId, models: [], roles: [], ...over };
}

function model(id: string): ModelCatalogFrame["models"][number] {
  return { id, name: id, provider: id.split("/")[0] ?? id, efforts: [] };
}

test("a configured catalog is never downgraded by a later fallback catalog", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a" })]));
  store.applyFrame(
    "m1",
    catalog("a", {
      configured: true,
      models: [model("anthropic/opus-4-8")],
      roles: [{ role: "task", modelId: "q/w", effort: "low" }],
    }),
  );
  // A probe/early load emits a bare fallback — as configured:false AND as an
  // older bundle that omits the flag entirely. Neither may clobber the curated set.
  store.applyFrame(
    "m1",
    catalog("a", { configured: false, models: [model("x/y")] }),
  );
  store.applyFrame("m1", catalog("a", { models: [model("x/y")] }));
  const c = store.catalogFor("a");
  expect(c.models.map((m) => m.id)).toEqual(["anthropic/opus-4-8"]);
  expect(c.roles.map((r) => r.role)).toEqual(["task"]);
  expect(c.configured).toBe(true);
});

test("a fallback catalog applies with no configured one, then a configured one upgrades it", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a" })]));
  store.applyFrame(
    "m1",
    catalog("a", { configured: false, models: [model("x/y")] }),
  );
  expect(store.catalogFor("a").models.map((m) => m.id)).toEqual(["x/y"]);
  store.applyFrame(
    "m1",
    catalog("a", { configured: true, models: [model("a/b")] }),
  );
  expect(store.catalogFor("a").models.map((m) => m.id)).toEqual(["a/b"]);
  expect(store.catalogFor("a").configured).toBe(true);
});

test("media frames route through applyFrame to the tool card", () => {
  const store = new AppStore();
  store.setMachineList(["m1"]);
  store.applyFrame("m1", sessions([meta({ id: "a" })]));
  store.applyFrame("m1", {
    t: "tool",
    sessionId: "a",
    phase: "end",
    callId: "c1",
    name: "read",
    status: "done",
    preview: "image",
  });
  const raw = "AAECAwQ=";
  store.applyFrame("m1", {
    t: "mediaInit",
    sessionId: "a",
    mediaId: "c1:0",
    anchor: { kind: "tool", callId: "c1" },
    mimeType: "image/png",
    size: 5,
    totalChunks: 1,
  });
  store.applyFrame("m1", {
    t: "mediaChunk",
    sessionId: "a",
    mediaId: "c1:0",
    index: 0,
    data: raw,
  });
  const t = store.transcriptFor("a");
  const tool = t?.entries.find((e) => e.kind === "tool");
  const media = tool?.kind === "tool" ? tool.media?.[0] : undefined;
  expect(media?.status).toBe("ready");
  expect(media?.dataUrl).toBe(`data:image/png;base64,${raw}`);
});

test("a machine's catalog is cached from any of its sessions, kept across reloads, and dropped on forget", () => {
  const storage = memoryStorage();
  const store = new AppStore(Date.now, new MachineCatalogs(storage));
  store.applyFrame(
    "machine-a",
    sessions([meta({ id: "a1" }), meta({ id: "a2" })]),
  );
  store.applyFrame("machine-b", sessions([meta({ id: "b1" })]));
  expect(store.tree().every((m) => m.catalog === undefined)).toBe(true);

  store.applyFrame(
    "machine-a",
    catalog("a2", { models: [model("anthropic/opus")], configured: true }),
  );
  const byId = (s: AppStore, id: string) =>
    s.tree().find((m) => m.machineId === id)?.catalog;
  expect(byId(store, "machine-a")?.models.map((m) => m.id)).toEqual([
    "anthropic/opus",
  ]);
  expect(byId(store, "machine-b")).toBeUndefined();

  // A bare fallback catalog from another session never replaces a configured one.
  store.applyFrame(
    "machine-a",
    catalog("a1", { models: [model("x/fallback")] }),
  );
  expect(byId(store, "machine-a")?.models.map((m) => m.id)).toEqual([
    "anthropic/opus",
  ]);

  // A newer configured catalog does.
  store.applyFrame(
    "machine-a",
    catalog("a1", { models: [model("anthropic/sonnet")], configured: true }),
  );
  const reloaded = new AppStore(Date.now, new MachineCatalogs(storage));
  reloaded.applyFrame("machine-a", sessions([]));
  expect(byId(reloaded, "machine-a")?.models.map((m) => m.id)).toEqual([
    "anthropic/sonnet",
  ]);

  reloaded.forgetMachine("machine-a");
  const afterForget = new AppStore(Date.now, new MachineCatalogs(storage));
  afterForget.applyFrame("machine-a", sessions([]));
  expect(byId(afterForget, "machine-a")).toBeUndefined();
});
