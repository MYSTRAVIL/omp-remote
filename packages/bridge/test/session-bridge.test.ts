import { afterEach, expect, test } from "bun:test";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame, SessionMeta } from "@omp-remote/protocol";
import { IpcServer, connectIpc } from "@omp-remote/protocol/ipc";
import type { IpcConn } from "@omp-remote/protocol/ipc";
import type { BridgeDiagnostic } from "../src/diagnostics";
import { SessionBridge } from "../src/session-bridge";

let server: IpcServer | undefined;
let squatter: Server | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (squatter) {
    const closed = Promise.withResolvers<void>();
    squatter.close(() => closed.resolve());
    await closed.promise;
    squatter = undefined;
  }
});

function addr() {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-br-${Math.random().toString(36).slice(2)}`
    : join(
        tmpdir(),
        `omp-remote-br-${Math.random().toString(36).slice(2)}.sock`,
      );
}
const meta: SessionMeta = {
  id: "s1",
  cwd: "/x/p",
  project: "p",
  model: "m",
  title: "T",
  pid: 9,
  startedAt: 0,
};

test("sends hello then a queued state frame after connect", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const frames: Frame[] = [];
  const { promise: done, resolve } = Promise.withResolvers<void>();
  server.onConnection((conn: IpcConn) =>
    conn.onFrame((f) => {
      frames.push(f);
      if (frames.length === 2) resolve();
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  bridge.emitState({ model: "m", contextPct: 10, streaming: true, title: "T" });
  await bridge.start();
  await done;

  expect(frames[0]).toMatchObject({ t: "hello" });
  // Proven in the handshake; the token itself never goes on the wire.
  expect(frames[0]).not.toHaveProperty("token");
  expect(frames[1]).toMatchObject({
    t: "state",
    sessionId: "s1",
    contextPct: 10,
  });
  bridge.stop();
});

test("delivers a downlink prompt to onPrompt", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const { promise: connArrived, resolve: resolveConn } =
    Promise.withResolvers<IpcConn>();
  server.onConnection((conn) => resolveConn(conn));
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  const { promise: got, resolve } = Promise.withResolvers<string>();
  bridge.onPrompt((text) => resolve(text));
  await bridge.start();

  const serverConn = await connArrived;
  serverConn.send({
    t: "prompt",
    sessionId: "s1",
    text: "hello",
    mode: "steer",
  });

  expect(await got).toBe("hello");
  bridge.stop();
});

test("serviceTier inbound frame invokes the onServiceTier callback", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const arrived = Promise.withResolvers<IpcConn>();
  server.onConnection(arrived.resolve);
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  const enabled = Promise.withResolvers<boolean>();
  bridge.onServiceTier(enabled.resolve);
  await bridge.start();

  const conn = await arrived.promise;
  conn.send({ t: "serviceTier", sessionId: meta.id, enabled: true });

  expect(await enabled.promise).toBe(true);
  bridge.stop();
});

test("emitState forwards fastMode", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const received = Promise.withResolvers<Frame>();
  server.onConnection((conn) =>
    conn.onFrame((frame) => {
      if (frame.t === "state") received.resolve(frame);
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  await bridge.start();
  bridge.emitState({
    model: "m",
    streaming: false,
    title: "T",
    fastMode: true,
  });

  expect(await received.promise).toMatchObject({ t: "state", fastMode: true });
  bridge.stop();
});

test("emitJobs sends a jobs frame with projected running rows", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const received = Promise.withResolvers<Frame>();
  server.onConnection((conn) =>
    conn.onFrame((frame) => {
      if (frame.t === "jobs") received.resolve(frame);
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  await bridge.start();
  bridge.emitJobs({
    running: [
      { id: "j1", type: "task", label: "scout", status: "running", startMs: 1 },
    ],
    recent: 2,
  });

  expect(await received.promise).toMatchObject({
    t: "jobs",
    running: [{ id: "j1", type: "task", label: "scout" }],
    recent: 2,
  });
  bridge.stop();
});

test("prompt-control bridge identifies its role and preserves both prompt modes", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const gotHello = Promise.withResolvers<Frame>();
  server.onConnection((conn) =>
    conn.onFrame((frame) => {
      if (frame.t !== "hello") return;
      gotHello.resolve(frame);
      conn.send({
        t: "prompt",
        sessionId: meta.id,
        text: "queue",
        mode: "followUp",
      });
      conn.send({
        t: "prompt",
        sessionId: meta.id,
        text: "steer",
        mode: "steer",
      });
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    role: "prompt-control",
    connect: connectIpc,
  });
  const deliveries: Array<{
    text: string;
    mode: "steer" | "followUp" | "aside";
  }> = [];
  const delivered = Promise.withResolvers<void>();
  bridge.onPrompt((text, mode) => {
    deliveries.push({ text, mode });
    if (deliveries.length === 2) delivered.resolve();
  });
  await bridge.start();

  const hello = await gotHello.promise;
  expect(hello).toMatchObject({ t: "hello", role: "prompt-control" });
  expect(hello).not.toHaveProperty("token");
  await delivered.promise;
  expect(deliveries).toEqual([
    { text: "queue", mode: "followUp" },
    { text: "steer", mode: "steer" },
  ]);
  bridge.stop();
});

test("model / thinking / compact frames invoke their callbacks", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  server.onConnection((conn) =>
    conn.onFrame((frame) => {
      if (frame.t !== "hello") return;
      conn.send({ t: "setModel", sessionId: meta.id, model: "@task" });
      conn.send({ t: "setThinkingLevel", sessionId: meta.id, level: "high" });
      conn.send({ t: "compact", sessionId: meta.id, instructions: "trim" });
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  const models: string[] = [];
  const levels: string[] = [];
  const compactions: (string | undefined)[] = [];
  const done = Promise.withResolvers<void>();
  bridge.onSetModel((m) => models.push(m));
  bridge.onSetThinkingLevel((l) => levels.push(l));
  bridge.onCompact((i) => {
    compactions.push(i);
    done.resolve();
  });
  await bridge.start();
  await done.promise;

  expect(models).toEqual(["@task"]);
  expect(levels).toEqual(["high"]);
  expect(compactions).toEqual(["trim"]);
  bridge.stop();
});

test("prompt-control role also dispatches model control frames", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  server.onConnection((conn) =>
    conn.onFrame((frame) => {
      if (frame.t !== "hello") return;
      conn.send({ t: "setModel", sessionId: meta.id, model: "@heavy" });
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    role: "prompt-control",
    connect: connectIpc,
  });
  const got = Promise.withResolvers<string>();
  bridge.onSetModel((m) => got.resolve(m));
  await bridge.start();

  expect(await got.promise).toBe("@heavy");
  bridge.stop();
});

test("emitCatalog sends a modelCatalog frame tagged with the current selection", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const frames: Frame[] = [];
  const done = Promise.withResolvers<void>();
  server.onConnection((conn) =>
    conn.onFrame((f) => {
      frames.push(f);
      if (f.t === "modelCatalog") done.resolve();
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  bridge.emitCatalog({
    models: [
      {
        id: "anthropic/opus",
        name: "Opus",
        provider: "anthropic",
        efforts: ["low", "high"],
        acceptsImages: true,
      },
    ],
    roles: [
      { role: "task", modelId: "qwen/q3", modelName: "Q3", provider: "qwen" },
    ],
    currentId: "anthropic/opus",
    currentEffort: "high",
    configured: true,
  });
  await bridge.start();
  await done.promise;

  expect(frames.find((f) => f.t === "modelCatalog")).toMatchObject({
    t: "modelCatalog",
    sessionId: "s1",
    currentId: "anthropic/opus",
    currentEffort: "high",
    configured: true,
  });
  bridge.stop();
});

test("resource frames dispatch to callbacks and emits send frames back", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const received: Frame[] = [];
  const done = Promise.withResolvers<void>();
  server.onConnection((conn) =>
    conn.onFrame((frame) => {
      received.push(frame);
      if (frame.t === "hello") {
        conn.send({
          t: "resourceInit",
          sessionId: meta.id,
          transferId: "tx",
          name: "p.png",
          mimeType: "image/png",
          size: 3,
          totalChunks: 1,
          sha256: "ab",
        });
        conn.send({
          t: "resourceChunk",
          sessionId: meta.id,
          transferId: "tx",
          index: 0,
          data: "AAA=",
        });
        conn.send({ t: "resourceAbort", sessionId: meta.id, transferId: "tx" });
      }
      if (frame.t === "resourceReady") done.resolve();
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  const inits: string[] = [];
  const chunks: number[] = [];
  const aborts: string[] = [];
  bridge.onResourceInit((f) => inits.push(f.transferId));
  bridge.onResourceChunk((f) => chunks.push(f.index));
  bridge.onResourceAbort((id) => {
    aborts.push(id);
    bridge.emitResourceReady("tx", "res-1");
  });
  await bridge.start();
  await done.promise;

  expect(inits).toEqual(["tx"]);
  expect(chunks).toEqual([0]);
  expect(aborts).toEqual(["tx"]);
  expect(received.find((f) => f.t === "resourceReady")).toMatchObject({
    t: "resourceReady",
    transferId: "tx",
    resourceId: "res-1",
  });
  bridge.stop();
});

test("emitAttention sends an attention frame carrying the session id and reason", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const frames: Frame[] = [];
  const { promise: done, resolve } = Promise.withResolvers<void>();
  server.onConnection((conn: IpcConn) =>
    conn.onFrame((f) => {
      frames.push(f);
      if (f.t === "attention") resolve();
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  await bridge.start();
  bridge.emitAttention("approval");
  await done;

  expect(frames.find((f) => f.t === "attention")).toEqual({
    t: "attention",
    sessionId: "s1",
    reason: "approval",
  });
  bridge.stop();
});

test("emitMediaInit sends a mediaInit frame", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const frames: Frame[] = [];
  const { promise: done, resolve } = Promise.withResolvers<void>();
  server.onConnection((conn: IpcConn) =>
    conn.onFrame((f) => {
      frames.push(f);
      if (f.t === "mediaInit") resolve();
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  await bridge.start();
  bridge.emitMediaInit({
    mediaId: "s1:0",
    anchor: { kind: "message", msgId: "s1" },
    mimeType: "image/png",
    size: 1024,
    totalChunks: 1,
  });
  await done;

  expect(frames.find((f) => f.t === "mediaInit")).toEqual({
    t: "mediaInit",
    sessionId: "s1",
    mediaId: "s1:0",
    anchor: { kind: "message", msgId: "s1" },
    mimeType: "image/png",
    size: 1024,
    totalChunks: 1,
  });
  bridge.stop();
});

test("emitMediaChunk sends a mediaChunk frame", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const frames: Frame[] = [];
  const { promise: done, resolve } = Promise.withResolvers<void>();
  server.onConnection((conn: IpcConn) =>
    conn.onFrame((f) => {
      frames.push(f);
      if (f.t === "mediaChunk") resolve();
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  await bridge.start();
  bridge.emitMediaChunk({ mediaId: "s1:0", index: 0, data: "AA==" });
  await done;

  expect(frames.find((f) => f.t === "mediaChunk")).toEqual({
    t: "mediaChunk",
    sessionId: "s1",
    mediaId: "s1:0",
    index: 0,
    data: "AA==",
  });
  bridge.stop();
});

test("emitMediaError sends a mediaError frame", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const frames: Frame[] = [];
  const { promise: done, resolve } = Promise.withResolvers<void>();
  server.onConnection((conn: IpcConn) =>
    conn.onFrame((f) => {
      frames.push(f);
      if (f.t === "mediaError") resolve();
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  await bridge.start();
  bridge.emitMediaError("s1:0", "too-large");
  await done;

  expect(frames.find((f) => f.t === "mediaError")).toEqual({
    t: "mediaError",
    sessionId: "s1",
    mediaId: "s1:0",
    code: "too-large",
  });
  bridge.stop();
});

test("start never throws when the agent is down", async () => {
  const bridge = new SessionBridge({
    token: "tok",
    path: addr(),
    meta,
    connect: connectIpc,
  });
  await bridge.start();
  expect(true).toBe(true);
  bridge.stop();
});

// --- injectable reconnect scheduler ------------------------------------------

interface ManualScheduler {
  schedule(delayMs: number, run: () => void): void;
  cancel(): void;
  fire(): void;
  readonly pending: boolean;
  readonly delayMs: number;
}

function manualScheduler(): ManualScheduler {
  let delay = 0;
  let run: (() => void) | undefined;
  return {
    schedule(d: number, r: () => void) {
      delay = d;
      run = r;
    },
    cancel() {
      run = undefined;
      delay = 0;
    },
    fire() {
      const r = run;
      run = undefined;
      delay = 0;
      r?.();
    },
    get pending() {
      return run !== undefined;
    },
    get delayMs() {
      return delay;
    },
  };
}

/** A hand-driven `IpcConn` double (no sockets, no timers). */
class FakeConn implements IpcConn {
  readonly authenticated = true;
  frames: Frame[] = [];
  closed = false;
  #frameCbs: ((f: Frame) => void)[] = [];
  #closeCbs: (() => void)[] = [];

  send(frame: Frame): void {
    this.frames.push(frame);
  }
  onFrame(cb: (f: Frame) => void): void {
    this.#frameCbs.push(cb);
  }
  onClose(cb: () => void): void {
    this.#closeCbs.push(cb);
  }
  fireFrame(frame: Frame): void {
    for (const cb of [...this.#frameCbs]) cb(frame);
  }
  close(): void {
    this.closed = true;
    this.fireClose();
  }
  fireClose(): void {
    for (const cb of [...this.#closeCbs]) cb();
  }
}

/**
 * Await real microtask progression until `cond` holds (bounded). The bridge's
 * scheduler callback runs an async `start()`, so scheduling happens a few
 * microtasks after `fire()` — this waits for that, no wall-clock involved.
 */
async function until(cond: () => boolean, steps = 20): Promise<void> {
  for (let i = 0; i < steps && !cond(); i++) await Promise.resolve();
}

test("reconnect delay doubles on consecutive failures and caps at 30s", async () => {
  const sched = manualScheduler();
  let calls = 0;
  const conn = new FakeConn();
  const bridge = new SessionBridge({
    token: "tok",
    path: addr(),
    meta,
    connect: async () => {
      calls++;
      if (calls < 5) throw new Error("agent down");
      return conn;
    },
    scheduler: sched,
  });

  await bridge.start(); // attempt 1 fails
  expect(calls).toBe(1);
  expect(sched.pending).toBe(true);
  expect(sched.delayMs).toBe(500);
  sched.fire(); // attempt 2 fails
  await until(() => sched.pending);
  expect(calls).toBe(2);
  expect(sched.delayMs).toBe(1000);
  sched.fire(); // attempt 3 fails
  await until(() => sched.pending);
  expect(calls).toBe(3);
  expect(sched.delayMs).toBe(2000);
  sched.fire(); // attempt 4 fails
  await until(() => sched.pending);
  expect(calls).toBe(4);
  expect(sched.delayMs).toBe(4000);
  sched.fire(); // attempt 5 succeeds
  await until(() => conn.frames.some((f) => f.t === "hello"));
  expect(calls).toBe(5);
  expect(conn.frames[0]).toMatchObject({ t: "hello" });
  bridge.stop();
});

test("a successful connect resets the reconnect delay to the base", async () => {
  const sched = manualScheduler();
  let calls = 0;
  const conn = new FakeConn();
  const bridge = new SessionBridge({
    token: "tok",
    path: addr(),
    meta,
    connect: async () => {
      calls++;
      if (calls === 1) throw new Error("agent down");
      return conn;
    },
    scheduler: sched,
  });
  await bridge.start(); // fails (500 scheduled)
  expect(sched.delayMs).toBe(500);
  sched.fire(); // succeeds
  await until(() => conn.frames.some((f) => f.t === "hello"));
  expect(calls).toBe(2);
  conn.close(); // drop the conn → reconnect at the BASE, not 1000
  expect(sched.pending).toBe(true);
  expect(sched.delayMs).toBe(500);
  sched.cancel();
  bridge.stop();
});

test("reconnect diagnostics emit once per distinct backoff stage", async () => {
  const sched = manualScheduler();
  const diagnostics: BridgeDiagnostic[] = [];
  const bridge = new SessionBridge({
    token: "tok",
    path: addr(),
    meta,
    connect: async () => {
      throw new Error(
        "PRIVATE_CONNECT_ERROR token=secret wss://relay/r/room#key",
      );
    },
    scheduler: sched,
    diagnostic: (event) => diagnostics.push(event),
  });

  await bridge.start();
  for (let attempt = 1; attempt < 8; attempt++) {
    sched.fire();
    await until(() => sched.pending);
  }

  expect(
    diagnostics
      .filter((event) => event.event === "ipc_reconnect_scheduled")
      .map((event) =>
        event.event === "ipc_reconnect_scheduled"
          ? event.retryDelayMs
          : undefined,
      ),
  ).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000]);
  expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_CONNECT_ERROR");
  expect(JSON.stringify(diagnostics)).not.toContain("secret");
  expect(JSON.stringify(diagnostics)).not.toContain("relay");
  bridge.stop();
});

test("prompt handoff and model execution have separate metadata-only diagnostics", async () => {
  const conn = new FakeConn();
  const diagnostics: BridgeDiagnostic[] = [];
  const bridge = new SessionBridge({
    token: "tok",
    path: addr(),
    meta,
    connect: async () => conn,
    diagnostic: (event) => diagnostics.push(event),
  });
  bridge.onPrompt((_text, mode) => {
    bridge.reportPromptDispatch(mode, "active-follow-up");
  });
  await bridge.start();

  conn.fireFrame({
    t: "prompt",
    sessionId: meta.id,
    text: "PRIVATE_PROMPT_BODY",
    mode: "followUp",
  });
  bridge.reportModelExecutionStarted();

  expect(diagnostics).toEqual([
    {
      event: "ipc_connected",
      sessionId: meta.id,
      role: "feed",
    },
    {
      event: "prompt_received",
      sessionId: meta.id,
      mode: "followUp",
      role: "feed",
    },
    {
      event: "prompt_dispatch_accepted",
      sessionId: meta.id,
      mode: "followUp",
      route: "active-follow-up",
      execution: "unconfirmed",
    },
    {
      event: "model_execution_started",
      sessionId: meta.id,
    },
  ]);
  expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_PROMPT_BODY");
  bridge.stop();
});

test("stop() cancels a pending reconnect", async () => {
  const sched = manualScheduler();
  let calls = 0;
  const bridge = new SessionBridge({
    token: "tok",
    path: addr(),
    meta,
    connect: async () => {
      calls++;
      throw new Error("agent down");
    },
    scheduler: sched,
  });

  await bridge.start();
  expect(sched.pending).toBe(true);
  bridge.stop();
  expect(sched.pending).toBe(false);
  sched.fire(); // must be a no-op: no further connect attempts
  expect(calls).toBe(1);
});

test("stop() during the connect gap never adopts the connection", async () => {
  const conn = new FakeConn();
  const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
  const bridge = new SessionBridge({
    token: "tok",
    path: addr(),
    meta,
    connect: async () => {
      await gate;
      return conn;
    },
  });
  const started = bridge.start();
  bridge.stop(); // lands in the connect gap, before the conn resolves
  openGate();
  await started;
  expect(conn.closed).toBe(true); // the late conn is closed, not adopted
  expect(conn.frames.some((f) => f.t === "hello")).toBe(false);
});

test("the feed queue is bounded: overflow drops the oldest frames (drop-oldest)", async () => {
  const sched = manualScheduler();
  let calls = 0;
  const conn = new FakeConn();
  const bridge = new SessionBridge({
    token: "tok",
    path: addr(),
    meta,
    connect: async () => {
      calls++;
      if (calls === 1) throw new Error("agent down");
      return conn;
    },
    scheduler: sched,
  });

  await bridge.start(); // fails; the retry stays pending while we queue
  for (let i = 0; i < 300; i++) {
    bridge.emitMsg({
      phase: "end",
      msgId: `m${i}`,
      role: "assistant",
      text: `f${i}`,
    });
  }
  sched.fire(); // succeeds: hello + the queued tail flush to the conn
  await until(() => conn.frames.some((f) => f.t === "hello"));

  expect(conn.frames[0]).toMatchObject({ t: "hello" });
  const msgs = conn.frames.filter((f) => f.t === "msg");
  expect(msgs.length).toBe(256); // 300 emitted, the 44 oldest dropped
  expect(msgs[0]).toMatchObject({ t: "msg", msgId: "m44" });
  expect(msgs[msgs.length - 1]).toMatchObject({ t: "msg", msgId: "m299" });
  bridge.stop();
});

test("raiseInteraction sends an interaction frame and resolves on the matching reply", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const { promise: connArrived, resolve: resolveConn } =
    Promise.withResolvers<IpcConn>();
  server.onConnection((conn) => resolveConn(conn));
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  await bridge.start();
  const serverConn = await connArrived;

  const { promise: gotFrame, resolve: resolveFrame } =
    Promise.withResolvers<Frame>();
  serverConn.onFrame((f) => {
    if (f.t === "interaction") resolveFrame(f);
  });

  const answer = bridge.raiseInteraction("i1", {
    kind: "ask",
    questions: [{ question: "Pick a letter" }],
  });
  const frame = await gotFrame;
  expect(frame).toMatchObject({ t: "interaction", sessionId: "s1", id: "i1" });

  serverConn.send({
    t: "interactionReply",
    sessionId: "s1",
    id: "i1",
    response: { kind: "ask", answers: ["B"] },
  });
  expect(await answer).toEqual({ kind: "ask", answers: ["B"] });
  bridge.stop();
});

test("aborting a raised interaction resolves undefined and dismisses it on the client", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const { promise: connArrived, resolve: resolveConn } =
    Promise.withResolvers<IpcConn>();
  server.onConnection((conn) => resolveConn(conn));
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  await bridge.start();
  const serverConn = await connArrived;
  const { promise: gotEnd, resolve: resolveEnd } =
    Promise.withResolvers<Frame>();
  serverConn.onFrame((f) => {
    if (f.t === "interactionEnd") resolveEnd(f);
  });

  const controller = new AbortController();
  const answer = bridge.raiseInteraction(
    "i2",
    { kind: "ask", questions: [{ question: "Q" }] },
    controller.signal,
  );
  controller.abort();

  expect(await answer).toBeUndefined();
  expect(await gotEnd).toMatchObject({
    t: "interactionEnd",
    id: "i2",
    reason: "cancelled",
  });
  bridge.stop();
});

test("a reply after the interaction is settled is ignored (first-answer-wins)", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const { promise: connArrived, resolve: resolveConn } =
    Promise.withResolvers<IpcConn>();
  server.onConnection((conn) => resolveConn(conn));
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  await bridge.start();
  const serverConn = await connArrived;

  const answer = bridge.raiseInteraction("i3", {
    kind: "approval",
    tool: "bash",
    choices: ["Approve", "Deny"],
  });
  serverConn.send({
    t: "interactionReply",
    sessionId: "s1",
    id: "i3",
    response: { kind: "approval", decision: "allow" },
  });
  expect(await answer).toEqual({ kind: "approval", decision: "allow" });

  // A second reply for the same id has no waiter and must not throw or re-settle.
  serverConn.send({
    t: "interactionReply",
    sessionId: "s1",
    id: "i3",
    response: { kind: "approval", decision: "deny" },
  });
  await Promise.resolve();
  bridge.stop();
});

// --- IPC endpoint authentication ---------------------------------------------

/**
 * A process squatting the endpoint that plays the handshake but cannot prove
 * the token (it answers with a made-up MAC). Records every byte it receives.
 */
async function squat(path: string): Promise<() => string> {
  let received = "";
  const fake = "A".repeat(43);
  squatter = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (chunk.includes('"ipcAuthInit"'))
        socket.write(`{"t":"ipcAuthChallenge","serverNonce":"${fake}"}\n`);
      if (chunk.includes('"ipcAuthProof"'))
        socket.write(`{"t":"ipcAuthAccept","mac":"${fake}"}\n`);
    });
  });
  const ready = Promise.withResolvers<void>();
  squatter.listen(path, () => ready.resolve());
  await ready.promise;
  return () => received;
}

test("the bridge refuses a squatted endpoint, never sending it the token or a frame", async () => {
  const path = addr();
  const received = await squat(path);
  const diagnostics: BridgeDiagnostic[] = [];
  const retried = Promise.withResolvers<void>();
  const sched = manualScheduler();
  const bridge = new SessionBridge({
    token: "tok-secret-value",
    path,
    meta,
    scheduler: sched,
    diagnostic: (event) => {
      diagnostics.push(event);
      if (
        event.event === "ipc_reconnect_scheduled" &&
        event.retryDelayMs === 1000
      )
        retried.resolve();
    },
  });
  bridge.emitState({ model: "m", streaming: false, title: "T" });
  await bridge.start(); // resolves: the refusal never throws into omp
  expect(diagnostics).toEqual([
    {
      event: "ipc_auth_failed",
      sessionId: "s1",
      role: "feed",
      code: "server-unproven",
    },
    {
      event: "ipc_reconnect_scheduled",
      sessionId: "s1",
      role: "feed",
      retryDelayMs: 500,
      code: "auth-failed",
    },
  ]);
  // It keeps retrying for the real agent, but logs a persistent refusal once.
  sched.fire();
  await retried.promise;
  expect(diagnostics.filter((e) => e.event === "ipc_auth_failed")).toHaveLength(
    1,
  );
  expect(received()).not.toContain("tok-secret-value");
  expect(received()).not.toContain('"hello"');
  expect(received()).not.toContain('"state"');
  bridge.stop();
});

test("a new bridge against a host-agent that predates the handshake fails closed", async () => {
  const path = addr();
  server = new IpcServer(); // no token: speaks only plain frames, like an old agent
  let frames = 0;
  server.onConnection((conn) => conn.onFrame(() => frames++));
  await server.listen(path);
  const diagnostics: BridgeDiagnostic[] = [];
  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    scheduler: manualScheduler(),
    diagnostic: (event) => diagnostics.push(event),
  });
  await bridge.start();
  expect(diagnostics[0]).toEqual({
    event: "ipc_auth_failed",
    sessionId: "s1",
    role: "feed",
    code: "agent-closed",
  });
  expect(frames).toBe(0);
  bridge.stop();
});
