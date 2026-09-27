import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
  ClientMessage,
  Frame,
  Scheduler,
  SessionMeta,
} from "@omp-remote/protocol";
import {
  type IpcConn,
  IpcServer,
  resolveIpcToken,
} from "@omp-remote/protocol/ipc";
import { AgentService } from "../../agent/src/service";
import ompRemoteBridge from "../src/index";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const ENV_KEYS = [
  "OMP_REMOTE_IPC_PATH",
  "OMP_REMOTE_STATE_DIR",
  "OMP_REMOTE_MODE",
] as const;
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

/** The state dir the bridge reads its IPC token from, and that token. */
const stateDir = await mkdtemp(join(tmpdir(), "omp-remote-restart-state-"));
const token = await resolveIpcToken({ OMP_REMOTE_STATE_DIR: stateDir });
afterAll(() => rm(stateDir, { recursive: true, force: true }));

let svc: AgentService | undefined;
const shutdowns: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Bridges hang up first: the agent's IPC close waits for its connections.
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  await svc?.stop();
  svc = undefined;
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function ipcAddr(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-restart-${Math.random().toString(36).slice(2)}`
    : join(
        tmpdir(),
        `omp-remote-restart-${Math.random().toString(36).slice(2)}.sock`,
      );
}

/** No Collab room is found in these tests; its grace never runs out. */
const noTimers: Scheduler = {
  setTimer: () => () => {},
  setInterval: () => () => {},
};

/** The conversation omp holds for the session, as its messages. */
const prompt = {
  role: "user",
  content: "fix the flaky test",
  timestamp: 1_000,
};
const reading = {
  role: "assistant",
  content: [
    { type: "text", text: "Reading it first." },
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
  ],
  timestamp: 2_000,
};
const readResult = {
  role: "toolResult",
  toolCallId: "c1",
  toolName: "read",
  content: [],
  isError: false,
  timestamp: 3_000,
};
const fixed = {
  role: "assistant",
  content: [{ type: "text", text: "Fixed: the timeout was too short." }],
  timestamp: 4_000,
};

/** Load the bridge against a fake omp running one session mid-turn, with a
 *  running background job. */
function loadBridge(mode: "feed" | "collab", path: string) {
  process.env.OMP_REMOTE_IPC_PATH = path;
  process.env.OMP_REMOTE_STATE_DIR = stateDir;
  process.env.OMP_REMOTE_MODE = mode === "collab" ? "collab" : "";
  const handlers = new Map<string, Handler[]>();
  const noop = () => {};
  const pi = {
    setLabel: noop,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: noop,
    getSessionName: () => "Flaky test",
    getThinkingLevel: () => "high",
    getServiceTiers: () => ({}),
    setServiceTier: noop,
    setThinkingLevel: noop,
    setModel: async () => true,
    sendUserMessage: noop,
  };
  const model = { id: "m", provider: "p", name: "M" };
  const ctx = {
    cwd: join(tmpdir(), "project"),
    hasUI: true,
    sessionManager: {
      getSessionId: () => "s1",
      getBranch: () =>
        [prompt, reading, readResult, fixed].map((message) => ({
          type: "message",
          message,
        })),
    },
    models: { current: () => model, list: () => [model], resolve: noop },
    isIdle: () => false,
    abort: noop,
    compact: async () => {},
    shutdown: noop,
    getContextUsage: () => ({
      percent: 12,
      tokens: 24_000,
      contextWindow: 200_000,
    }),
    getAsyncJobSnapshot: () => ({
      running: [
        {
          id: "bg_1",
          type: "bash",
          label: "bun test",
          status: "running",
          startTime: 500,
        },
      ],
      recent: [],
    }),
    setInterval: () => 0,
    clearTimer: noop,
  };
  // Test fake: only the slice of omp's extension API the bridge touches.
  ompRemoteBridge(pi as unknown as ExtensionAPI);
  const fire = async (name: string, event: unknown = {}): Promise<void> => {
    // Test fake: the bridge reads only the fields `ctx` defines above.
    const c = ctx as unknown as ExtensionContext;
    await Promise.all((handlers.get(name) ?? []).map((h) => h(event, c)));
  };
  shutdowns.push(() => fire("session_shutdown"));
  return { fire };
}

/** The host-agent before its restart: records what the bridge sends it, and
 *  drops every connection the way its dying process does. */
async function agentBeforeRestart(path: string) {
  const server = new IpcServer({ token });
  const conns: IpcConn[] = [];
  const frames: Frame[] = [];
  const waiters: { match: (f: Frame) => boolean; resolve: () => void }[] = [];
  server.onConnection((conn) => {
    conns.push(conn);
    conn.onFrame((frame) => {
      frames.push(frame);
      for (const waiter of waiters) if (waiter.match(frame)) waiter.resolve();
    });
  });
  await server.listen(path);
  return {
    frames,
    received: (match: (f: Frame) => boolean): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      if (frames.some(match)) resolve();
      else waiters.push({ match, resolve });
      return promise;
    },
    exit: async (): Promise<void> => {
      for (const conn of conns) conn.close();
      await server.close();
    },
  };
}

/** The agent after its restart, empty, on the same endpoint; resolves once
 *  a frame of type `last` reached it. */
async function restartedAgent(path: string, last: ClientMessage["t"]) {
  svc = new AgentService({ token, ipcPath: path, scheduler: noTimers });
  const arrived = Promise.withResolvers<void>();
  svc.subscribe((m) => {
    if (m.t === last) arrived.resolve();
  });
  await svc.start();
  await arrived.promise;
  return svc;
}

/** A message row by its id, a tool card by its call id. */
const rowKey = (f: Frame | ClientMessage): string | undefined =>
  f.t === "msg" ? f.msgId : f.t === "tool" ? f.callId : undefined;

test("after a host-agent restart the IPC feed re-sends its transcript, state, jobs and catalog: a phone opened then sees the live session", async () => {
  const path = ipcAddr();
  const before = await agentBeforeRestart(path);
  const omp = loadBridge("feed", path);
  await omp.fire("session_start");
  // The turn so far, as omp streamed it live before the restart.
  for (const message of [prompt, reading, readResult, fixed]) {
    await omp.fire("message_start", { type: "message_start", message });
    if (message.role === "assistant")
      await omp.fire("message_update", { type: "message_update", message });
    await omp.fire("message_end", { type: "message_end", message });
    if (message === reading) {
      const tool = { toolCallId: "c1", toolName: "read" };
      await omp.fire("tool_execution_start", { ...tool, args: {} });
      await omp.fire("tool_execution_end", tool);
    }
  }
  await before.received((f) => f.t === "msg" && f.text.startsWith("Fixed"));
  const live = [...new Set(before.frames.map(rowKey))].filter(
    (key) => key !== undefined,
  );

  await before.exit();
  const after = await restartedAgent(path, "modelCatalog");

  // What a phone that opens now is sent: the same rows the live feed showed,
  // under the same ids (so a phone kept open updates them in place), then the
  // footer, the jobs and the picker's catalog, though none of them changed.
  const replay = after.replay();
  expect(
    replay.map((m) =>
      m.t === "msg"
        ? `${m.role}: ${m.text}`
        : m.t === "tool"
          ? `${m.name} ${m.status}`
          : m.t,
    ),
  ).toEqual([
    "replayStart",
    "sessions",
    "user: fix the flaky test",
    "assistant: Reading it first.",
    "read done",
    "assistant: Fixed: the timeout was too short.",
    "state",
    "jobs",
    "modelCatalog",
    "replayEnd",
  ]);
  expect(replay.map(rowKey).filter((key) => key !== undefined)).toEqual(live);
  expect(replay).toContainEqual(
    expect.objectContaining({ t: "msg", role: "user", at: 1_000 }),
  );
  expect(replay).toContainEqual(
    expect.objectContaining({ t: "state", streaming: true, model: "m" }),
  );
  expect(replay).toContainEqual(
    expect.objectContaining({
      t: "jobs",
      running: [expect.objectContaining({ id: "bg_1" })],
    }),
  );
  expect(replay).toContainEqual(
    expect.objectContaining({
      t: "modelCatalog",
      currentId: "p/m",
      currentEffort: "high",
    }),
  );
});

test("after a host-agent restart the Collab prompt-control bridge re-sends its catalog and jobs", async () => {
  const path = ipcAddr();
  const before = await agentBeforeRestart(path);
  const omp = loadBridge("collab", path);
  await omp.fire("session_start");
  await before.received((f) => f.t === "jobs");

  await before.exit();
  const after = await restartedAgent(path, "jobs");
  // The agent's Collab guest finds the session's room again.
  const meta: SessionMeta = {
    id: "s1",
    cwd: join(tmpdir(), "project"),
    project: "project",
    model: "m",
    title: "Flaky test",
    pid: process.pid,
    startedAt: 0,
  };
  const room = after.registerCollabSession(meta, () => {});

  // Collab re-sends the transcript and footer itself; the bridge its part.
  const replay = after.replay();
  expect(replay.map((m) => m.t)).toEqual([
    "replayStart",
    "sessions",
    "modelCatalog",
    "jobs",
    "replayEnd",
  ]);
  expect(replay).toContainEqual(
    expect.objectContaining({ t: "modelCatalog", currentId: "p/m" }),
  );
  room.close();
});
