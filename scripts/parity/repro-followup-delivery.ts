// Runtime parity probe for phone Queue/Steer delivery.
//
// This starts two fresh OMP RPC sessions against an isolated AgentService, a
// random IPC address, and a synthetic in-process provider. It exercises the
// production bridge bundle through the same authenticated prompt-control IPC
// path as the phone. No live OMP session, configured model, or provider
// credential is used.
//
// Expected behavior:
// - An idle Queue or Steer prompt starts a turn.
// - Active Queue stays out of the current tool loop, then drains after that
//   loop finishes.
// - Active Steer enters the current tool loop before it can finish normally.
//
// Run after building packages/bridge/dist/omp-remote-bridge.js:
//   bun run scripts/parity/repro-followup-delivery.ts

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentService } from "../../packages/agent/src/service";
import { devClientProtocols } from "../../packages/protocol/src/local-auth";

const BRIDGE_BUNDLE = resolve("packages/bridge/dist/omp-remote-bridge.js");
const OMP_BIN = process.env.OMP_BIN ?? "omp";
const TIMEOUT_MS = 20_000;
const POLL_MS = 20;

type PromptMode = "steer" | "followUp";
type JsonObject = Record<string, unknown>;

interface TraceCall {
  event: "call";
  call: number;
  hasInitial: boolean;
  hasQueue: boolean;
  hasSteer: boolean;
  hasCurrentTurnDone: boolean;
  roles: string[];
}

interface TraceComplete {
  event: "complete";
  call: number;
  reason: "stop" | "toolUse";
}

type TraceRecord = TraceCall | TraceComplete;

interface ScenarioResult {
  name: "Queue" | "Steer";
  idleStarted: boolean;
  activeStateObserved: boolean;
  calls: TraceCall[];
  completed: TraceComplete[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms = TIMEOUT_MS,
): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new Error(`timed out waiting for ${label}`)),
    ms,
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  await withTimeout(
    (async () => {
      while (!(await predicate())) await delay(POLL_MS);
    })(),
    label,
  );
}

function ipcAddress(id: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-runtime-${id}`
    : join(tmpdir(), `omp-remote-runtime-${id}.sock`);
}

async function readTrace(path: string): Promise<TraceRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TraceRecord);
}

class RpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: JsonObject[] = [];
  readonly stderr: string[] = [];
  #nextId = 1;
  #pending = new Map<
    string,
    { resolve: (value: JsonObject) => void; reject: (error: Error) => void }
  >();
  #stdoutBuffer = "";

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    child.once("exit", (code, signal) => {
      const detail = this.stderr.join("").trim();
      const error = new Error(
        `OMP RPC exited before replying (code=${String(code)}, signal=${String(signal)})${detail ? `: ${detail}` : ""}`,
      );
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonObject;
      try {
        message = JSON.parse(line) as JsonObject;
      } catch {
        continue;
      }
      this.messages.push(message);
      const id = typeof message.id === "string" ? message.id : undefined;
      if (!id) continue;
      const pending = this.#pending.get(id);
      if (!pending) continue;
      this.#pending.delete(id);
      pending.resolve(message);
    }
  }

  async send(command: JsonObject): Promise<JsonObject> {
    const id = `probe-${this.#nextId++}`;
    const response = Promise.withResolvers<JsonObject>();
    this.#pending.set(id, {
      resolve: response.resolve,
      reject: response.reject,
    });
    this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    const message = await withTimeout(
      response.promise,
      `${String(command.type)} response`,
    );
    if (message.success !== true) {
      throw new Error(
        `OMP RPC ${String(command.type)} failed: ${JSON.stringify(message)}`,
      );
    }
    return message;
  }

  async state(): Promise<JsonObject> {
    const response = await this.send({ type: "get_state" });
    const data = response.data;
    assert(data !== null && typeof data === "object", "get_state omitted data");
    return data as JsonObject;
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const exited = Promise.withResolvers<void>();
    this.child.once("exit", () => exited.resolve());
    try {
      await withTimeout(exited.promise, "OMP RPC shutdown", 5_000);
    } catch {
      this.child.kill();
      await withTimeout(exited.promise, "forced OMP RPC shutdown", 5_000);
    }
  }
}

function providerExtension(): string {
  return `import { appendFileSync } from "node:fs";

const tracePath = process.env.OMP_REMOTE_PROBE_TRACE;
if (!tracePath) throw new Error("OMP_REMOTE_PROBE_TRACE is required");

const INITIAL = "OMP_REMOTE_IDLE_START";
const QUEUE = "OMP_REMOTE_ACTIVE_QUEUE";
const STEER = "OMP_REMOTE_ACTIVE_STEER";
const CURRENT_DONE = "OMP_REMOTE_CURRENT_TURN_DONE";
let callCount = 0;

class ProbeStream {
  constructor() {
    this.queue = [];
    this.waiting = [];
    this.done = false;
    this.final = Promise.withResolvers();
    this.final.promise.catch(() => {});
  }

  push(event) {
    if (this.done) return;
    if (event.type === "done" || event.type === "error") {
      this.done = true;
      this.final.resolve(event.type === "done" ? event.message : event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.queue.push(event);
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift();
      } else if (this.done) {
        return;
      } else {
        const pending = Promise.withResolvers();
        this.waiting.push(pending);
        const result = await pending.promise;
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result() {
    return this.final.promise;
  }

  get hasPendingLocalWork() {
    return false;
  }
}

function append(record) {
  appendFileSync(tracePath, JSON.stringify(record) + "\\n");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    if (typeof block.text === "string") return block.text;
    return "";
  }).join("");
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function wait(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
}

function streamSimple(model, context) {
  const stream = new ProbeStream();
  const call = ++callCount;
  const texts = context.messages.map((message) => contentText(message.content));
  append({
    event: "call",
    call,
    hasInitial: texts.some((text) => text.includes(INITIAL)),
    hasQueue: texts.some((text) => text.includes(QUEUE)),
    hasSteer: texts.some((text) => text.includes(STEER)),
    hasCurrentTurnDone: texts.some((text) => text.includes(CURRENT_DONE)),
    roles: context.messages.map((message) => message.role),
  });

  const partial = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };

  void (async () => {
    stream.push({ type: "start", partial });
    if (call === 1) await wait(750);

    if (call === 1) {
      const toolCall = {
        type: "toolCall",
        id: "omp-remote-probe-tool-1",
        name: "omp_remote_probe_gate",
        arguments: {},
      };
      partial.content.push(toolCall);
      partial.stopReason = "toolUse";
      stream.push({ type: "toolcall_start", contentIndex: 0, partial });
      stream.push({
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "{}",
        partial,
      });
      stream.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall,
        partial,
      });
      stream.push({ type: "done", reason: "toolUse", message: partial });
      append({ event: "complete", call, reason: "toolUse" });
      return;
    }

    const text = texts.some((value) => value.includes(STEER))
      ? "OMP_REMOTE_STEER_DONE"
      : texts.some((value) => value.includes(QUEUE))
        ? "OMP_REMOTE_QUEUE_DONE"
        : CURRENT_DONE;
    const block = { type: "text", text };
    partial.content.push(block);
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
    stream.push({ type: "done", reason: "stop", message: partial });
    append({ event: "complete", call, reason: "stop" });
  })();

  return stream;
}

export default function runtimeProbe(pi) {
  pi.registerProvider("omp-remote-probe", {
    baseUrl: "mock://omp-remote-probe",
    apiKey: "OMP_REMOTE_PROBE_KEY",
    api: "mock",
    streamSimple,
    models: [{
      id: "probe-model",
      name: "OMP Remote Probe",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 1024,
    }],
  });
  pi.registerTool({
    name: "omp_remote_probe_gate",
    label: "OMP Remote Probe Gate",
    description: "Synthetic runtime probe gate.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    approval: "read",
    loadMode: "essential",
    execute: async () => ({
      content: [{ type: "text", text: "OMP_REMOTE_PROBE_TOOL_RESULT" }],
      details: {},
    }),
  });
}
`;
}

async function openClient(port: number, secret: string): Promise<WebSocket> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}`,
    devClientProtocols(secret),
  );
  const opened = Promise.withResolvers<void>();
  socket.addEventListener("open", () => opened.resolve(), { once: true });
  socket.addEventListener(
    "error",
    () => opened.reject(new Error("AgentService WebSocket failed to open")),
    { once: true },
  );
  await withTimeout(opened.promise, "AgentService WebSocket");
  return socket;
}

function sendPrompt(
  socket: WebSocket,
  sessionId: string,
  text: string,
  mode: PromptMode,
): void {
  socket.send(
    JSON.stringify({
      t: "prompt",
      sessionId,
      text,
      mode,
    }),
  );
}

async function runScenario(options: {
  name: "Queue" | "Steer";
  mode: PromptMode;
  activeText: string;
  root: string;
  providerPath: string;
  service: AgentService;
  socket: WebSocket;
  ipcPath: string;
  token: string;
}): Promise<ScenarioResult> {
  const tracePath = join(options.root, `${options.name.toLowerCase()}.jsonl`);
  const agentDir = join(options.root, `${options.name.toLowerCase()}-agent`);
  const cwd = join(options.root, `${options.name.toLowerCase()}-cwd`);
  await Bun.write(join(cwd, ".keep"), "");

  const child = spawn(
    OMP_BIN,
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--model",
      "omp-remote-probe/probe-model",
      "-e",
      BRIDGE_BUNDLE,
      "-e",
      options.providerPath,
    ],
    {
      cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        OMP_REMOTE_MODE: "collab",
        OMP_REMOTE_TOKEN: options.token,
        OMP_REMOTE_IPC_PATH: options.ipcPath,
        OMP_REMOTE_PROBE_KEY: "synthetic-probe-key",
        OMP_REMOTE_PROBE_TRACE: tracePath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const rpc = new RpcProcess(child);

  try {
    const idleState = await rpc.state();
    assert(
      idleState.isStreaming === false,
      `${options.name}: session was not idle`,
    );
    const sessionId = idleState.sessionId;
    assert(
      typeof sessionId === "string" && sessionId.length > 0,
      `${options.name}: get_state omitted sessionId`,
    );
    await waitUntil(
      () => options.service.hasPromptControl(sessionId),
      `${options.name} prompt-control registration`,
    );

    sendPrompt(
      options.socket,
      sessionId,
      "OMP_REMOTE_IDLE_START",
      options.mode,
    );
    await waitUntil(
      async () =>
        (await readTrace(tracePath)).some(
          (record) => record.event === "call" && record.call === 1,
        ),
      `${options.name} idle prompt to start call 1`,
    );

    const activeState = await rpc.state();
    assert(
      activeState.isStreaming === true,
      `${options.name}: active turn was not observable before ${options.name}`,
    );
    sendPrompt(options.socket, sessionId, options.activeText, options.mode);

    const expectedCalls = options.mode === "followUp" ? 3 : 2;
    await waitUntil(
      async () =>
        (await readTrace(tracePath)).some(
          (record) =>
            record.event === "complete" && record.call === expectedCalls,
        ),
      `${options.name} queue drain`,
    );
    await waitUntil(
      async () => (await rpc.state()).isStreaming === false,
      `${options.name} session to return idle`,
    );

    const records = await readTrace(tracePath);
    const calls = records.filter(
      (record): record is TraceCall => record.event === "call",
    );
    const completed = records.filter(
      (record): record is TraceComplete => record.event === "complete",
    );
    return {
      name: options.name,
      idleStarted: calls[0]?.hasInitial === true,
      activeStateObserved: activeState.isStreaming === true,
      calls,
      completed,
    };
  } finally {
    await rpc.close();
  }
}

function verifyQueue(result: ScenarioResult): void {
  assert(result.idleStarted, "Queue: idle prompt did not start a turn");
  assert(result.activeStateObserved, "Queue: active state was not observed");
  assert(
    result.calls.length === 3,
    `Queue: expected 3 calls, got ${result.calls.length}`,
  );
  const [first, currentTurn, queuedTurn] = result.calls;
  assert(
    first?.hasInitial === true,
    "Queue: first call omitted the idle prompt",
  );
  assert(
    currentTurn?.hasQueue === false,
    "Queue: queued prompt leaked into the current tool loop",
  );
  assert(
    queuedTurn?.hasQueue === true,
    "Queue: queued prompt did not drain after the current turn",
  );
  assert(
    queuedTurn?.hasCurrentTurnDone === true,
    "Queue: current turn did not finish before queued prompt drained",
  );
}

function verifySteer(result: ScenarioResult): void {
  assert(result.idleStarted, "Steer: idle prompt did not start a turn");
  assert(result.activeStateObserved, "Steer: active state was not observed");
  assert(
    result.calls.length === 2,
    `Steer: expected 2 calls, got ${result.calls.length}`,
  );
  const [first, steeredTurn] = result.calls;
  assert(
    first?.hasInitial === true,
    "Steer: first call omitted the idle prompt",
  );
  assert(
    steeredTurn?.hasSteer === true,
    "Steer: prompt did not enter the current tool loop",
  );
  assert(
    steeredTurn?.hasCurrentTurnDone === false,
    "Steer: current turn finished normally before the steering prompt",
  );
}

async function main(): Promise<void> {
  await access(BRIDGE_BUNDLE);
  const root = await mkdtemp(join(tmpdir(), "omp-remote-runtime-"));
  const providerPath = join(root, "runtime-provider.mjs");
  await writeFile(providerPath, providerExtension(), "utf8");

  const id = Math.random().toString(36).slice(2);
  const token = `runtime-${id}`;
  const devSecret = `runtime-dev-${id}`;
  const path = ipcAddress(id);
  const service = new AgentService({
    token,
    ipcPath: path,
    devClient: { port: 0, secret: devSecret, allowedOrigins: [] },
    spawn: () => {
      throw new Error(
        "runtime probe must not spawn sessions through AgentService",
      );
    },
  });

  let socket: WebSocket | undefined;
  try {
    await service.start();
    socket = await openClient(service.boundPort, devSecret);
    const queue = await runScenario({
      name: "Queue",
      mode: "followUp",
      activeText: "OMP_REMOTE_ACTIVE_QUEUE",
      root,
      providerPath,
      service,
      socket,
      ipcPath: path,
      token,
    });
    verifyQueue(queue);

    const steer = await runScenario({
      name: "Steer",
      mode: "steer",
      activeText: "OMP_REMOTE_ACTIVE_STEER",
      root,
      providerPath,
      service,
      socket,
      ipcPath: path,
      token,
    });
    verifySteer(steer);

    const summary = {
      queue: {
        idleStarted: queue.idleStarted,
        activeStateObserved: queue.activeStateObserved,
        callCount: queue.calls.length,
        currentTurnSawQueue: queue.calls[1]?.hasQueue ?? null,
        queuedTurnSawQueue: queue.calls[2]?.hasQueue ?? null,
        queuedAfterCurrentTurn: queue.calls[2]?.hasCurrentTurnDone ?? null,
      },
      steer: {
        idleStarted: steer.idleStarted,
        activeStateObserved: steer.activeStateObserved,
        callCount: steer.calls.length,
        currentLoopSawSteer: steer.calls[1]?.hasSteer ?? null,
        currentTurnFinishedFirst: steer.calls[1]?.hasCurrentTurnDone ?? null,
      },
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    socket?.close();
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
