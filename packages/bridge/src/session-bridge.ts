import type {
  CatalogModel,
  CatalogRole,
  ControlErrorFrame,
  Frame,
  InteractionPayload,
  InteractionResponse,
  JobRow,
  ResourceChunkFrame,
  ResourceInitFrame,
  SessionMeta,
  UplinkFrame,
} from "@omp-remote/protocol";
import {
  IpcAuthError,
  type IpcAuthFailureCode,
  type IpcConn,
  connectIpc as defaultConnect,
} from "@omp-remote/protocol/ipc";
import {
  type BridgeDiagnosticSink,
  type PromptDispatchRoute,
  type PromptMode,
  noBridgeDiagnostic,
} from "./diagnostics";

export interface SessionBridgeOptions {
  /** The IPC token, proven to (and by) the host-agent; never sent. */
  token: string;
  path: string;
  meta: SessionMeta;
  /** Connect and mutually authenticate; rejects with `IpcAuthError` when the
   *  endpoint cannot prove the token. */
  connect?: typeof defaultConnect;
  /** Supplemental mode-aware prompt channel used while Collab owns the feed. */
  role?: "prompt-control";
  /** Injectable for tests: a deterministic manual scheduler (no wall-clock timers). */
  scheduler?: ReconnectScheduler;
  /** Privacy-safe operational diagnostics. */
  diagnostic?: BridgeDiagnosticSink;
}

/**
 * Schedules (and cancels) a delayed reconnect. Injectable so tests drive it
 * deterministically (no wall-clock timers).
 */
interface ReconnectScheduler {
  schedule(delayMs: number, run: () => void): void;
  cancel(): void;
}

/** The default `ReconnectScheduler`: a `setTimeout`, cleared on `cancel`/`stop`. */
class TimerScheduler implements ReconnectScheduler {
  #t: Timer | undefined;

  schedule(delayMs: number, run: () => void): void {
    this.cancel();
    this.#t = setTimeout(run, delayMs);
    this.#t.unref?.();
  }

  cancel(): void {
    clearTimeout(this.#t);
    this.#t = undefined;
  }
}

/** A pending interaction awaiting the client's reply. */
interface InteractionWaiter {
  resolve: (response: InteractionResponse | undefined) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

const MAX_QUEUE = 256;
/** Downlink frame types this bridge handles beyond the original set, declared in
 *  its hello so the host-agent only sends frames the bridge can decode. */
const BRIDGE_CAPABILITIES = ["closeSession"] as const;

export class SessionBridge {
  #opts: SessionBridgeOptions;
  #connect: typeof defaultConnect;
  #scheduler: ReconnectScheduler;
  #conn: IpcConn | undefined;
  #queue: UplinkFrame[] = [];
  #promptCbs: ((
    text: string,
    mode: "steer" | "followUp" | "aside",
    attachments?: string[],
  ) => void)[] = [];
  #interruptCbs: (() => void)[] = [];
  #serviceTierCbs: ((enabled: boolean) => void)[] = [];
  #setModelCbs: ((model: string) => void)[] = [];
  #setThinkingLevelCbs: ((level: string) => void)[] = [];
  #compactCbs: ((instructions?: string) => void)[] = [];
  #closeSessionCbs: (() => void)[] = [];
  #resourceInitCbs: ((frame: ResourceInitFrame) => void)[] = [];
  #resourceChunkCbs: ((frame: ResourceChunkFrame) => void)[] = [];
  #resourceAbortCbs: ((transferId: string) => void)[] = [];
  #interactionWaiters = new Map<string, InteractionWaiter>();
  #stopped = false;
  #retryMs = 500;
  #lastReportedRetryMs: number | undefined;
  /** Last handshake failure reported, so a persistent one logs once. */
  #lastAuthFailure: IpcAuthFailureCode | undefined;
  readonly #diagnostic: BridgeDiagnosticSink;

  constructor(opts: SessionBridgeOptions) {
    this.#opts = opts;
    this.#connect = opts.connect ?? defaultConnect;
    this.#scheduler = opts.scheduler ?? new TimerScheduler();
    this.#diagnostic = opts.diagnostic ?? noBridgeDiagnostic;
  }

  async start(): Promise<void> {
    if (this.#stopped) return;
    try {
      const conn = await this.#connect(this.#opts.path, this.#opts.token);
      // stop() may land in the connect gap: never adopt a conn after stop.
      if (this.#stopped) {
        conn.close();
        return;
      }
      this.#conn = conn;
      this.#retryMs = 500;
      this.#lastReportedRetryMs = undefined;
      this.#lastAuthFailure = undefined;
      this.#diagnostic({
        event: "ipc_connected",
        sessionId: this.#opts.meta.id,
        role: this.#opts.role ?? "feed",
      });
      conn.onFrame((f) => {
        if (f.t === "prompt") {
          this.#diagnostic({
            event: "prompt_received",
            sessionId: this.#opts.meta.id,
            mode: f.mode,
            role: this.#opts.role ?? "feed",
          });
        }
        if (this.#opts.role === "prompt-control") {
          this.#dispatchControl(f);
          return;
        }
        if (this.#dispatchControl(f)) return;
        if (f.t === "interrupt") for (const cb of this.#interruptCbs) cb();
        else if (f.t === "interactionReply")
          this.#settleInteraction(f.id, f.response, false);
        else if (f.t === "serviceTier")
          for (const cb of this.#serviceTierCbs) cb(f.enabled);
      });
      conn.onClose(() => {
        this.#conn = undefined;
        this.#scheduleReconnect("connection-closed");
      });
      // The handshake proved the token both ways; it never goes on the wire.
      const hello: Frame = {
        t: "hello",
        session: this.#opts.meta,
        capabilities: [...BRIDGE_CAPABILITIES],
      };
      if (this.#opts.role) hello.role = this.#opts.role;
      conn.send(hello);
      for (const f of this.#queue.splice(0)) conn.send(f);
    } catch (err) {
      if (!(err instanceof IpcAuthError)) {
        this.#scheduleReconnect("connect-failed");
        return;
      }
      // Refused: the endpoint did not prove the token (an older host-agent, a
      // different token, or another process holding the endpoint). Nothing but
      // nonces and our own proof was sent; keep retrying for a real agent.
      if (err.code !== this.#lastAuthFailure) {
        this.#lastAuthFailure = err.code;
        this.#diagnostic({
          event: "ipc_auth_failed",
          sessionId: this.#opts.meta.id,
          role: this.#opts.role ?? "feed",
          code: err.code,
        });
      }
      this.#scheduleReconnect("auth-failed");
    }
  }

  #scheduleReconnect(
    code: "connect-failed" | "connection-closed" | "auth-failed",
  ): void {
    if (this.#stopped) return;
    const delay = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, 30_000);
    if (delay !== this.#lastReportedRetryMs) {
      this.#lastReportedRetryMs = delay;
      this.#diagnostic({
        event: "ipc_reconnect_scheduled",
        sessionId: this.#opts.meta.id,
        role: this.#opts.role ?? "feed",
        retryDelayMs: delay,
        code,
      });
    }
    this.#scheduler.schedule(delay, () => {
      void this.start();
    });
  }

  #send(frame: UplinkFrame): void {
    if (this.#conn) this.#conn.send(frame);
    else {
      this.#queue.push(frame);
      if (this.#queue.length > MAX_QUEUE) this.#queue.shift();
    }
  }

  emitState(s: {
    model: string;
    thinkingLevel?: string;
    contextPct?: number;
    contextTokens?: number;
    contextWindow?: number;
    streaming: boolean;
    title: string;
    fastMode?: boolean;
  }): void {
    this.#send({ t: "state", sessionId: this.#opts.meta.id, ...s });
  }
  emitMsg(p: {
    phase: "start" | "update" | "end";
    msgId: string;
    role: string;
    text: string;
  }): void {
    this.#send({ t: "msg", sessionId: this.#opts.meta.id, ...p });
  }
  emitTool(p: {
    phase: "start" | "update" | "end";
    callId: string;
    name: string;
    status: string;
    preview: string;
  }): void {
    this.#send({ t: "tool", sessionId: this.#opts.meta.id, ...p });
  }
  emitJobs(p: { running: JobRow[]; recent: number }): void {
    this.#send({
      t: "jobs",
      sessionId: this.#opts.meta.id,
      running: p.running,
      recent: p.recent,
    });
  }
  emitCatalog(p: {
    models: CatalogModel[];
    roles: CatalogRole[];
    currentId?: string;
    currentEffort?: string;
    configured: boolean;
  }): void {
    this.#send({
      t: "modelCatalog",
      sessionId: this.#opts.meta.id,
      models: p.models,
      roles: p.roles,
      currentId: p.currentId,
      currentEffort: p.currentEffort,
      configured: p.configured,
    });
  }
  emitResourceProgress(transferId: string, received: number): void {
    this.#send({
      t: "resourceProgress",
      sessionId: this.#opts.meta.id,
      transferId,
      received,
    });
  }
  emitResourceReady(transferId: string, resourceId: string): void {
    this.#send({
      t: "resourceReady",
      sessionId: this.#opts.meta.id,
      transferId,
      resourceId,
    });
  }
  emitResourceError(
    transferId: string,
    code: "too-large" | "integrity" | "expired" | "unsupported" | "internal",
  ): void {
    this.#send({
      t: "resourceError",
      sessionId: this.#opts.meta.id,
      transferId,
      code,
    });
  }
  emitMediaInit(p: {
    mediaId: string;
    anchor: { kind: "message"; msgId: string };
    mimeType: string;
    size: number;
    totalChunks: number;
  }): void {
    this.#send({ t: "mediaInit", sessionId: this.#opts.meta.id, ...p });
  }
  emitMediaChunk(p: { mediaId: string; index: number; data: string }): void {
    this.#send({ t: "mediaChunk", sessionId: this.#opts.meta.id, ...p });
  }
  emitMediaError(mediaId: string, code: "too-large" | "internal"): void {
    this.#send({
      t: "mediaError",
      sessionId: this.#opts.meta.id,
      mediaId,
      code,
    });
  }
  emitAttention(reason: "idle" | "approval"): void {
    this.#send({ t: "attention", sessionId: this.#opts.meta.id, reason });
  }
  /** A phone control reached omp but the operation itself failed. */
  emitControlFailed(
    action: ControlErrorFrame["action"],
    message: string,
  ): void {
    this.#send({
      t: "controlError",
      sessionId: this.#opts.meta.id,
      action,
      code: "control-failed",
      message,
    });
  }
  onPrompt(
    cb: (
      text: string,
      mode: "steer" | "followUp" | "aside",
      attachments?: string[],
    ) => void,
  ): void {
    this.#promptCbs.push(cb);
  }
  onInterrupt(cb: () => void): void {
    this.#interruptCbs.push(cb);
  }
  onServiceTier(cb: (enabled: boolean) => void): void {
    this.#serviceTierCbs.push(cb);
  }
  onSetModel(cb: (model: string) => void): void {
    this.#setModelCbs.push(cb);
  }
  onSetThinkingLevel(cb: (level: string) => void): void {
    this.#setThinkingLevelCbs.push(cb);
  }
  onCompact(cb: (instructions?: string) => void): void {
    this.#compactCbs.push(cb);
  }
  onCloseSession(cb: () => void): void {
    this.#closeSessionCbs.push(cb);
  }
  onResourceInit(cb: (frame: ResourceInitFrame) => void): void {
    this.#resourceInitCbs.push(cb);
  }
  onResourceChunk(cb: (frame: ResourceChunkFrame) => void): void {
    this.#resourceChunkCbs.push(cb);
  }
  onResourceAbort(cb: (transferId: string) => void): void {
    this.#resourceAbortCbs.push(cb);
  }
  /** Dispatch an inbound extension-targeted control frame (prompt / model /
   *  thinking / compact / close / resources) to its callbacks. Returns true when
   *  `f` was one of those, so the feed branch can fall through to its own frame
   *  types. */
  #dispatchControl(f: Frame): boolean {
    if (f.t === "prompt") {
      for (const cb of this.#promptCbs) cb(f.text, f.mode, f.attachments);
      return true;
    }
    if (f.t === "setModel") {
      for (const cb of this.#setModelCbs) cb(f.model);
      return true;
    }
    if (f.t === "setThinkingLevel") {
      for (const cb of this.#setThinkingLevelCbs) cb(f.level);
      return true;
    }
    if (f.t === "compact") {
      for (const cb of this.#compactCbs) cb(f.instructions);
      return true;
    }
    if (f.t === "closeSession") {
      for (const cb of this.#closeSessionCbs) cb();
      return true;
    }
    if (f.t === "resourceInit") {
      for (const cb of this.#resourceInitCbs) cb(f);
      return true;
    }
    if (f.t === "resourceChunk") {
      for (const cb of this.#resourceChunkCbs) cb(f);
      return true;
    }
    if (f.t === "resourceAbort") {
      for (const cb of this.#resourceAbortCbs) cb(f.transferId);
      return true;
    }
    return false;
  }
  reportPromptDispatch(mode: PromptMode, route: PromptDispatchRoute): void {
    this.#diagnostic({
      event: "prompt_dispatch_accepted",
      sessionId: this.#opts.meta.id,
      mode,
      route,
      execution: "unconfirmed",
    });
  }

  reportModelExecutionStarted(): void {
    this.#diagnostic({
      event: "model_execution_started",
      sessionId: this.#opts.meta.id,
    });
  }

  /**
   * Raise an interaction (a question or a tool approval) to the connected client and
   * await the reply. Resolves the client's response, or `undefined` if the request is
   * aborted via `signal` before a reply arrives — in which case the client is told to
   * dismiss it (`interactionEnd`). First reply wins; a later reply for the same `id`
   * finds no waiter and is ignored.
   */
  raiseInteraction(
    id: string,
    payload: InteractionPayload,
    signal?: AbortSignal,
  ): Promise<InteractionResponse | undefined> {
    const { promise, resolve } = Promise.withResolvers<
      InteractionResponse | undefined
    >();
    if (this.#stopped || signal?.aborted) {
      resolve(undefined);
      return promise;
    }
    const onAbort = () => this.#settleInteraction(id, undefined, true);
    this.#interactionWaiters.set(id, { resolve, signal, onAbort });
    signal?.addEventListener("abort", onAbort, { once: true });
    this.#send({
      t: "interaction",
      sessionId: this.#opts.meta.id,
      id,
      payload,
    });
    return promise;
  }

  /**
   * Settle a pending interaction exactly once. `cancel` tells the client to dismiss its
   * prompt (the interaction was aborted or answered locally); a real reply passes
   * `cancel: false`. No-op if the id is already settled (first-answer-wins).
   */
  #settleInteraction(
    id: string,
    response: InteractionResponse | undefined,
    cancel: boolean,
  ): void {
    const waiter = this.#interactionWaiters.get(id);
    if (!waiter) return;
    this.#interactionWaiters.delete(id);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    if (cancel)
      this.#send({
        t: "interactionEnd",
        sessionId: this.#opts.meta.id,
        id,
        reason: "cancelled",
      });
    waiter.resolve(response);
  }

  stop(): void {
    this.#stopped = true;
    this.#scheduler.cancel();
    for (const [id, waiter] of this.#interactionWaiters) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(undefined);
      this.#interactionWaiters.delete(id);
    }
    if (this.#opts.role !== "prompt-control")
      this.#conn?.send({ t: "bye", sessionId: this.#opts.meta.id });
    this.#conn?.close();
    this.#conn = undefined;
  }
}
