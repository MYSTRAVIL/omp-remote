// Minimal, disposable JSON-lines RPC client for the parity probes (overnight run
// `2026-09-12-parity-preview`). It speaks the real `omp --mode rpc` wire protocol
// (newline-delimited JSON on stdin/stdout) directly, so the probe exercises the
// actual transport rather than a mock.
//
// Wire protocol (source: pi-coding-agent `modes/rpc/rpc-types.ts`,
// `modes/rpc/rpc-mode.ts`, tag v18.1.x):
//   - Client -> server: one JSON object per line. Requests carry `{ id, type, ... }`.
//   - Server -> client, one JSON object per line:
//       * `{ type: "ready", protocolVersion, supportedProtocolVersions, ... }` on startup.
//       * `{ id?, type: "response", command, success, data?/error?, code? }` per request.
//       * `{ type: "extension_ui_request", id, method, ... }` when an extension raises a dialog.
//       * session/subagent/other event frames (collected, not correlated).
//
// This client stays on protocol v1 (it never sends `negotiate_protocol`), so the
// server never chunks frames and every logical frame is exactly one JSON line. It is
// a probe utility, not production code: production reaches sessions through the
// bridge, never a second RPC control route. Inbound frames are validated with
// explicit guards (this file is standalone under `scripts/`, with no access to the
// workspace `zod`); nothing is cast from `any`.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Server->client `ready` frame; the observed readiness gate for the probe. */
export interface ReadyFrame {
  type: "ready";
  protocolVersion: number;
  supportedProtocolVersions: number[];
  maxFrameBytes: number;
  maxReassembledFrameBytes: number;
}

/** Server->client extension dialog request (a bridged `ctx.ui.*` call). */
export interface ExtensionUiRequestFrame {
  type: "extension_ui_request";
  id: string;
  method: string;
  [key: string]: unknown;
}

/** Client->server reply to an `extension_ui_request`. */
export type ExtensionUiReply = {
  type: "extension_ui_response";
  id: string;
} & Record<string, unknown>;
export type ExtensionUiHandler = (
  frame: ExtensionUiRequestFrame,
) => ExtensionUiReply | undefined | Promise<ExtensionUiReply | undefined>;

export interface RpcProbeOptions {
  /** omp executable; defaults to `$OMP_BIN` then `omp` on PATH. */
  ompBin?: string;
  /** Working directory for the spawned session; a disposable temp dir by default. */
  cwd?: string;
  /** Extra CLI args appended after the isolation flags (e.g. `-e <ext>`). */
  extraArgs?: string[];
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Readiness timeout in ms (default 30_000). */
  readyTimeoutMs?: number;
  /** Per-request timeout in ms (default 20_000). */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: Timer;
  command: string;
}

/** Narrow an unknown value to a plain string-keyed record (post object check). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  // `value` is JSON.parse output; assert only after the runtime object check.
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Path to the disposable probe extension shipped alongside this client. */
export function probeExtensionPath(): string {
  return join(
    fileURLToPath(new URL(".", import.meta.url)),
    "probe-extension.ts",
  );
}

/**
 * The isolation flags every probe session launches with: no persisted session, no
 * global extension/skill/rule discovery. The probe extension is loaded explicitly
 * via `extraArgs` (`-e <path>`), which is the only extension in the process.
 */
export const RPC_ISOLATION_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
] as const;

/** A live `omp --mode rpc` probe session. Deterministic start/stop; no globals. */
export class RpcProbeClient {
  readonly #opts: RpcProbeOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #stdoutBuf = "";
  #stderr = "";
  #nextId = 1;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #events: Array<Record<string, unknown>> = [];
  #ready: ReadyFrame | undefined;
  #uiHandler: ExtensionUiHandler | undefined;
  #tempCwd: string | undefined;
  #exited = false;
  readonly #readyResolvers = Promise.withResolvers<ReadyFrame>();

  constructor(opts: RpcProbeOptions = {}) {
    this.#opts = opts;
  }

  /** All non-response, non-ready frames seen so far (session/subagent events, etc.). */
  get events(): ReadonlyArray<Record<string, unknown>> {
    return this.#events;
  }

  /** The observed `ready` frame, or undefined before startup completes. */
  get ready(): ReadyFrame | undefined {
    return this.#ready;
  }

  /** Install a handler that answers `extension_ui_request` frames. */
  onExtensionUiRequest(handler: ExtensionUiHandler): void {
    this.#uiHandler = handler;
  }

  /** Spawn the RPC session and resolve once the server emits its `ready` frame. */
  async start(): Promise<ReadyFrame> {
    let cwd = this.#opts.cwd;
    if (cwd === undefined) {
      cwd = mkdtempSync(join(tmpdir(), "omp-parity-probe-"));
      this.#tempCwd = cwd;
    }
    const bin = this.#opts.ompBin ?? process.env.OMP_BIN ?? "omp";
    const args = [...RPC_ISOLATION_ARGS, ...(this.#opts.extraArgs ?? [])];
    const child = spawn(bin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.#opts.env },
    });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    child.on("exit", () => {
      this.#exited = true;
      const err = new Error("RPC process exited before responding");
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.#pending.clear();
      if (this.#ready === undefined) {
        const tail = this.#stderr.slice(-2000);
        this.#readyResolvers.reject(
          new Error(
            `omp --mode rpc exited before the ready frame. stderr tail: ${tail}`,
          ),
        );
      }
    });
    child.on("error", (err) => this.#readyResolvers.reject(err));

    const timeoutMs = this.#opts.readyTimeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      this.#readyResolvers.reject(
        new Error(`RPC session not ready within ${timeoutMs}ms`),
      );
    }, timeoutMs);
    try {
      return await this.#readyResolvers.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Send a request frame and await its correlated response `data`. */
  request(
    type: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const child = this.#child;
    if (!child || this.#exited)
      return Promise.reject(new Error("RPC session is not running"));
    const id = String(this.#nextId++);
    const frame = { id, type, ...params };
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timeoutMs = this.#opts.requestTimeoutMs ?? 20_000;
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(
        new Error(
          `RPC request '${type}' (id ${id}) timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    this.#pending.set(id, { resolve, reject, timer, command: type });
    child.stdin.write(`${JSON.stringify(frame)}\n`);
    return promise;
  }

  /** Send a fire-and-forget frame (no correlated response awaited). */
  send(frame: Record<string, unknown>): void {
    const child = this.#child;
    if (!child || this.#exited) throw new Error("RPC session is not running");
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  getState(): Promise<unknown> {
    return this.request("get_state");
  }

  getAvailableCommands(): Promise<unknown> {
    return this.request("get_available_commands");
  }

  getMessagesPage(
    options: { cursor?: string; limit?: number } = {},
  ): Promise<unknown> {
    return this.request("get_messages_page", options);
  }

  getSubagents(): Promise<unknown> {
    return this.request("get_subagents");
  }

  /** Invoke a slash command through the prompt pipeline (extension commands run locally). */
  prompt(message: string): Promise<unknown> {
    return this.request("prompt", { message });
  }

  /** Collected stderr text from the child process (best-effort diagnostics). */
  getStderr(): string {
    return this.#stderr;
  }

  /** Kill the process, await exit, and remove the disposable temp dir. */
  async close(): Promise<void> {
    const child = this.#child;
    if (child && !this.#exited) {
      const exited = Promise.withResolvers<void>();
      child.once("exit", () => exited.resolve());
      child.kill();
      const watchdog = Promise.withResolvers<void>();
      const timer = setTimeout(() => watchdog.resolve(), 5_000);
      try {
        await Promise.race([exited.promise, watchdog.promise]);
      } finally {
        clearTimeout(timer);
      }
      if (!this.#exited) child.kill("SIGKILL");
    }
    if (this.#tempCwd) {
      try {
        rmSync(this.#tempCwd, { recursive: true, force: true });
      } catch {
        // Disposable dir; ignore cleanup races on Windows file locks.
      }
      this.#tempCwd = undefined;
    }
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuf += chunk;
    let newline = this.#stdoutBuf.indexOf("\n");
    while (newline >= 0) {
      const line = this.#stdoutBuf.slice(0, newline).trim();
      this.#stdoutBuf = this.#stdoutBuf.slice(newline + 1);
      if (line.length > 0) this.#onLine(line);
      newline = this.#stdoutBuf.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      // Non-JSON stdout noise; ignore so one bad line never stalls the protocol.
      return;
    }
    const rec = asRecord(json);
    if (!rec) return;
    const type = rec.type;
    if (type === "ready") {
      const ready = this.#parseReady(rec);
      if (ready) {
        this.#ready = ready;
        this.#readyResolvers.resolve(ready);
      }
      return;
    }
    if (type === "response") {
      this.#onResponse(rec);
      return;
    }
    if (
      type === "extension_ui_request" &&
      typeof rec.id === "string" &&
      typeof rec.method === "string"
    ) {
      void this.#handleUiRequest({
        ...rec,
        type: "extension_ui_request",
        id: rec.id,
        method: rec.method,
      });
      return;
    }
    this.#events.push(rec);
  }

  #parseReady(rec: Record<string, unknown>): ReadyFrame | undefined {
    if (typeof rec.protocolVersion !== "number") return undefined;
    if (typeof rec.maxFrameBytes !== "number") return undefined;
    if (typeof rec.maxReassembledFrameBytes !== "number") return undefined;
    const versions = rec.supportedProtocolVersions;
    const supported = Array.isArray(versions)
      ? versions.filter((v): v is number => typeof v === "number")
      : [];
    return {
      type: "ready",
      protocolVersion: rec.protocolVersion,
      supportedProtocolVersions: supported,
      maxFrameBytes: rec.maxFrameBytes,
      maxReassembledFrameBytes: rec.maxReassembledFrameBytes,
    };
  }

  #onResponse(rec: Record<string, unknown>): void {
    const id = typeof rec.id === "string" ? rec.id : undefined;
    if (id === undefined) return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (rec.success === true) {
      pending.resolve(rec.data);
    } else {
      const command =
        typeof rec.command === "string" ? rec.command : pending.command;
      const message =
        typeof rec.error === "string" ? rec.error : "unknown error";
      const suffix = typeof rec.code === "string" ? ` [${rec.code}]` : "";
      pending.reject(new Error(`RPC '${command}' failed: ${message}${suffix}`));
    }
  }

  async #handleUiRequest(frame: ExtensionUiRequestFrame): Promise<void> {
    this.#events.push(frame);
    const handler = this.#uiHandler;
    if (!handler) return;
    const reply = await handler(frame);
    if (reply && !this.#exited) this.send(reply);
  }
}
