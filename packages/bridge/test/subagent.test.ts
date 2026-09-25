import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Scheduler } from "@omp-remote/protocol";
import { resolveIpcToken } from "@omp-remote/protocol/ipc";
import type { AgentDiagnostic } from "../../agent/src/diagnostics";
import { AgentService } from "../../agent/src/service";
import ompRemoteBridge from "../src/index";
import { type SessionOrigin, isSubagentSession } from "../src/subagent";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** How omp presents one session to its extensions. */
interface OmpSession {
  id: string;
  hasUI: boolean;
  file: string | undefined;
  parentSession?: string;
}

const ENV_KEYS = [
  "OMP_REMOTE_IPC_PATH",
  "OMP_REMOTE_STATE_DIR",
  "OMP_REMOTE_MODE",
] as const;
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

/** The state dir the bridge reads its IPC token from, and that token. */
const stateDir = await mkdtemp(join(tmpdir(), "omp-remote-sub-state-"));
const token = await resolveIpcToken({ OMP_REMOTE_STATE_DIR: stateDir });
afterAll(() => rm(stateDir, { recursive: true, force: true }));

let svc: AgentService | undefined;
const shutdowns: (() => Promise<void>)[] = [];
afterEach(async () => {
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
    ? `\\\\.\\pipe\\omp-remote-sub-${Math.random().toString(36).slice(2)}`
    : join(
        tmpdir(),
        `omp-remote-sub-${Math.random().toString(36).slice(2)}.sock`,
      );
}

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

/** The slice of omp's context that says whether a session is a subagent. */
function originOf(session: OmpSession): SessionOrigin {
  return {
    hasUI: session.hasUI,
    sessionManager: {
      getSessionFile: () => session.file,
      getHeader: () => ({ parentSession: session.parentSession }),
    },
  };
}

/** Load one bridge instance the way omp does per session, against a fake omp. */
function loadBridge(session: OmpSession) {
  const handlers = new Map<string, Handler[]>();
  const noop = () => {};
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
    sendUserMessage: noop,
  };
  const origin = originOf(session);
  const ctx = {
    hasUI: origin.hasUI,
    cwd: join(tmpdir(), "project"),
    sessionManager: {
      ...origin.sessionManager,
      getSessionId: () => session.id,
    },
    models: {
      current: () => ({ id: "m", provider: "p", name: "M" }),
      list: () => [],
      resolve: () => undefined,
    },
    isIdle: () => true,
    abort: noop,
    compact: async () => {},
    shutdown: noop,
    getContextUsage: () => undefined,
    getAsyncJobSnapshot: () => null,
    setInterval: () => 0,
    clearTimer: noop,
  };
  // Test fake: only the slice of omp's extension API the bridge touches.
  ompRemoteBridge(pi as unknown as ExtensionAPI);
  const fire = async (name: string): Promise<void> => {
    // Test fake: the bridge reads only the fields `ctx` defines above.
    const c = ctx as unknown as ExtensionContext;
    await Promise.all((handlers.get(name) ?? []).map((h) => h({}, c)));
  };
  shutdowns.push(() => fire("session_shutdown"));
  return { fire };
}

const sessionsDir = join(tmpdir(), "omp-sessions", "-proj");
/** The interactive session a user runs; it spawns subagents with `task`. */
const parent: OmpSession = {
  id: "parent-session",
  hasUI: true,
  file: join(sessionsDir, "2026-09-25T10-00-00-000Z_parent-session.jsonl"),
};
/** A `task` subagent: headless, its file in the parent's artifacts dir. */
const subagent: OmpSession = {
  id: "subagent-session",
  hasUI: false,
  file: join(
    sessionsDir,
    "2026-09-25T10-00-00-000Z_parent-session",
    "Worker.jsonl",
  ),
  parentSession: parent.file,
};

test.each(["feed", "collab"] as const)(
  "a subagent's %s bridge is never listed on the phone; its parent session is",
  async (mode) => {
    const path = ipcAddr();
    const { scheduler, fire } = manualScheduler();
    const connected: string[] = [];
    const parentConnected = Promise.withResolvers<void>();
    svc = new AgentService({
      token,
      ipcPath: path,
      scheduler,
      diagnostic: (event: AgentDiagnostic) => {
        if (event.event !== "ipc_session_connected") return;
        connected.push(event.sessionId);
        if (event.sessionId === parent.id) parentConnected.resolve();
      },
    });
    await svc.start();
    process.env.OMP_REMOTE_IPC_PATH = path;
    process.env.OMP_REMOTE_STATE_DIR = stateDir;
    process.env.OMP_REMOTE_MODE = mode === "collab" ? "collab" : "";

    // omp loads the extension afresh for each subagent in the same process.
    // The subagent starts first, so a hello from it would land before the parent's.
    await loadBridge(subagent).fire("session_start");
    await loadBridge(parent).fire("session_start");
    await parentConnected.promise;
    // A Collab session without a room is listed once its grace expires.
    fire();

    const listed = svc.snapshot();
    if (listed.t !== "sessions") throw new Error("expected a session list");
    expect(listed.sessions.map((s) => s.id)).toEqual([parent.id]);
    expect(connected).toEqual([parent.id]);
  },
);

const parentArtifacts = join(
  sessionsDir,
  "2026-09-25T10-00-00-000Z_parent-session",
);
const cases: [string, OmpSession, boolean][] = [
  ["a task subagent", subagent, true],
  [
    "a subagent's own subagent",
    {
      id: "nested",
      hasUI: false,
      file: join(parentArtifacts, "Worker", "Helper.jsonl"),
      parentSession: join(parentArtifacts, "Worker.jsonl"),
    },
    true,
  ],
  ["an interactive session", parent, false],
  [
    "a headless `omp -p` session",
    {
      id: "print",
      hasUI: false,
      file: join(sessionsDir, "2026-09-25T11-00-00-000Z_print.jsonl"),
    },
    false,
  ],
  [
    "a fork, which records its parent but lives beside it",
    {
      id: "fork",
      hasUI: false,
      file: join(sessionsDir, "2026-09-25T12-00-00-000Z_fork.jsonl"),
      parentSession: parent.file,
    },
    false,
  ],
  [
    "a subagent transcript reopened in the TUI",
    { ...subagent, hasUI: true },
    false,
  ],
  [
    "a session kept in memory only",
    { id: "memory", hasUI: false, file: undefined },
    false,
  ],
];
test.each(cases)("%s: subagent %p", (_name, session, expected) => {
  expect(isSubagentSession(originOf(session))).toBe(expected);
});
