import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, Frame } from "@omp-remote/protocol";
import { connectIpc } from "@omp-remote/protocol/ipc";
import { AgentService } from "../src/service";
import { devClientSocket, testDevClient } from "./helpers/dev-client";

let svc: AgentService | undefined;
afterEach(async () => {
  await svc?.stop();
  svc = undefined;
});

function ipcAddr() {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-routing-${Math.random().toString(36).slice(2)}`
    : join(
        tmpdir(),
        `omp-remote-routing-${Math.random().toString(36).slice(2)}.sock`,
      );
}

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
  while (!(snap.t === "sessions" && snap.sessions.some((s) => s.id === id))) {
    snap = await wsRecv(ws);
  }
}

test("setModel routes to the prompt-control conn", async () => {
  const path = ipcAddr();
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
    devClient: testDevClient,
  });
  await svc.start();

  const pc = await connectIpc(path, "tok");
  pc.send({
    t: "hello",
    token: "tok",
    session: {
      id: "s1",
      cwd: "/x",
      project: "p",
      model: "m",
      title: "T",
      pid: 3,
      startedAt: 0,
    },
    role: "prompt-control",
  });
  await new Promise<void>((resolve) => {
    pc.onFrame((f) => {
      if (f.t === "promptControlReady") resolve();
    });
  });

  const { promise: gotSetModel, resolve } = Promise.withResolvers<Frame>();
  pc.onFrame((f) => {
    if (f.t === "setModel") resolve(f);
  });

  const ws = devClientSocket(svc.boundPort);
  await wsOpen(ws);
  ws.send(
    JSON.stringify({
      t: "setModel",
      sessionId: "s1",
      model: "claude-sonnet-4",
    }),
  );
  ws.close();

  const frame = await gotSetModel;
  expect(frame.t).toBe("setModel");
  expect((frame as { model: string }).model).toBe("claude-sonnet-4");
  pc.close();
});

test("setModel falls back to feed conn when no prompt-control", async () => {
  const path = ipcAddr();
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
    devClient: testDevClient,
  });
  await svc.start();

  const feed = await connectIpc(path, "tok");
  feed.send({
    t: "hello",
    token: "tok",
    session: {
      id: "s1",
      cwd: "/x",
      project: "p",
      model: "m",
      title: "T",
      pid: 3,
      startedAt: 0,
    },
  });

  const { promise: gotSetModel, resolve } = Promise.withResolvers<Frame>();
  feed.onFrame((f) => {
    if (f.t === "setModel") resolve(f);
  });

  const ws = devClientSocket(svc.boundPort);
  await wsOpen(ws);
  await awaitSessionListed(ws, "s1");
  ws.send(
    JSON.stringify({ t: "setModel", sessionId: "s1", model: "claude-opus-4" }),
  );
  ws.close();

  const frame = await gotSetModel;
  expect(frame.t).toBe("setModel");
  expect((frame as { model: string }).model).toBe("claude-opus-4");
  feed.close();
});

test("compact routes to prompt-control conn", async () => {
  const path = ipcAddr();
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
    devClient: testDevClient,
  });
  await svc.start();

  const pc = await connectIpc(path, "tok");
  pc.send({
    t: "hello",
    token: "tok",
    session: {
      id: "s1",
      cwd: "/x",
      project: "p",
      model: "m",
      title: "T",
      pid: 3,
      startedAt: 0,
    },
    role: "prompt-control",
  });
  await new Promise<void>((resolve) => {
    pc.onFrame((f) => {
      if (f.t === "promptControlReady") resolve();
    });
  });

  const { promise: gotCompact, resolve } = Promise.withResolvers<Frame>();
  pc.onFrame((f) => {
    if (f.t === "compact") resolve(f);
  });

  const ws = devClientSocket(svc.boundPort);
  await wsOpen(ws);
  ws.send(JSON.stringify({ t: "compact", sessionId: "s1" }));
  ws.close();

  const frame = await gotCompact;
  expect(frame.t).toBe("compact");
  pc.close();
});

test("modelCatalog from prompt-control conn is relayed to clients", async () => {
  const path = ipcAddr();
  const received: ClientMessage[] = [];
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
  });
  await svc.start();

  const pc = await connectIpc(path, "tok");
  pc.send({
    t: "hello",
    token: "tok",
    session: {
      id: "s1",
      cwd: "/x",
      project: "p",
      model: "m",
      title: "T",
      pid: 3,
      startedAt: 0,
    },
    role: "prompt-control",
  });
  await new Promise<void>((resolve) => {
    pc.onFrame((f) => {
      if (f.t === "promptControlReady") resolve();
    });
  });

  const unsub = svc.subscribe((msg) => received.push(msg));

  pc.send({
    t: "modelCatalog",
    sessionId: "s1",
    models: [
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        provider: "anthropic",
        efforts: ["low", "high"],
      },
    ],
    roles: [{ role: "task", modelId: "claude-sonnet-4" }],
  });

  await new Promise((r) => setTimeout(r, 100));

  const catalogFrames = received.filter((f) => f.t === "modelCatalog");
  expect(catalogFrames.length).toBe(1);
  const catalog = catalogFrames[0] as { models: unknown[] };
  expect(catalog.models.length).toBe(1);

  unsub();
  pc.close();
});

test("state from prompt-control conn is NOT relayed to clients", async () => {
  const path = ipcAddr();
  const received: ClientMessage[] = [];
  svc = new AgentService({
    token: "tok",
    ipcPath: path,
  });
  await svc.start();

  const pc = await connectIpc(path, "tok");
  pc.send({
    t: "hello",
    token: "tok",
    session: {
      id: "s1",
      cwd: "/x",
      project: "p",
      model: "m",
      title: "T",
      pid: 3,
      startedAt: 0,
    },
    role: "prompt-control",
  });
  await new Promise<void>((resolve) => {
    pc.onFrame((f) => {
      if (f.t === "promptControlReady") resolve();
    });
  });

  const relayed = Promise.withResolvers<void>();
  const unsub = svc.subscribe((msg) => {
    received.push(msg);
    if (msg.t === "modelCatalog") relayed.resolve();
  });

  // A state frame from a prompt-control conn must be dropped; a modelCatalog from
  // the same conn IS relayed. IPC preserves order, so awaiting the catalog proves
  // the state was skipped without a wall-clock timer.
  pc.send({
    t: "state",
    sessionId: "s1",
    model: "test",
    streaming: false,
    title: "T",
  });
  pc.send({ t: "modelCatalog", sessionId: "s1", models: [], roles: [] });
  await relayed.promise;

  const stateFrames = received.filter((f) => f.t === "state");
  expect(stateFrames.length).toBe(0);

  unsub();
  pc.close();
});

test("ask tool produces no tool uplink frame", async () => {
  const { CollabTranslator } = await import("../src/collab/translate");
  const t = new CollabTranslator("s1");

  const frames = t.host({
    t: "event",
    event: {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "ask",
      args: { question: "Proceed?" },
      intent: "Confirm action",
    },
  });

  expect(frames.length).toBe(0);

  const editFrames = t.host({
    t: "event",
    event: {
      type: "tool_execution_start",
      toolCallId: "call-2",
      toolName: "edit",
      args: { path: "foo.ts" },
      intent: "Fix bug",
    },
  });

  expect(editFrames.length).toBe(1);
  expect((editFrames[0] as { name: string }).name).toBe("edit");
});
