import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Frame } from "@omp-remote/protocol";
import { IpcServer, resolveIpcToken } from "@omp-remote/protocol/ipc";
import type { IpcConn } from "@omp-remote/protocol/ipc";
import ompRemoteBridge from "../src/index";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Seen {
  conn: number;
  frame: Frame;
}

interface FakeJob {
  id: string;
  type: string;
  label: string;
  status: string;
  startTime: number;
}
interface FakeJobSnapshot {
  running: FakeJob[];
  recent: FakeJob[];
}

const ENV_KEYS = [
  "OMP_REMOTE_IPC_PATH",
  "OMP_REMOTE_STATE_DIR",
  "OMP_REMOTE_MODE",
] as const;
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

/** The state dir the bridge reads its IPC token from, and that token. */
const stateDir = await mkdtemp(join(tmpdir(), "omp-remote-sw-state-"));
const token = await resolveIpcToken({ OMP_REMOTE_STATE_DIR: stateDir });
afterAll(() => rm(stateDir, { recursive: true, force: true }));

let server: IpcServer | undefined;
let shutdown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  await server?.close();
  server = undefined;
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function addr(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-sw-${Math.random().toString(36).slice(2)}`
    : join(
        tmpdir(),
        `omp-remote-sw-${Math.random().toString(36).slice(2)}.sock`,
      );
}

/** An IPC server that records every frame with the index of its connection. */
async function listen() {
  const path = addr();
  server = new IpcServer({ token });
  const seen: Seen[] = [];
  const conns: IpcConn[] = [];
  const waiters: Array<{
    match: (s: Seen) => boolean;
    resolve: (s: Seen) => void;
  }> = [];
  server.onConnection((conn) => {
    const index = conns.length;
    conns.push(conn);
    conn.onFrame((frame) => {
      const s = { conn: index, frame };
      seen.push(s);
      for (const w of [...waiters]) {
        if (!w.match(s)) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(s);
      }
    });
  });
  await server.listen(path);
  const next = (match: (s: Seen) => boolean): Promise<Seen> => {
    const already = seen.find(match);
    if (already) return Promise.resolve(already);
    const { promise, resolve } = Promise.withResolvers<Seen>();
    waiters.push({ match, resolve });
    return promise;
  };
  return { path, seen, conns, next };
}

/** Load the bridge against a fake omp: records handlers, drives one mutable session. */
function loadBridge(mode: "feed" | "collab", path: string) {
  process.env.OMP_REMOTE_IPC_PATH = path;
  process.env.OMP_REMOTE_STATE_DIR = stateDir;
  process.env.OMP_REMOTE_MODE = mode === "collab" ? "collab" : "";

  const handlers = new Map<string, Handler[]>();
  const { promise: firstSent, resolve: resolveSent } =
    Promise.withResolvers<unknown>();
  const session = { id: "s1", cwd: join(tmpdir(), "project-one") };
  const noop = () => {};
  // The async-job snapshot omp reports; tests mutate it between events.
  const jobs: { snapshot: FakeJobSnapshot | undefined } = {
    snapshot: undefined,
  };
  // Contained timers the bridge scheduled, fired by hand (no wall clock).
  const timers = new Map<number, { callback: () => void; ms?: number }>();
  let nextTimer = 0;
  const { promise: shutdownCalled, resolve: resolveShutdown } =
    Promise.withResolvers<void>();
  const pi = {
    setLabel: noop,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: noop,
    getSessionName: () => undefined,
    getThinkingLevel: () => "medium",
    getServiceTiers: () => ({}),
    setServiceTier: noop,
    setThinkingLevel: noop,
    setModel: async () => true,
    sendUserMessage: (content: unknown) => resolveSent(content),
  };
  const ctx = {
    get cwd() {
      return session.cwd;
    },
    sessionManager: { getSessionId: () => session.id },
    models: {
      current: () => ({ id: "m", provider: "p", name: "M" }),
      list: () => [],
      resolve: () => undefined,
    },
    isIdle: () => true,
    abort: noop,
    compact: async () => {},
    shutdown: () => resolveShutdown(),
    getContextUsage: () => undefined,
    getAsyncJobSnapshot: () => jobs.snapshot,
    setInterval: (callback: () => void, ms?: number) => {
      const id = ++nextTimer;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimer: (id: number) => {
      timers.delete(id);
    },
  };
  // Test fake: only the slice of omp's extension API the bridge touches.
  ompRemoteBridge(pi as unknown as ExtensionAPI);
  const fire = async (name: string, event: unknown = {}): Promise<void> => {
    // Test fake: the bridge reads only the fields `ctx` defines above.
    const c = ctx as unknown as ExtensionContext;
    await Promise.all((handlers.get(name) ?? []).map((h) => h(event, c)));
  };
  shutdown = () => fire("session_shutdown");
  return { session, firstSent, fire, jobs, timers, shutdownCalled };
}

const helloFor =
  (id: string) =>
  (s: Seen): boolean =>
    s.frame.t === "hello" && s.frame.session.id === id;

test("a session switch re-keys the feed: bye on the old id, hello with fresh meta, controls reach omp", async () => {
  const ipc = await listen();
  const omp = loadBridge("feed", ipc.path);

  await omp.fire("session_start");
  const first = await ipc.next(helloFor("s1"));

  omp.session.id = "s2";
  omp.session.cwd = join(tmpdir(), "project-two");
  await omp.fire("session_switch", {
    type: "session_switch",
    reason: "new",
  });

  const bye = await ipc.next(
    (s) => s.frame.t === "bye" && s.frame.sessionId === "s1",
  );
  expect(bye.conn).toBe(first.conn);
  const second = await ipc.next(helloFor("s2"));
  expect(second.conn).not.toBe(first.conn);
  if (second.frame.t !== "hello") throw new Error("expected hello");
  expect(second.frame.session.project).toBe("project-two");

  // Feed frames after the switch carry the new id.
  const state = await ipc.next(
    (s) => s.conn === second.conn && s.frame.t === "state",
  );
  if (state.frame.t !== "state") throw new Error("expected state");
  expect(state.frame.sessionId).toBe("s2");

  // A phone prompt on the new id reaches omp.
  ipc.conns[second.conn]?.send({
    t: "prompt",
    sessionId: "s2",
    text: "after switch",
    mode: "steer",
  });
  expect(await omp.firstSent).toBe("after switch");
});

test("a switch that keeps the session id does not reconnect", async () => {
  const ipc = await listen();
  const omp = loadBridge("feed", ipc.path);

  await omp.fire("session_start");
  await ipc.next(helloFor("s1"));
  // `/reload` re-emits session_switch for the same session file.
  await omp.fire("session_switch", {
    type: "session_switch",
    reason: "resume",
  });
  omp.session.id = "s3";
  await omp.fire("session_switch", {
    type: "session_switch",
    reason: "resume",
  });

  const third = await ipc.next(helloFor("s3"));
  const hellos = ipc.seen.filter((s) => s.frame.t === "hello");
  expect(hellos.map((s) => s.conn)).toEqual([0, third.conn]);
  expect(third.conn).toBe(1);
});

test("agent_start re-keys when the session changed without a switch event", async () => {
  const ipc = await listen();
  const omp = loadBridge("feed", ipc.path);

  await omp.fire("session_start");
  await ipc.next(helloFor("s1"));
  // omp emitted session_switch for a target it then rolled back; the bridge
  // announced the target, the process runs another id.
  omp.session.id = "s4";
  await omp.fire("agent_start");

  await ipc.next((s) => s.frame.t === "bye" && s.frame.sessionId === "s1");
  const hello = await ipc.next(helloFor("s4"));
  expect(hello.conn).toBe(1);
});

test("collab prompt-control follows a session switch", async () => {
  const ipc = await listen();
  const omp = loadBridge("collab", ipc.path);

  await omp.fire("session_start");
  const first = await ipc.next(helloFor("s1"));
  if (first.frame.t !== "hello") throw new Error("expected hello");
  expect(first.frame.role).toBe("prompt-control");

  omp.session.id = "s5";
  await omp.fire("session_switch", { type: "session_switch", reason: "fork" });

  const second = await ipc.next(helloFor("s5"));
  expect(second.conn).not.toBe(first.conn);
  if (second.frame.t !== "hello") throw new Error("expected hello");
  expect(second.frame.role).toBe("prompt-control");
});

test.each(["feed", "collab"] as const)(
  "a %s bridge declares closeSession and ends the omp session on it",
  async (mode) => {
    const ipc = await listen();
    const omp = loadBridge(mode, ipc.path);

    await omp.fire("session_start");
    const hello = await ipc.next(helloFor("s1"));
    if (hello.frame.t !== "hello") throw new Error("expected hello");
    expect(hello.frame.capabilities).toContain("closeSession");

    ipc.conns[hello.conn]?.send({ t: "closeSession", sessionId: "s1" });
    await omp.shutdownCalled;
  },
);

const bgJob: FakeJob = {
  id: "bg_5",
  type: "bash",
  label: "sleep 60",
  status: "running",
  startTime: 1_000,
};

test("collab publishes the async-job snapshot and polls only while jobs run", async () => {
  const ipc = await listen();
  const omp = loadBridge("collab", ipc.path);
  omp.jobs.snapshot = { running: [bgJob], recent: [] };

  await omp.fire("session_start");
  const first = await ipc.next((s) => s.frame.t === "jobs");
  expect(first.frame).toEqual({
    t: "jobs",
    sessionId: "s1",
    running: [
      {
        id: "bg_5",
        type: "bash",
        label: "sleep 60",
        status: "running",
        startMs: 1_000,
      },
    ],
    recent: 0,
  });
  expect([...omp.timers.values()].map((t) => t.ms)).toEqual([2000]);

  // A turn boundary while the job runs re-publishes without a second poll.
  await omp.fire("agent_start");
  expect(omp.timers.size).toBe(1);

  // The job finishes between turns: the next poll publishes the empty
  // snapshot (so the phone clears it) and stops polling.
  omp.jobs.snapshot = {
    running: [],
    recent: [{ ...bgJob, status: "completed" }],
  };
  for (const timer of [...omp.timers.values()]) timer.callback();
  const settled = await ipc.next(
    (s) => s.frame.t === "jobs" && s.frame.running.length === 0,
  );
  expect(settled.frame).toMatchObject({ running: [], recent: 1 });
  expect(omp.timers.size).toBe(0);

  // Collab owns the transcript: the prompt-control bridge never feeds it.
  expect(
    ipc.seen.filter(
      (s) =>
        s.frame.t === "state" || s.frame.t === "msg" || s.frame.t === "tool",
    ),
  ).toEqual([]);
});

test("collab stops polling jobs on session shutdown", async () => {
  const ipc = await listen();
  const omp = loadBridge("collab", ipc.path);
  omp.jobs.snapshot = { running: [bgJob], recent: [] };

  await omp.fire("session_start");
  await ipc.next((s) => s.frame.t === "jobs");
  expect(omp.timers.size).toBe(1);

  await omp.fire("session_shutdown");
  expect(omp.timers.size).toBe(0);
});
