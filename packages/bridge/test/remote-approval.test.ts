import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
  ClientMessage,
  InteractionFrame,
  Scheduler,
} from "@omp-remote/protocol";
import { resolveIpcToken } from "@omp-remote/protocol/ipc";
import { AgentService } from "../../agent/src/service";
import ompRemoteBridge from "../src/index";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const ENV_KEYS = [
  "OMP_REMOTE_IPC_PATH",
  "OMP_REMOTE_STATE_DIR",
  "OMP_REMOTE_MODE",
  "OMP_REMOTE_APPROVAL",
] as const;
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

const stateDir = await mkdtemp(join(tmpdir(), "omp-remote-approval-state-"));
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
    ? `\\\\.\\pipe\\omp-remote-approval-${Math.random().toString(36).slice(2)}`
    : join(
        tmpdir(),
        `omp-remote-approval-${Math.random().toString(36).slice(2)}.sock`,
      );
}

/** No Collab room is found in these tests; its grace never runs out. */
const noTimers: Scheduler = {
  setTimer: () => () => {},
  setInterval: () => () => {},
};

/** omp's terminal dialog: each stays open until answered or its signal
 *  aborts, when it resolves nothing, as omp's `select` does. */
class Terminal {
  readonly dialogs: {
    title: string;
    signal: AbortSignal | undefined;
    answer: (choice: string) => void;
  }[] = [];

  readonly select = (
    title: string,
    _options: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<string | undefined> => {
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    opts?.signal?.addEventListener("abort", () => resolve(undefined), {
      once: true,
    });
    this.dialogs.push({ title, signal: opts?.signal, answer: resolve });
    return promise;
  };
}

/** Load the bridge into a fake omp started with `--omp-remote-approval=<flag>`
 *  and `--approval-mode yolo`, as the host-agent spawns it for the phone. */
function loadBridge(
  mode: "feed" | "collab",
  path: string,
  flag: string,
  terminal: Terminal,
) {
  process.env.OMP_REMOTE_IPC_PATH = path;
  process.env.OMP_REMOTE_STATE_DIR = stateDir;
  process.env.OMP_REMOTE_MODE = mode === "collab" ? "collab" : "";
  process.env.OMP_REMOTE_APPROVAL = "";
  const handlers = new Map<string, Handler[]>();
  const noop = () => {};
  const pi = {
    setLabel: noop,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: noop,
    registerFlag: noop,
    getFlag: (name: string) =>
      name === "omp-remote-approval" ? flag : undefined,
    getSessionName: () => "Approvals",
    getThinkingLevel: () => "medium",
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
    ui: { select: terminal.select },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    models: { current: () => model, list: () => [model], resolve: noop },
    isIdle: () => false,
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
  // Test fake: the bridge reads only the fields `ctx` defines above.
  const c = ctx as unknown as ExtensionContext;
  const fire = async (name: string): Promise<void> => {
    await Promise.all((handlers.get(name) ?? []).map((h) => h({}, c)));
  };
  shutdowns.push(() => fire("session_shutdown"));
  return {
    fire,
    /** omp's `tool_call` for a call: what the bridge answers for it. */
    toolCall: async (toolName: string, input: unknown): Promise<unknown> => {
      const [gate, ...others] = handlers.get("tool_call") ?? [];
      if (!gate || others.length > 0)
        throw new Error("the bridge registers one tool_call handler");
      return gate({ type: "tool_call", toolCallId: "c1", toolName, input }, c);
    },
  };
}

/** The host-agent, and the frames it relays to the phone. */
async function hostAgent(path: string) {
  svc = new AgentService({ token, ipcPath: path, scheduler: noTimers });
  const seen: ClientMessage[] = [];
  const waiters: {
    match: (m: ClientMessage) => boolean;
    resolve: (m: ClientMessage) => void;
  }[] = [];
  svc.subscribe((m) => {
    seen.push(m);
    for (const waiter of waiters) if (waiter.match(m)) waiter.resolve(m);
  });
  await svc.start();
  return {
    service: svc,
    seen,
    /** The first message the phone is sent that `match`es. */
    sent: (match: (m: ClientMessage) => boolean): Promise<ClientMessage> => {
      const { promise, resolve } = Promise.withResolvers<ClientMessage>();
      const earlier = seen.find(match);
      if (earlier) resolve(earlier);
      else waiters.push({ match, resolve });
      return promise;
    },
  };
}

const approvalFor =
  (tool: string) =>
  (m: ClientMessage): m is InteractionFrame =>
    m.t === "interaction" &&
    m.payload.kind === "approval" &&
    m.payload.tool === tool;

test("a phone-spawned IPC session asks the phone for approval, and the phone's answer closes the terminal dialog", async () => {
  const path = ipcAddr();
  const host = await hostAgent(path);
  const terminal = new Terminal();
  const omp = loadBridge("feed", path, "write", terminal);
  await omp.fire("session_start");
  await host.sent((m) => m.t === "state");

  // `write` mode asks before code runs, not before a read or an edit.
  expect(await omp.toolCall("read", { path: "src/a.ts" })).toBeUndefined();
  expect(
    await omp.toolCall("edit", { path: "src/a.ts", edits: [] }),
  ).toBeUndefined();
  expect(terminal.dialogs).toEqual([]);

  const decision = omp.toolCall("bash", { command: "rm -rf build" });
  const asked = await host.sent(approvalFor("bash"));
  if (asked.t !== "interaction") throw new Error("not an interaction");
  expect(asked).toMatchObject({
    sessionId: "s1",
    payload: {
      kind: "approval",
      tool: "bash",
      input: { command: "rm -rf build" },
      choices: ["Approve", "Deny"],
      terminal: true,
    },
  });
  // The terminal asks the same call at the same time.
  expect(terminal.dialogs.map((d) => d.title)).toEqual([
    'Allow tool: bash\n{\n  "command": "rm -rf build"\n}',
  ]);

  host.service.deliverDownlink({
    t: "interactionReply",
    sessionId: "s1",
    id: asked.id,
    response: { kind: "approval", decision: "allow" },
  });
  expect(await decision).toBeUndefined();
  expect(terminal.dialogs[0]?.signal?.aborted).toBe(true);
  expect(host.service.replay()).not.toContainEqual(
    expect.objectContaining({ t: "interaction", id: asked.id }),
  );
});

test("an answer at the terminal withdraws the phone's approval card", async () => {
  const path = ipcAddr();
  const host = await hostAgent(path);
  const terminal = new Terminal();
  const omp = loadBridge("feed", path, "always-ask", terminal);
  await omp.fire("session_start");
  await host.sent((m) => m.t === "state");

  // `always-ask` asks before an edit too.
  const decision = omp.toolCall("edit", { path: "src/a.ts", edits: [] });
  const asked = await host.sent(approvalFor("edit"));
  if (asked.t !== "interaction") throw new Error("not an interaction");
  terminal.dialogs[0]?.answer("Deny");

  expect(await decision).toEqual({
    block: true,
    reason: "omp-remote: edit denied by user",
  });
  expect(
    await host.sent((m) => m.t === "interactionEnd" && m.id === asked.id),
  ).toMatchObject({ sessionId: "s1", reason: "cancelled" });
});

test("a Collab session asks through omp's terminal dialog, which the room mirrors to the phone", async () => {
  const terminal = new Terminal();
  const omp = loadBridge("collab", ipcAddr(), "always-ask", terminal);

  expect(await omp.toolCall("grep", { pattern: "x" })).toBeUndefined();
  const decision = omp.toolCall("bash", { command: "bun test" });
  expect(terminal.dialogs).toHaveLength(1);
  terminal.dialogs[0]?.answer("Approve");
  expect(await decision).toBeUndefined();
});
