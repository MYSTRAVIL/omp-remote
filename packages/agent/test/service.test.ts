import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClientMessage,
  Frame,
  HistoryFrame,
  InteractionFrame,
  InteractionReplyFrame,
  MediaChunkFrame,
  MediaInitFrame,
  MsgFrame,
  Scheduler,
  SessionMeta,
  UplinkFrame,
} from "@omp-remote/protocol";
import { type IpcConn, connectIpc } from "@omp-remote/protocol/ipc";
import { CollabHostFrameSchema } from "../src/collab/schema";
import { CollabTranslator } from "../src/collab/translate";
import type { AgentDiagnostic } from "../src/diagnostics";
import { AgentService } from "../src/service";
import {
  type SpawnOptions,
  type TerminalCommand,
  spawnSession,
} from "../src/spawn";
import { devClientSocket, testDevClient } from "./helpers/dev-client";

let svc: AgentService | undefined;
const roots: string[] = [];
afterEach(async () => {
  await svc?.stop();
  svc = undefined;
  setSystemTime();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A temp omp agent dir whose session store holds `sessions`. */
function sessionStore(sessions: { id: string; cwd: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), "omp-remote-store-"));
  roots.push(root);
  const dir = join(root, "sessions", "-proj");
  mkdirSync(dir, { recursive: true });
  for (const { id, cwd } of sessions)
    writeFileSync(
      join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
      `${JSON.stringify({ type: "title", v: 1, title: `title ${id}`, pad: "  " })}\n${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`,
    );
  return root;
}
const STORED_A = "aaaaaaaa-0000-4000-8000-000000000001";
const STORED_B = "bbbbbbbb-0000-4000-8000-000000000002";

function ipcAddr() {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-svc-${Math.random().toString(36).slice(2)}`
    : join(
        tmpdir(),
        `omp-remote-svc-${Math.random().toString(36).slice(2)}.sock`,
      );
}
const meta: SessionMeta = {
  id: "s1",
  cwd: "/x/p",
  project: "p",
  model: "m",
  title: "T",
  pid: 3,
  startedAt: 0,
};

function wsOpen(ws: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  ws.addEventListener("open", () => resolve(), { once: true });
  return promise;
}
function wsRecv(ws: WebSocket): Promise<ClientMessage> {
  const { promise, resolve } = Promise.withResolvers<ClientMessage>();
  ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data))), {
    once: true,
  });
  return promise;
}
async function awaitSessionListed(ws: WebSocket, id: string): Promise<void> {
  let snap = await wsRecv(ws);
  while (!(snap.t === "sessions" && snap.sessions.some((s) => s.id === id)))
    snap = await wsRecv(ws);
}

async function until(condition: () => boolean, steps = 50): Promise<void> {
  for (let step = 0; step < steps && !condition(); step++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("registered session appears in the client snapshot", async () => {
  const path = ipcAddr();
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
    devClient: testDevClient,
  });
  await svc.start();

  const session = await connectIpc(path, "tok");
  session.send({ t: "hello", token: "tok", session: meta });

  const ws = devClientSocket(svc.boundPort);
  await wsOpen(ws);
  await awaitSessionListed(ws, "s1");
  ws.close();
  session.close();
});

test("client prompt is routed to the owning session's IPC conn", async () => {
  const path = ipcAddr();
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
    devClient: testDevClient,
  });
  await svc.start();

  const session = await connectIpc(path, "tok");
  session.send({ t: "hello", token: "tok", session: meta });
  const { promise: gotDownlink, resolve } = Promise.withResolvers<Frame>();
  session.onFrame(resolve);

  const ws = devClientSocket(svc.boundPort);
  await wsOpen(ws);
  // Deterministic: once the client sees s1 in a snapshot, the hello has been
  // processed and the session's IPC conn is registered for routing.
  await awaitSessionListed(ws, "s1");
  ws.send(
    JSON.stringify({ t: "prompt", sessionId: "s1", text: "hi", mode: "steer" }),
  );

  expect(await gotDownlink).toEqual({
    t: "prompt",
    sessionId: "s1",
    text: "hi",
    mode: "steer",
  });
  ws.close();
  session.close();
});

test("a subscriber receives the initial snapshot, live snapshots, and relayed frames", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();

  const got: ClientMessage[] = [];
  const unsub = svc.subscribe((m) => got.push(m));
  // The initial push is a snapshot (empty session list here).
  expect(got).toEqual([{ t: "sessions", sessions: [] }]);

  const session = await connectIpc(path, "tok");
  session.send({ t: "hello", token: "tok", session: meta });
  // A registry change fans a fresh snapshot to the subscriber.
  const listed = Promise.withResolvers<void>();
  const relayed = Promise.withResolvers<ClientMessage>();
  svc.subscribe((m) => {
    if (m.t === "sessions" && m.sessions.some((s) => s.id === "s1"))
      listed.resolve();
    if (m.t === "msg") relayed.resolve(m);
  });
  await listed.promise;
  expect(got.some((m) => m.t === "sessions" && m.sessions.length === 1)).toBe(
    true,
  );

  // A bridge msg frame is relayed to subscribers as an object.
  session.send({
    t: "msg",
    sessionId: "s1",
    phase: "update",
    msgId: "m1",
    role: "assistant",
    text: "hi",
  });
  expect(await relayed.promise).toEqual({
    t: "msg",
    sessionId: "s1",
    phase: "update",
    msgId: "m1",
    role: "assistant",
    text: "hi",
    at: expect.any(Number),
  });

  unsub();
  session.close();
});

test("deliverDownlink routes a prompt to the owning session's IPC conn", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();

  const session = await connectIpc(path, "tok");
  session.send({ t: "hello", token: "tok", session: meta });
  const gotDownlink = Promise.withResolvers<Frame>();
  session.onFrame(gotDownlink.resolve);

  const listed = Promise.withResolvers<void>();
  const unsub = svc.subscribe((m) => {
    if (m.t === "sessions" && m.sessions.some((s) => s.id === "s1"))
      listed.resolve();
  });
  await listed.promise;

  svc.deliverDownlink({
    t: "prompt",
    sessionId: "s1",
    text: "go",
    mode: "steer",
  });
  expect(await gotDownlink.promise).toEqual({
    t: "prompt",
    sessionId: "s1",
    text: "go",
    mode: "steer",
  });

  // An unknown session is a no-op, not a crash.
  svc.deliverDownlink({ t: "interrupt", sessionId: "nope" });

  unsub();
  session.close();
});

test("serviceTier control routes to the IPC feed conn", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();

  const session = await connectIpc(path, "tok");
  session.send({ t: "hello", token: "tok", session: meta });
  const received = Promise.withResolvers<Frame>();
  session.onFrame(received.resolve);

  const listed = Promise.withResolvers<void>();
  const unsub = svc.subscribe((message) => {
    if (message.t === "sessions" && message.sessions.some((s) => s.id === "s1"))
      listed.resolve();
  });
  await listed.promise;

  svc.deliverDownlink({ t: "serviceTier", sessionId: "s1", enabled: true });

  expect(await received.promise).toMatchObject({
    t: "serviceTier",
    enabled: true,
  });
  unsub();
  session.close();
});

test("jobs frame from the bridge is relayed to clients", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();

  const received = Promise.withResolvers<ClientMessage>();
  const listed = Promise.withResolvers<void>();
  svc.subscribe((message) => {
    if (message.t === "jobs") received.resolve(message);
    if (message.t === "sessions" && message.sessions.some((s) => s.id === "s1"))
      listed.resolve();
  });
  const session = await connectIpc(path, "tok");
  session.send({ t: "hello", token: "tok", session: meta });
  await listed.promise;
  session.send({
    t: "jobs",
    sessionId: "s1",
    running: [
      { id: "j1", type: "task", label: "x", status: "running", startMs: 1 },
    ],
    recent: 0,
  });

  expect(await received.promise).toMatchObject({
    t: "jobs",
    sessionId: "s1",
  });
  session.close();
});
test("downlink media frames are relayed on the feed path", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();

  const received = Promise.withResolvers<ClientMessage>();
  const listed = Promise.withResolvers<void>();
  svc.subscribe((message) => {
    if (message.t === "mediaInit") received.resolve(message);
    if (message.t === "sessions" && message.sessions.some((s) => s.id === "s1"))
      listed.resolve();
  });

  const session = await connectIpc(path, "tok");
  session.send({ t: "hello", token: "tok", session: meta });
  await listed.promise;
  session.send({
    t: "mediaInit",
    sessionId: "s1",
    mediaId: "s1:0",
    anchor: { kind: "message", msgId: "a1" },
    mimeType: "image/png",
    size: 12,
    totalChunks: 1,
  });

  expect(await received.promise).toMatchObject({
    t: "mediaInit",
    sessionId: "s1",
    mediaId: "s1:0",
    anchor: { kind: "message", msgId: "a1" },
  });
  session.close();
});

test("a control failure from a feed bridge reaches clients", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();

  const received = Promise.withResolvers<ClientMessage>();
  const listed = Promise.withResolvers<void>();
  svc.subscribe((message) => {
    if (message.t === "controlError") received.resolve(message);
    if (message.t === "sessions" && message.sessions.some((s) => s.id === "s1"))
      listed.resolve();
  });
  const session = await connectIpc(path, "tok");
  session.send({ t: "hello", token: "tok", session: meta });
  await listed.promise;
  session.send({
    t: "controlError",
    sessionId: "s1",
    action: "compact",
    code: "control-failed",
    message: "Compaction failed.",
  });

  expect(await received.promise).toEqual({
    t: "controlError",
    sessionId: "s1",
    action: "compact",
    code: "control-failed",
    message: "Compaction failed.",
  });
  session.close();
});

test("downlink media frames are dropped on the prompt-control path", async () => {
  // Media travels only on the feed (Collab) path, not prompt-control.
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();

  // A subscriber that never sees the media frame proves it was dropped.
  let sawMedia = false;
  svc.subscribe((message) => {
    if (message.t === "mediaInit") sawMedia = true;
  });

  const control = await connectIpc(path, "tok");
  control.send({
    t: "hello",
    token: "tok",
    session: meta,
    role: "prompt-control",
  });
  control.send({
    t: "mediaInit",
    sessionId: "s1",
    mediaId: "s1:0",
    anchor: { kind: "message", msgId: "a1" },
    mimeType: "image/png",
    size: 12,
    totalChunks: 1,
  });

  // The frame is dropped, so sawMedia remains false.
  expect(sawMedia).toBe(false);
  control.close();
});

test("deliverDownlink launches a session on a spawn frame", async () => {
  const path = ipcAddr();
  const calls: Array<{
    cwd: string;
    model?: string;
    thinkingLevel?: string;
    approvalMode?: string;
    spawnId?: string;
  }> = [];
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
    spawn: (opts) => {
      calls.push({
        cwd: opts.cwd,
        model: opts.model,
        thinkingLevel: opts.thinkingLevel,
        approvalMode: opts.approvalMode,
        spawnId: opts.spawnId,
      });
      return { pid: 123, kill: () => {} };
    },
  });
  await svc.start();

  svc.deliverDownlink({
    t: "spawn",
    machineId: "m1",
    cwd: "/x/proj",
    model: "opus",
    thinkingLevel: "high",
    approvalMode: "yolo",
    spawnId: "spawn-nonce-1",
  });

  expect(calls).toEqual([
    {
      cwd: "/x/proj",
      model: "opus",
      thinkingLevel: "high",
      approvalMode: "yolo",
      spawnId: "spawn-nonce-1",
    },
  ]);
});

test("a spawn that fails asynchronously is logged and the agent keeps serving", async () => {
  const path = ipcAddr();
  const failed = Promise.withResolvers<AgentDiagnostic>();
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
    spawn: () => Promise.reject(new Error("ENOENT")),
    diagnostic: (event) => {
      if (event.event === "session_spawned") failed.resolve(event);
    },
  });
  await svc.start();

  svc.deliverDownlink({
    t: "spawn",
    machineId: "m1",
    cwd: "/x/proj",
    approvalMode: "write",
    spawnId: "spawn-nonce-2",
  });

  expect(await failed.promise).toEqual({
    event: "session_spawned",
    machineId: "m1",
    outcome: "failed",
    code: "spawn-failed",
  });
  // Still serving: a bridge can connect and gets listed.
  const listed = Promise.withResolvers<void>();
  svc.subscribe((m) => {
    if (m.t === "sessions" && m.sessions.some((s) => s.id === "s1"))
      listed.resolve();
  });
  const session = await connectIpc(path, "tok");
  session.send({ t: "hello", token: "tok", session: meta });
  await listed.promise;
  session.close();
});

test("a spawn frame carrying a command injection is reported failed and starts nothing", async () => {
  const failed = Promise.withResolvers<AgentDiagnostic>();
  const launched: TerminalCommand[] = [];
  svc = new AgentService({
    token: "tok",
    ipcPath: ipcAddr(),
    // The real spawn path; only the final process launch is recorded.
    spawn: (opts) =>
      spawnSession({
        ...opts,
        launch: async (command) => {
          launched.push(command);
          return { pid: 1, kill: () => {} };
        },
      }),
    diagnostic: (event) => {
      if (event.event === "session_spawned") failed.resolve(event);
    },
  });
  await svc.start();

  svc.deliverDownlink({
    t: "spawn",
    machineId: "m1",
    cwd: tmpdir(),
    model: "x&calc",
    approvalMode: "yolo",
    spawnId: "spawn-nonce-3",
  });

  expect(await failed.promise).toEqual({
    event: "session_spawned",
    machineId: "m1",
    outcome: "failed",
    code: "spawn-failed",
  });
  expect(launched).toEqual([]);
});

test("a historyRequest is answered with the cwd's stored sessions, minus the running ones", async () => {
  const path = ipcAddr();
  const agentDir = sessionStore([
    { id: STORED_A, cwd: "/x/p" },
    { id: STORED_B, cwd: "/x/p" },
    { id: "cccccccc-0000-4000-8000-000000000003", cwd: "/elsewhere" },
  ]);
  svc = new AgentService({ token: "tok", ipcPath: path, agentDir });
  await svc.start();
  // STORED_B is running now: its bridge is registered.
  const listed = Promise.withResolvers<void>();
  const history = Promise.withResolvers<HistoryFrame>();
  svc.subscribe((m) => {
    if (m.t === "sessions" && m.sessions.some((s) => s.id === STORED_B))
      listed.resolve();
    if (m.t === "history") history.resolve(m);
  });
  const session = await connectIpc(path, "tok");
  session.send({
    t: "hello",
    token: "tok",
    session: { ...meta, id: STORED_B },
  });
  await listed.promise;

  svc.deliverDownlink({ t: "historyRequest", cwd: "/x/p" });

  const answer = await history.promise;
  expect(answer.cwd).toBe("/x/p");
  expect(answer.entries.map((e) => [e.sessionId, e.title])).toEqual([
    [STORED_A, `title ${STORED_A}`],
  ]);
  session.close();
});

test("a history listing that fails answers with no entries and a diagnostic", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-remote-store-"));
  roots.push(root);
  // `sessions` is a file, so the store cannot be listed.
  writeFileSync(join(root, "sessions"), "");
  const failed = Promise.withResolvers<AgentDiagnostic>();
  svc = new AgentService({
    token: "tok",
    ipcPath: ipcAddr(),
    agentDir: root,
    diagnostic: (event) => {
      if (event.event === "history_failed") failed.resolve(event);
    },
  });
  await svc.start();
  const history = Promise.withResolvers<HistoryFrame>();
  svc.subscribe((m) => {
    if (m.t === "history") history.resolve(m);
  });

  svc.deliverDownlink({ t: "historyRequest", cwd: "C:\\x\\p" });

  expect(await history.promise).toEqual({
    t: "history",
    cwd: "C:\\x\\p",
    entries: [],
  });
  expect(await failed.promise).toEqual({
    event: "history_failed",
    code: "list-failed",
  });
});

test("a resume spawn launches only a session the store holds for that cwd", async () => {
  const agentDir = sessionStore([
    { id: STORED_A, cwd: "/x/p" },
    { id: STORED_B, cwd: "/other" },
  ]);
  const calls: SpawnOptions[] = [];
  const outcomes: AgentDiagnostic[] = [];
  const settled = Promise.withResolvers<void>();
  svc = new AgentService({
    token: "tok",
    ipcPath: ipcAddr(),
    agentDir,
    spawn: (opts) => {
      calls.push(opts);
      return { pid: 1, kill: () => {} };
    },
    diagnostic: (event) => {
      if (event.event !== "session_spawned") return;
      outcomes.push(event);
      if (outcomes.length === 3) settled.resolve();
    },
  });
  await svc.start();
  const spawn = {
    t: "spawn",
    machineId: "m1",
    cwd: "/x/p",
    approvalMode: "write",
  } as const;

  // Another project's session, and an id the store never held: refused.
  svc.deliverDownlink({ ...spawn, spawnId: "n1", resume: STORED_B });
  svc.deliverDownlink({
    ...spawn,
    spawnId: "n2",
    resume: "dddddddd-0000-4000-8000-000000000004",
  });
  svc.deliverDownlink({
    ...spawn,
    spawnId: "n3",
    model: "opus",
    resume: STORED_A,
  });
  await settled.promise;

  expect(calls.map((c) => [c.spawnId, c.resume])).toEqual([["n3", STORED_A]]);
  const refused: AgentDiagnostic = {
    event: "session_spawned",
    machineId: "m1",
    outcome: "failed",
    code: "resume-not-found",
  };
  expect(
    outcomes.filter(
      (e) => e.event === "session_spawned" && e.outcome === "failed",
    ),
  ).toEqual([refused, refused]);
});

test("prompt control registered before Collab stays out of the session feed", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();

  const control = await connectIpc(path, "tok");
  const ready = Promise.withResolvers<void>();
  const promptFrames: Frame[] = [];
  const gotPrompts = Promise.withResolvers<void>();
  control.onFrame((frame) => {
    if (frame.t === "promptControlReady") ready.resolve();
    if (frame.t === "prompt") {
      promptFrames.push(frame);
      if (promptFrames.length === 2) gotPrompts.resolve();
    }
  });
  control.send({
    t: "hello",
    token: "tok",
    role: "prompt-control",
    session: meta,
  });
  await ready.promise;
  expect(svc.snapshot()).toEqual({ t: "sessions", sessions: [] });

  const collabFrames: Frame[] = [];
  const registration = svc.registerCollabSession(meta, (frame) =>
    collabFrames.push(frame),
  );
  expect(svc.snapshot()).toEqual({ t: "sessions", sessions: [meta] });

  svc.deliverDownlink({
    t: "prompt",
    sessionId: meta.id,
    text: "queue",
    mode: "followUp",
  });
  svc.deliverDownlink({
    t: "prompt",
    sessionId: meta.id,
    text: "steer",
    mode: "steer",
  });
  expect(collabFrames).toEqual([]);
  await gotPrompts.promise;
  expect(promptFrames).toEqual([
    {
      t: "prompt",
      sessionId: meta.id,
      text: "queue",
      mode: "followUp",
    },
    {
      t: "prompt",
      sessionId: meta.id,
      text: "steer",
      mode: "steer",
    },
  ]);

  svc.deliverDownlink({ t: "interrupt", sessionId: meta.id });
  expect(collabFrames).toEqual([{ t: "interrupt", sessionId: meta.id }]);
  registration.close();
  control.close();
});

test("closing a superseded collab registration keeps the newer one listed and routed", () => {
  // A restarted omp process re-hosts the same session id; the controller
  // attaches the new room before reaping the old adapter.
  svc = new AgentService({ token: "tok", ipcPath: ipcAddr() });
  const stale = svc.registerCollabSession(meta, () => {});
  const current: Frame[] = [];
  const restarted = { ...meta, pid: 4 };
  svc.registerCollabSession(restarted, (frame) => current.push(frame));

  stale.close();

  expect(svc.snapshot()).toEqual({ t: "sessions", sessions: [restarted] });
  svc.deliverDownlink({ t: "interrupt", sessionId: meta.id });
  expect(current).toEqual([{ t: "interrupt", sessionId: meta.id }]);
});

/** Timers fire only when the test calls `fire()`. */
function manualScheduler() {
  const timers = new Set<() => void>();
  const scheduler: Scheduler = {
    setTimer(fn) {
      timers.add(fn);
      return () => timers.delete(fn);
    },
    setInterval() {
      return () => {};
    },
  };
  const fire = () => {
    const due = [...timers];
    timers.clear();
    for (const fn of due) fn();
  };
  return { scheduler, fire };
}

async function openPromptControl(
  path: string,
  session: SessionMeta,
  capabilities?: string[],
) {
  const control = await connectIpc(path, "tok");
  const ready = Promise.withResolvers<void>();
  control.onFrame((frame) => {
    if (frame.t === "promptControlReady") ready.resolve();
  });
  control.send({
    t: "hello",
    token: "tok",
    role: "prompt-control",
    session,
    ...(capabilities ? { capabilities } : {}),
  });
  await ready.promise;
  return control;
}

/** Every frame a bridge conn receives, plus a wait for the first matching one. */
function inbox(conn: IpcConn) {
  const frames: Frame[] = [];
  const waiters = new Set<{
    match: (f: Frame) => boolean;
    resolve: (f: Frame) => void;
  }>();
  conn.onFrame((frame) => {
    frames.push(frame);
    for (const w of waiters) {
      if (!w.match(frame)) continue;
      waiters.delete(w);
      w.resolve(frame);
    }
  });
  const next = (match: (f: Frame) => boolean): Promise<Frame> => {
    const already = frames.find(match);
    if (already) return Promise.resolve(already);
    const { promise, resolve } = Promise.withResolvers<Frame>();
    waiters.add({ match, resolve });
    return promise;
  };
  return { frames, next };
}

test("a jobs frame from a prompt-control bridge is relayed to clients", async () => {
  // Collab carries no async-job snapshot; the prompt-control bridge supplies it.
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();
  const received = Promise.withResolvers<ClientMessage>();
  svc.subscribe((message) => {
    if (message.t === "jobs") received.resolve(message);
  });
  const control = await openPromptControl(path, meta);
  const jobs: Frame = {
    t: "jobs",
    sessionId: "s1",
    running: [
      { id: "bg_5", type: "bash", label: "x", status: "running", startMs: 1 },
    ],
    recent: 2,
  };
  control.send(jobs);

  expect(await received.promise).toEqual(jobs);
  control.close();
});

test.each([
  ["prompt-control", true],
  ["feed", false],
] as const)(
  "closeSession reaches a capable %s bridge",
  async (_role, promptControl) => {
    const path = ipcAddr();
    svc = new AgentService({ token: "tok", ipcPath: path });
    await svc.start();
    const errors: ClientMessage[] = [];
    svc.subscribe((message) => {
      if (message.t === "controlError") errors.push(message);
    });
    let bridge: IpcConn;
    if (promptControl) {
      bridge = await openPromptControl(path, meta, ["closeSession"]);
    } else {
      const listed = Promise.withResolvers<void>();
      const unsubscribe = svc.subscribe((m) => {
        if (m.t === "sessions" && m.sessions.some((s) => s.id === meta.id))
          listed.resolve();
      });
      bridge = await connectIpc(path, "tok");
      bridge.send({
        t: "hello",
        token: "tok",
        session: meta,
        capabilities: ["closeSession"],
      });
      await listed.promise;
      unsubscribe();
    }
    const got = inbox(bridge);

    svc.deliverDownlink({ t: "closeSession", sessionId: "s1" });

    expect(await got.next((f) => f.t === "closeSession")).toEqual({
      t: "closeSession",
      sessionId: "s1",
    });
    expect(errors).toEqual([]);
    bridge.close();
  },
);

test("closeSession is withheld from a bridge without the capability and the phone is told why", async () => {
  const path = ipcAddr();
  const diagnostics: AgentDiagnostic[] = [];
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
    diagnostic: (event) => diagnostics.push(event),
  });
  await svc.start();
  const error = Promise.withResolvers<ClientMessage>();
  svc.subscribe((message) => {
    if (message.t === "controlError") error.resolve(message);
  });
  // An older bridge: no capabilities in its hello. Its decoder would drop the
  // socket on an unknown frame type.
  const control = await openPromptControl(path, meta);
  const got = inbox(control);

  svc.deliverDownlink({ t: "closeSession", sessionId: "s1" });

  expect(await error.promise).toEqual({
    t: "controlError",
    sessionId: "s1",
    action: "closeSession",
    code: "close-unsupported",
    message:
      "This session's remote bridge is too old to end it from the phone. Restart OMP once to enable End session.",
  });
  // Frames arrive in order: once a later prompt lands, a closeSession sent
  // before it would already be in the inbox.
  svc.deliverDownlink({
    t: "prompt",
    sessionId: "s1",
    text: "still here",
    mode: "steer",
  });
  await got.next((f) => f.t === "prompt");
  expect(got.frames.map((f) => f.t)).not.toContain("closeSession");
  expect(diagnostics).toContainEqual({
    event: "control_outcome",
    action: "closeSession",
    sessionId: "s1",
    route: "ipc-prompt-control",
    outcome: "rejected",
    execution: "unconfirmed",
    code: "close-unsupported",
  });
  control.close();
});

test("closeSession for a session with no bridge reports close-unsupported", () => {
  svc = new AgentService({ token: "tok", ipcPath: ipcAddr() });
  const errors: ClientMessage[] = [];
  svc.subscribe((message) => {
    if (message.t === "controlError") errors.push(message);
  });
  svc.registerCollabSession(meta, () => {});

  svc.deliverDownlink({ t: "closeSession", sessionId: "s1" });

  expect(errors).toMatchObject([
    { t: "controlError", action: "closeSession", code: "close-unsupported" },
  ]);
});

test("a running session with no transcript source is listed unreachable after the grace period", async () => {
  const path = ipcAddr();
  const { scheduler, fire } = manualScheduler();
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
    scheduler,
  });
  await svc.start();
  const control = await openPromptControl(path, meta);

  // Collab discovery normally attaches it within the grace period.
  expect(svc.snapshot()).toEqual({ t: "sessions", sessions: [] });
  fire();
  expect(svc.snapshot()).toEqual({
    t: "sessions",
    sessions: [{ ...meta, reachable: false }],
  });

  // A Collab room appears: listed normally.
  const registration = svc.registerCollabSession(meta, () => {});
  expect(svc.snapshot()).toEqual({ t: "sessions", sessions: [meta] });

  // The room goes away (host stopped) while omp still runs: unreachable again.
  registration.close();
  expect(svc.snapshot()).toEqual({
    t: "sessions",
    sessions: [{ ...meta, reachable: false }],
  });

  // omp exits: gone.
  control.close();
  await until(() => {
    const snap = svc?.snapshot();
    return snap?.t === "sessions" && snap.sessions.length === 0;
  });
  expect(svc.snapshot()).toEqual({ t: "sessions", sessions: [] });
});

test("replay backfills a fresh client with retained transcript and state", async () => {
  // A phone opening a session (or reconnecting) must see prior history and the
  // footer (effort/model), not an empty view, even for a session that streamed
  // before this client connected.
  const path = ipcAddr();
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
    devClient: testDevClient,
  });
  await svc.start();

  const registration = svc.registerCollabSession(meta, () => {});
  registration.emit({
    t: "msg",
    sessionId: meta.id,
    phase: "end",
    msgId: "u1",
    role: "user",
    text: "hi",
  });
  registration.emit({
    t: "msg",
    sessionId: meta.id,
    phase: "end",
    msgId: "a1",
    role: "assistant",
    text: "hello",
  });
  registration.emit({
    t: "state",
    sessionId: meta.id,
    model: "opus",
    thinkingLevel: "xhigh",
    streaming: false,
    title: "T",
  });

  const ws = devClientSocket(svc.boundPort);
  const frames: ClientMessage[] = [];
  const gotState = Promise.withResolvers<void>();
  ws.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data)) as ClientMessage;
    frames.push(frame);
    if (frame.t === "state") gotState.resolve();
  });
  await gotState.promise;

  expect(frames.find((f) => f.t === "sessions")).toEqual({
    t: "sessions",
    sessions: [meta],
  });
  expect(frames.flatMap((f) => (f.t === "msg" ? [f.text] : []))).toEqual([
    "hi",
    "hello",
  ]);
  expect(frames.find((f) => f.t === "state")).toMatchObject({
    model: "opus",
    thinkingLevel: "xhigh",
  });

  ws.close();
  registration.close();
});

test("the session list carries the live title so a fresh client paints it first", async () => {
  svc = new AgentService({ token: "tok", ipcPath: ipcAddr() });
  await svc.start();
  const untitled = { ...meta, title: "" };
  const registration = svc.registerCollabSession(untitled, () => {});
  const lists: ClientMessage[] = [];
  svc.subscribe((msg) => {
    if (msg.t === "sessions") lists.push(msg);
  });
  const state = {
    t: "state",
    sessionId: meta.id,
    model: "opus",
    streaming: false,
  } as const;

  registration.emit({ ...state, title: "Fix the login bug" });
  // The live list is re-broadcast with the title...
  const titled: ClientMessage = {
    t: "sessions",
    sessions: [{ ...untitled, title: "Fix the login bug" }],
  };
  expect(lists.at(-1)).toEqual(titled);
  // ...and a reconnecting client's backfill leads with it.
  expect(svc.replay()[0]).toEqual(titled);

  // An empty title (omp has not named it, or a synthetic lifecycle state)
  // never blanks a known title, and an unchanged title is not re-broadcast.
  const broadcasts = lists.length;
  registration.emit({ ...state, title: "" });
  registration.emit({ ...state, title: "Fix the login bug" });
  expect(lists.length).toBe(broadcasts);
  expect(svc.snapshot()).toEqual(titled);

  registration.close();
});

test("disconnecting prompt control preserves Collab and reports prompt failure", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();

  const collabFrames: Frame[] = [];
  const registration = svc.registerCollabSession(meta, (frame) =>
    collabFrames.push(frame),
  );
  const emitted: ClientMessage[] = [];
  const unsubscribe = svc.subscribe((frame) => emitted.push(frame));
  const control = await connectIpc(path, "tok");
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  control.onFrame((frame) => {
    if (frame.t === "promptControlReady") ready.resolve();
  });
  control.onClose(closed.resolve);
  control.send({
    t: "hello",
    token: "tok",
    role: "prompt-control",
    session: meta,
  });
  await ready.promise;
  control.close();
  await until(() => !svc?.hasPromptControl(meta.id));
  expect(svc.hasPromptControl(meta.id)).toBe(false);
  await closed.promise;

  expect(svc.snapshot()).toEqual({ t: "sessions", sessions: [meta] });
  svc.deliverDownlink({
    t: "prompt",
    sessionId: meta.id,
    text: "queue",
    mode: "followUp",
  });
  expect(collabFrames).toEqual([]);
  expect(emitted.at(-1)).toEqual({
    t: "controlError",
    sessionId: meta.id,
    action: "prompt",
    code: "prompt-control-unavailable",
    message:
      "Queue and Steer are unavailable for this session. Restart OMP to load the updated remote bridge, then try again.",
  });

  unsubscribe();
  registration.close();
});

test("an older prompt-control disconnect cannot evict its replacement", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();

  const collabFrames: Frame[] = [];
  const registration = svc.registerCollabSession(meta, (frame) =>
    collabFrames.push(frame),
  );
  const first = await connectIpc(path, "tok");
  const firstReady = Promise.withResolvers<void>();
  const firstClosed = Promise.withResolvers<void>();
  first.onFrame((frame) => {
    if (frame.t === "promptControlReady") firstReady.resolve();
  });
  first.onClose(firstClosed.resolve);
  first.send({
    t: "hello",
    token: "tok",
    role: "prompt-control",
    session: meta,
  });
  await firstReady.promise;

  const second = await connectIpc(path, "tok");
  const secondReady = Promise.withResolvers<void>();
  const secondPrompt = Promise.withResolvers<Frame>();
  second.onFrame((frame) => {
    if (frame.t === "promptControlReady") secondReady.resolve();
    if (frame.t === "prompt") secondPrompt.resolve(frame);
  });
  second.send({
    t: "hello",
    token: "tok",
    role: "prompt-control",
    session: meta,
  });
  await secondReady.promise;
  await firstClosed.promise;

  svc.deliverDownlink({
    t: "prompt",
    sessionId: meta.id,
    text: "after reconnect",
    mode: "steer",
  });
  expect(collabFrames).toEqual([]);
  expect(await secondPrompt.promise).toEqual({
    t: "prompt",
    sessionId: meta.id,
    text: "after reconnect",
    mode: "steer",
  });
  expect(svc.snapshot()).toEqual({ t: "sessions", sessions: [meta] });

  second.close();
  registration.close();
});

test("control diagnostics record prompt routes and modes without prompt bodies", async () => {
  const path = ipcAddr();
  const diagnostics: AgentDiagnostic[] = [];
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
    diagnostic: (event) => diagnostics.push(event),
  });
  await svc.start();

  const feed = await connectIpc(path, "tok");
  feed.send({ t: "hello", token: "tok", session: meta });
  const listed = Promise.withResolvers<void>();
  const unsubscribe = svc.subscribe((message) => {
    if (
      message.t === "sessions" &&
      message.sessions.some((session) => session.id === meta.id)
    )
      listed.resolve();
  });
  await listed.promise;

  svc.deliverDownlink({
    t: "prompt",
    sessionId: meta.id,
    text: "PRIVATE_FOLLOW_UP_BODY",
    mode: "followUp",
  });

  const control = await connectIpc(path, "tok");
  const ready = Promise.withResolvers<void>();
  control.onFrame((frame) => {
    if (frame.t === "promptControlReady") ready.resolve();
  });
  control.send({
    t: "hello",
    token: "tok",
    role: "prompt-control",
    session: meta,
  });
  await ready.promise;
  svc.deliverDownlink({
    t: "prompt",
    sessionId: meta.id,
    text: "PRIVATE_STEER_BODY",
    mode: "steer",
  });

  expect(
    diagnostics.filter((event) => event.event === "control_outcome"),
  ).toEqual([
    {
      event: "control_outcome",
      action: "prompt",
      sessionId: meta.id,
      mode: "followUp",
      route: "ipc-feed",
      outcome: "forwarded",
      execution: "unconfirmed",
    },
    {
      event: "control_outcome",
      action: "prompt",
      sessionId: meta.id,
      mode: "steer",
      route: "ipc-prompt-control",
      outcome: "forwarded",
      execution: "unconfirmed",
    },
  ]);
  expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_");

  unsubscribe();
  control.close();
  feed.close();
});

test("control diagnostics report rejected and Collab-routed controls", async () => {
  const path = ipcAddr();
  const diagnostics: AgentDiagnostic[] = [];
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
    diagnostic: (event) => diagnostics.push(event),
  });
  await svc.start();

  const registration = svc.registerCollabSession(meta, () => {});
  svc.deliverDownlink({
    t: "prompt",
    sessionId: meta.id,
    text: "PRIVATE_REJECTED_BODY",
    mode: "followUp",
  });
  svc.deliverDownlink({ t: "interrupt", sessionId: meta.id });
  svc.deliverDownlink({ t: "interrupt", sessionId: "missing-session" });

  expect(
    diagnostics.filter((event) => event.event === "control_outcome"),
  ).toEqual([
    {
      event: "control_outcome",
      action: "prompt",
      sessionId: meta.id,
      mode: "followUp",
      route: "none",
      outcome: "rejected",
      execution: "unconfirmed",
      code: "prompt-control-unavailable",
    },
    {
      event: "control_outcome",
      action: "interrupt",
      sessionId: meta.id,
      route: "collab",
      outcome: "forwarded",
      execution: "unconfirmed",
    },
    {
      event: "control_outcome",
      action: "interrupt",
      sessionId: "missing-session",
      route: "none",
      outcome: "rejected",
      execution: "unconfirmed",
      code: "session-not-found",
    },
  ]);
  expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_");
  registration.close();
});

test("a collab session's snapshot is enriched with the spawnId from the bridge hello", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();

  // The bridge's prompt-control hello carries the phone's spawn nonce...
  const control = await connectIpc(path, "tok");
  const ready = Promise.withResolvers<void>();
  control.onFrame((frame) => {
    if (frame.t === "promptControlReady") ready.resolve();
  });
  control.send({
    t: "hello",
    token: "tok",
    role: "prompt-control",
    session: { ...meta, spawnId: "nonce-1" },
  });
  await ready.promise;

  // ...while the collab controller registers the session with meta that has none.
  const registration = svc.registerCollabSession(meta, () => {});
  const snap = svc.snapshot();
  const listed = snap.t === "sessions" ? snap.sessions[0] : undefined;
  expect(listed?.id).toBe("s1");
  expect(listed?.spawnId).toBe("nonce-1");

  registration.close();
  control.close();
});

test("a collab tool-result image relays reassemblable media frames to a client", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();

  const media: UplinkFrame[] = [];
  svc.subscribe((m) => {
    if (m.t === "mediaInit" || m.t === "mediaChunk") media.push(m);
  });
  const registration = svc.registerCollabSession(meta, () => {});

  const translator = new CollabTranslator(meta.id);
  const png = Buffer.from([9, 8, 7, 6, 5]).toString("base64");
  const host = CollabHostFrameSchema.parse({
    t: "event",
    event: {
      type: "tool_execution_end",
      toolCallId: "call-x",
      toolName: "read",
      result: {
        content: [{ type: "image", data: png, mimeType: "image/png" }],
      },
    },
  });
  for (const frame of translator.host(host)) registration.emit(frame);

  expect(media.find((f) => f.t === "mediaInit")).toMatchObject({
    t: "mediaInit",
    sessionId: meta.id,
    anchor: { kind: "tool", callId: "call-x" },
    mimeType: "image/png",
  });
  const joined = media
    .filter((f) => f.t === "mediaChunk")
    .map((f) => (f.t === "mediaChunk" ? f.data : ""))
    .join("");
  expect(joined).toBe(png);
  registration.close();
});

/** One image as the relay path retains it: the live init, then two chunks. */
function image(mediaId: string) {
  const init: MediaInitFrame = {
    t: "mediaInit",
    sessionId: meta.id,
    mediaId,
    anchor: { kind: "tool", callId: "call-r" },
    mimeType: "image/png",
    size: 6,
    totalChunks: 2,
  };
  const chunks: MediaChunkFrame[] = ["AAAA", "BBBB"].map((data, index) => ({
    t: "mediaChunk",
    sessionId: meta.id,
    mediaId,
    index,
    data,
  }));
  return { init, chunks };
}

test("a replay announces retained images deferred and never carries their chunks", () => {
  svc = new AgentService({ token: "tok", ipcPath: ipcAddr() });
  const registration = svc.registerCollabSession(meta, () => {});
  const shot = image("s1:0");
  for (const frame of [shot.init, ...shot.chunks]) registration.emit(frame);

  // The phone paints a placeholder and fetches the bytes only when it needs them.
  expect(svc.replay()).toEqual([
    { t: "sessions", sessions: [meta] },
    { ...shot.init, deferred: true },
  ]);
  registration.close();
});

test("mediaFetch sends a retained image in full, and expired once it is gone", () => {
  svc = new AgentService({ token: "tok", ipcPath: ipcAddr() });
  const registration = svc.registerCollabSession(meta, () => {});
  const shot = image("s1:0");
  for (const frame of [shot.init, ...shot.chunks]) registration.emit(frame);
  const sent: ClientMessage[] = [];
  svc.subscribe((m) => sent.push(m));
  const fetch = {
    t: "mediaFetch",
    sessionId: meta.id,
    mediaId: "s1:0",
  } as const;

  let before = sent.length;
  svc.deliverDownlink(fetch);
  // The live init (not `deferred`: its chunks follow), then every chunk in order.
  expect(sent.slice(before)).toStrictEqual([shot.init, ...shot.chunks]);

  // The session retires its images; fetching one now says it expired.
  registration.emit({ t: "bye", sessionId: meta.id });
  before = sent.length;
  svc.deliverDownlink(fetch);
  expect(sent.slice(before)).toEqual([
    { t: "mediaError", sessionId: meta.id, mediaId: "s1:0", code: "expired" },
  ]);
  registration.close();
});

/** Resolve with the next msg frame the service relays. */
function nextMsg(service: AgentService): Promise<MsgFrame> {
  const { promise, resolve } = Promise.withResolvers<MsgFrame>();
  const unsubscribe = service.subscribe((m) => {
    if (m.t === "msg") resolve(m);
  });
  return promise.finally(unsubscribe);
}

/** Connect an IPC feed bridge for `meta` and wait until the service lists it. */
async function openFeed(service: AgentService, path: string) {
  const listed = Promise.withResolvers<void>();
  const unsubscribe = service.subscribe((m) => {
    if (m.t === "sessions" && m.sessions.some((s) => s.id === meta.id))
      listed.resolve();
  });
  const feed = await connectIpc(path, "tok");
  feed.send({ t: "hello", token: "tok", session: meta });
  await listed.promise;
  unsubscribe();
  return feed;
}

test("an IPC msg frame is stamped with the time the host first saw its message", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();
  const feed = await openFeed(svc, path);

  setSystemTime(1_000);
  let relayed = nextMsg(svc);
  feed.send({
    t: "msg",
    sessionId: meta.id,
    phase: "start",
    msgId: "m1",
    role: "assistant",
    text: "Hi",
  });
  expect((await relayed).at).toBe(1_000);

  // A later update of the same message keeps its first-seen time...
  setSystemTime(5_000);
  relayed = nextMsg(svc);
  feed.send({
    t: "msg",
    sessionId: meta.id,
    phase: "update",
    msgId: "m1",
    role: "assistant",
    text: "Hi there",
  });
  expect((await relayed).at).toBe(1_000);
  // ...and so does a reconnecting client's backfill.
  expect(svc.replay().find((m) => m.t === "msg")).toMatchObject({
    msgId: "m1",
    text: "Hi there",
    at: 1_000,
  });

  // A new message is stamped with its own first-seen time.
  relayed = nextMsg(svc);
  feed.send({
    t: "msg",
    sessionId: meta.id,
    phase: "end",
    msgId: "m2",
    role: "user",
    text: "Next",
  });
  expect((await relayed).at).toBe(5_000);
  feed.close();
});

test("an IPC msg frame that carries at keeps it, and its updates inherit it", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();
  const feed = await openFeed(svc, path);
  setSystemTime(9_000);

  let relayed = nextMsg(svc);
  feed.send({
    t: "msg",
    sessionId: meta.id,
    phase: "start",
    msgId: "m1",
    role: "assistant",
    text: "Hi",
    at: 42,
  });
  expect((await relayed).at).toBe(42);

  relayed = nextMsg(svc);
  feed.send({
    t: "msg",
    sessionId: meta.id,
    phase: "end",
    msgId: "m1",
    role: "assistant",
    text: "Hi there",
  });
  expect((await relayed).at).toBe(42);
  feed.close();
});

const ask: InteractionFrame = {
  t: "interaction",
  sessionId: meta.id,
  id: "q1",
  payload: { kind: "ask", questions: [{ question: "Deploy now?" }] },
};

test("a replay re-asks pending interactions after the transcript until they settle", () => {
  svc = new AgentService({ token: "tok", ipcPath: ipcAddr() });
  const routed: Frame[] = [];
  const registration = svc.registerCollabSession(meta, (frame) =>
    routed.push(frame),
  );
  const said: MsgFrame = {
    t: "msg",
    sessionId: meta.id,
    phase: "end",
    msgId: "a1",
    role: "assistant",
    text: "Ready to deploy.",
    at: 1,
  };
  const approval: InteractionFrame = {
    t: "interaction",
    sessionId: meta.id,
    id: "q2",
    payload: { kind: "approval", tool: "bash", choices: ["allow", "deny"] },
  };
  const list: ClientMessage = { t: "sessions", sessions: [meta] };
  for (const frame of [said, ask, approval]) registration.emit(frame);
  expect(svc.replay()).toEqual([list, said, ask, approval]);

  // Settled without the phone (answered at the desk): no longer asked.
  registration.emit({
    t: "interactionEnd",
    sessionId: meta.id,
    id: "q1",
    reason: "resolved",
  });
  expect(svc.replay()).toEqual([list, said, approval]);

  // Answered from the phone: routed to the session, and not asked again even
  // though no interactionEnd follows.
  const reply: InteractionReplyFrame = {
    t: "interactionReply",
    sessionId: meta.id,
    id: "q2",
    response: { kind: "approval", decision: "allow" },
  };
  svc.deliverDownlink(reply);
  expect(routed).toEqual([reply]);
  expect(svc.replay()).toEqual([list, said]);

  // A new question, then the session says bye: none of it is replayed.
  registration.emit(ask);
  registration.emit({ t: "bye", sessionId: meta.id });
  expect(svc.replay()).toEqual([list]);
  registration.close();
});

test("a restarted omp re-registering its session drops the dead process's questions", () => {
  svc = new AgentService({ token: "tok", ipcPath: ipcAddr() });
  const stale = svc.registerCollabSession(meta, () => {});
  stale.emit(ask);
  expect(svc.replay()).toContainEqual(ask);
  // The new process registers before the old adapter is reaped, so the old
  // registration's close finds itself replaced and clears nothing.
  const current = svc.registerCollabSession({ ...meta, pid: 4 }, () => {});
  stale.close();
  expect(svc.replay()).not.toContainEqual(ask);
  current.close();
});

test("a bridge that drops mid-question leaves nothing pending when its session returns", async () => {
  const path = ipcAddr();
  svc = new AgentService({ token: "tok", ipcPath: path });
  await svc.start();
  const feed = await openFeed(svc, path);
  const asked = Promise.withResolvers<void>();
  const gone = Promise.withResolvers<void>();
  const unsubscribe = svc.subscribe((m) => {
    if (m.t === "interaction") asked.resolve();
    if (m.t === "sessions" && m.sessions.length === 0) gone.resolve();
  });
  feed.send(ask);
  await asked.promise;
  expect(svc.replay()).toContainEqual(ask);

  // The bridge dies with the question open, and its answer waiter with it. The
  // same session returns on a new bridge that never asked anything.
  feed.close();
  await gone.promise;
  unsubscribe();
  const again = await openFeed(svc, path);
  expect(svc.replay()).toEqual([{ t: "sessions", sessions: [meta] }]);
  again.close();
});
