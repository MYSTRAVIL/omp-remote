import { timingSafeEqual } from "node:crypto";
import {
  type ClientMessage,
  type CloseSessionFrame,
  DEV_CLIENT_PROTOCOL,
  type DownlinkCommand,
  DownlinkFrame,
  type HistoryRequestFrame,
  type InteractionEndFrame,
  type InteractionFrame,
  type MediaChunkFrame,
  type MediaErrorFrame,
  type MediaFetchFrame,
  type MediaInitFrame,
  type MsgFrame,
  type Scheduler,
  type SessionMeta,
  type UplinkFrame,
  defaultScheduler,
  devClientSecretOffered,
} from "@omp-remote/protocol";
import { type IpcConn, IpcServer } from "@omp-remote/protocol/ipc";
import type { Server, ServerWebSocket } from "bun";
import { type AgentDiagnosticSink, noAgentDiagnostic } from "./diagnostics";
import { findStoredSession, listStoredSessions } from "./history";
import { NotifyPolicy } from "./notify-policy";
import { Registry } from "./registry";
import { type SpawnHandle, type SpawnOptions, spawnSession } from "./spawn";

/** Commands delivered over the session's mode-aware IPC prompt control. */
type PromptControlCommand = Extract<
  DownlinkCommand,
  {
    t:
      | "prompt"
      | "setModel"
      | "setThinkingLevel"
      | "compact"
      | "resourceInit"
      | "resourceChunk"
      | "resourceAbort";
  }
>;
/** Commands Collab owns when present, else the session's IPC feed. */
type SessionCommand = Extract<
  DownlinkCommand,
  { t: "interrupt" | "serviceTier" | "interactionReply" }
>;

const PROMPT_CONTROL_UNAVAILABLE =
  "Queue and Steer are unavailable for this session. Restart OMP to load the updated remote bridge, then try again.";
const CLOSE_UNSUPPORTED =
  "This session's remote bridge is too old to end it from the phone. Restart OMP once to enable End session.";

/** The loopback dev client: a WebSocket on 127.0.0.1 for local tools and the
 *  localhost web build, carrying the same unsealed feed and controls. */
export interface DevClientConfig {
  /** TCP port on 127.0.0.1; `0` picks a free port (read back via `boundPort`). */
  port: number;
  /** Per-install secret a client offers as the `omp-remote-dev.<secret>` subprotocol. */
  secret: string;
  /** Browser origins allowed to connect. A request without an `Origin` header
   *  (a local non-browser tool) needs only the secret. */
  allowedOrigins: readonly string[];
}

export interface AgentConfig {
  /** The IPC token: bridges prove it in the IPC handshake; bridges that predate
   *  the handshake present it in their `hello`. */
  token: string;
  ipcPath: string;
  /** Opt-in loopback dev client; without it the agent listens on no TCP port. */
  devClient?: DevClientConfig;
  /** Launch a new omp session on a `spawn` control frame. Injected for tests;
   * defaults to the real `spawnSession`. */
  spawn?: (opts: SpawnOptions) => SpawnHandle | Promise<SpawnHandle>;
  /** Privacy-safe operational diagnostics; omitted by tests and embedders. */
  diagnostic?: AgentDiagnosticSink;
  /** Timer source (the unreachable-session grace); injected in tests. */
  scheduler?: Scheduler;
  /** Where a phone's `notifyPolicy` is kept (the uplink's notifier reads it);
   *  defaults to one held in memory only. */
  notifyPolicy?: NotifyPolicy;
  /** omp's agent directory, whose session store answers a `historyRequest`
   *  and vouches for a resume spawn; defaults to omp's own. Tests pass one. */
  agentDir?: string;
}

/** Compare a presented credential in constant time (lengths are not secret). */
function credentialMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** How long a running session may lack a transcript source (Collab room or IPC
 *  feed) before the phone lists it as unreachable. Covers normal Collab
 *  discovery, so a freshly started session does not flash as unreachable. */
const UNREACHABLE_GRACE_MS = 20_000;

/** Handle returned to a Collab guest adapter registered as a non-IPC session source. */
export interface CollabRegistration {
  /** Relay a translated uplink frame from the Collab session to connected clients. */
  emit(frame: UplinkFrame): void;
  /** Deregister the session when its room closes or the adapter stops. */
  close(): void;
}

/** Cap on retained transcript entries per session (drop-oldest); bounds the
 *  memory a long-running session's backfill buffer can consume. */
const HISTORY_MAX = 1000;
/** A session's retained frames, keyed `m:<msgId>` / `t:<callId>` / `state` /
 *  `jobs`, coalesced to the latest per key with insertion order kept for replay. */
type SessionHistory = Map<string, UplinkFrame>;
/** Per-session budget (base64 chars) for retained downlink media. Enough for a
 *  handful of screenshots; oldest images evict first so a reconnecting phone
 *  can still fetch recent images without unbounded host memory. */
const MEDIA_RETAIN_BYTES = 16 * 1024 * 1024;
/** One retained image: its live `mediaInit` and the ordered `mediaChunk`s so far. */
interface RetainedMedia {
  init: MediaInitFrame;
  chunks: MediaChunkFrame[];
  bytes: number;
}

export class AgentService {
  #cfg: AgentConfig;
  #registry = new Registry();
  #ipc: IpcServer;
  #conns = new Map<string, IpcConn>();
  #promptControls = new Map<string, IpcConn>();
  #collab = new Map<string, (frame: DownlinkFrame) => void>();
  /** spawnId echoed by a bridge hello, keyed by session. Collab sessions take
   *  their snapshot meta from the collab controller (which has no spawnId), so
   *  the snapshot is enriched from here to preserve the phone's spawn match. */
  #spawnIds = new Map<string, string>();
  /** Hello meta of each live prompt-control bridge: the host-agent knows these
   *  omp sessions are running even when no Collab room or feed carries them. */
  #promptControlMeta = new Map<string, SessionMeta>();
  /** Prompt-control sessions past the grace period, with their grace timers. */
  #graceExpired = new Set<string>();
  #graceTimers = new Map<string, () => void>();
  /** Downlink capabilities each live bridge conn declared in its hello; a
   *  frame type absent here is never sent to that conn (its decoder would drop
   *  the socket). Removed when the conn closes. */
  #capabilities = new Map<IpcConn, ReadonlySet<string>>();
  readonly #scheduler: Scheduler;
  /** Per-session retained transcript, for backfilling a (re)connecting client. */
  #history = new Map<string, SessionHistory>();
  /** Per-session interactions still awaiting an answer, keyed by id, replayed so
   *  a (re)connecting client is asked again. Settled by `interactionEnd` or by a
   *  forwarded phone answer. */
  #pending = new Map<string, Map<string, InteractionFrame>>();
  /** Per-session retained images (init + chunks). A (re)connecting client's
   *  replay only announces them (`deferred`); `mediaFetch` sends one in full.
   *  Bounded per session by MEDIA_RETAIN_BYTES. */
  #media = new Map<string, Map<string, RetainedMedia>>();
  #clients = new Set<ServerWebSocket<undefined>>();
  #sinks = new Set<(msg: ClientMessage) => void>();
  #http: Server<undefined> | undefined;
  readonly #spawn: (opts: SpawnOptions) => SpawnHandle | Promise<SpawnHandle>;
  readonly #diagnostic: AgentDiagnosticSink;
  readonly #notifyPolicy: NotifyPolicy;

  constructor(cfg: AgentConfig) {
    this.#cfg = cfg;
    this.#spawn = cfg.spawn ?? spawnSession;
    this.#diagnostic = cfg.diagnostic ?? noAgentDiagnostic;
    this.#scheduler = cfg.scheduler ?? defaultScheduler;
    this.#notifyPolicy = cfg.notifyPolicy ?? new NotifyPolicy();
    this.#ipc = new IpcServer({
      token: cfg.token,
      onAuthFailure: (code) =>
        this.#diagnostic({
          event: "ipc_session_rejected",
          code:
            code === "token-mismatch"
              ? "authentication-failed"
              : "handshake-invalid",
        }),
    });
  }

  /** The dev client's TCP port (resolves `port: 0`); throws unless it is enabled and started. */
  get boundPort(): number {
    const port = this.#http?.port;
    if (port === undefined) throw new Error("dev client not listening");
    return port;
  }

  async start(): Promise<void> {
    this.#registry.onChange(() => this.#broadcastSnapshot());

    this.#ipc.onConnection((conn) => this.#onSession(conn));
    await this.#ipc.listen(this.#cfg.ipcPath);

    const dev = this.#cfg.devClient;
    if (!dev) return;
    const self = this;
    this.#http = Bun.serve({
      hostname: "127.0.0.1",
      port: dev.port,
      // Authenticate before upgrading: a rejected request is never upgraded, so
      // it never reaches `open` and never receives the replay.
      fetch(req, server) {
        const origin = req.headers.get("origin");
        if (origin !== null && !dev.allowedOrigins.includes(origin))
          return new Response("Forbidden", { status: 403 });
        const secret = devClientSecretOffered(
          req.headers.get("sec-websocket-protocol"),
        );
        if (secret === undefined || !credentialMatches(secret, dev.secret))
          return new Response("Unauthorized", { status: 401 });
        // Select one offered protocol: a browser fails the handshake unless the
        // response names one it offered. Never echo the secret-bearing entry.
        const upgraded = server.upgrade(req, {
          headers: { "Sec-WebSocket-Protocol": DEV_CLIENT_PROTOCOL },
        });
        if (upgraded) return undefined;
        return new Response("Upgrade Required", {
          status: 426,
          headers: { Upgrade: "websocket" },
        });
      },
      websocket: {
        open(ws) {
          self.#clients.add(ws);
          self.#diagnostic({ event: "client_connected" });
          for (const msg of self.replay()) ws.send(JSON.stringify(msg));
        },
        message(_ws, raw) {
          self.#onClientMessage(raw);
        },
        close(ws) {
          self.#clients.delete(ws);
          self.#diagnostic({ event: "client_disconnected" });
        },
      },
    });
  }

  async stop(): Promise<void> {
    this.#http?.stop(true);
    for (const cancel of this.#graceTimers.values()) cancel();
    this.#graceTimers.clear();
    await this.#ipc.close();
  }

  #onSession(conn: IpcConn): void {
    let sessionId: string | undefined;
    let role: "feed" | "prompt-control" = "feed";
    conn.onFrame((f) => {
      if (f.t === "hello") {
        if (sessionId) return;
        // A handshake-authenticated bridge already proved the token; one that
        // predates the handshake must present it in its hello.
        const presented = f.token;
        const current =
          conn.authenticated ||
          (presented !== undefined &&
            credentialMatches(presented, this.#cfg.token));
        if (!current) {
          this.#diagnostic({
            event: "ipc_session_rejected",
            code: "authentication-failed",
          });
          conn.close();
          return;
        }
        sessionId = f.session.id;
        this.#capabilities.set(conn, new Set(f.capabilities));
        if (f.role === "prompt-control") {
          role = "prompt-control";
          const previous = this.#promptControls.get(sessionId);
          this.#promptControls.set(sessionId, conn);
          this.#promptControlMeta.set(sessionId, f.session);
          this.#startGrace(sessionId);
          if (f.session.spawnId) {
            this.#spawnIds.set(sessionId, f.session.spawnId);
            this.#broadcastSnapshot();
          }
          conn.send({ t: "promptControlReady", sessionId });
          this.#diagnostic({
            event: "ipc_session_connected",
            sessionId,
            role,
          });
          if (previous && previous !== conn) previous.close();
          return;
        }
        this.#conns.set(sessionId, conn);
        this.#registry.upsert(f.session);
        this.#diagnostic({
          event: "ipc_session_connected",
          sessionId,
          role,
        });
        return;
      }
      if (!sessionId) return;
      // Prompt-control conns emit a whitelist (catalog + jobs + resource results +
      // control errors) for Collab sessions; they do not carry feed frames.
      if (role === "prompt-control") {
        // Inbound, a prompt-control conn drives prompt + model/resource controls;
        // outbound it may relay ONLY the catalog, the async-job snapshot, resource
        // results, and control errors — never the feed frames (state/msg/tool/bye)
        // Collab already owns.
        if (
          f.t === "modelCatalog" ||
          f.t === "jobs" ||
          f.t === "resourceProgress" ||
          f.t === "resourceReady" ||
          f.t === "resourceError" ||
          f.t === "controlError"
        ) {
          this.#relayToClients(f);
        }
        return;
      }
      if (f.t === "bye") {
        this.#registry.remove(f.sessionId);
        this.#conns.delete(f.sessionId);
        this.#dropRetained(f.sessionId);
        this.#spawnIds.delete(f.sessionId);
        return;
      }
      if (
        f.t === "state" ||
        f.t === "msg" ||
        f.t === "tool" ||
        f.t === "jobs" ||
        f.t === "interaction" ||
        f.t === "interactionEnd" ||
        f.t === "modelCatalog" ||
        f.t === "resourceProgress" ||
        f.t === "resourceReady" ||
        f.t === "resourceError" ||
        f.t === "mediaInit" ||
        f.t === "mediaChunk" ||
        f.t === "mediaError" ||
        f.t === "controlError"
      ) {
        this.#relayToClients(f);
      }
    });
    conn.onClose(() => {
      if (!sessionId) return;
      this.#capabilities.delete(conn);
      this.#diagnostic({
        event: "ipc_session_disconnected",
        sessionId,
        role,
      });
      if (role === "prompt-control") {
        if (this.#promptControls.get(sessionId) === conn) {
          this.#promptControls.delete(sessionId);
          this.#spawnIds.delete(sessionId);
          this.#promptControlMeta.delete(sessionId);
          this.#graceTimers.get(sessionId)?.();
          this.#graceTimers.delete(sessionId);
          if (this.#graceExpired.delete(sessionId)) this.#broadcastSnapshot();
        }
        return;
      }
      if (this.#conns.get(sessionId) === conn) {
        this.#registry.remove(sessionId);
        this.#conns.delete(sessionId);
        this.#dropRetained(sessionId);
        this.#spawnIds.delete(sessionId);
      }
    });
  }

  #onClientMessage(raw: string | Buffer): void {
    let json: unknown;
    try {
      json = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      this.#diagnostic({
        event: "client_frame_rejected",
        code: "invalid-json",
      });
      return;
    }
    const parsed = DownlinkFrame.safeParse(json);
    if (!parsed.success) {
      this.#diagnostic({
        event: "client_frame_rejected",
        code: "invalid-frame",
      });
      return;
    }
    // A loopback client is replayed on open; `sync` is a sealed-transport request.
    if (parsed.data.t === "sync") return;
    this.deliverDownlink(parsed.data);
  }

  /** The current machine-local session list snapshot as an object. */
  snapshot(): ClientMessage {
    const listed = new Set<string>();
    const sessions = this.#registry.list().map((e) => {
      listed.add(e.meta.id);
      // A collab session's registry meta lacks the phone's spawn nonce; restore
      // it from the bridge hello so the PWA can match the session it started.
      const spawnId = e.meta.spawnId ?? this.#spawnIds.get(e.meta.id);
      return spawnId ? { ...e.meta, spawnId } : e.meta;
    });
    // Running sessions with no transcript source (their Collab host stopped or
    // wedged): list them as unreachable rather than let them vanish.
    for (const id of this.#graceExpired) {
      const meta = this.#promptControlMeta.get(id);
      if (meta && !listed.has(id)) sessions.push({ ...meta, reachable: false });
    }
    return { t: "sessions", sessions };
  }

  /** (Re)start the unreachable grace for a prompt-control session. */
  #startGrace(sessionId: string): void {
    this.#graceTimers.get(sessionId)?.();
    this.#graceTimers.set(
      sessionId,
      this.#scheduler.setTimer(() => {
        this.#graceTimers.delete(sessionId);
        this.#graceExpired.add(sessionId);
        this.#broadcastSnapshot();
      }, UNREACHABLE_GRACE_MS),
    );
  }

  /** A (re)connecting client's backfill: the session list, then per live
   *  session its retained transcript (coalesced) and latest state, the
   *  interactions still awaiting an answer, and a `deferred` announcement of each
   *  retained image — never its chunks, which the phone pulls with `mediaFetch`
   *  when it shows the image. History and the footer render at once instead of
   *  waiting for new activity. The phone triggers this by sending `sync` on
   *  connect/reconnect; the uplink also sends it on every (re)open. */
  replay(): ClientMessage[] {
    const out: ClientMessage[] = [this.snapshot()];
    for (const { meta } of this.#registry.list()) {
      const history = this.#history.get(meta.id);
      if (history) for (const frame of history.values()) out.push(frame);
      const pending = this.#pending.get(meta.id);
      if (pending) for (const frame of pending.values()) out.push(frame);
      const media = this.#media.get(meta.id);
      if (media)
        for (const { init } of media.values())
          out.push({ ...init, deferred: true });
    }
    return out;
  }

  /**
   * Register an outbound sink (e.g. the uplink) fed the same stream the loopback
   * WS clients get: an immediate snapshot on subscribe, then live snapshots and
   * relayed uplink frames. Returns an unsubscribe function.
   */
  subscribe(sink: (msg: ClientMessage) => void): () => void {
    this.#sinks.add(sink);
    sink(this.snapshot());
    return () => {
      this.#sinks.delete(sink);
    };
  }

  /**
   * The single router for phone commands, shared by the sealed uplink and the
   * loopback dev client. Prompt delivery prefers the mode-aware IPC control
   * connection; Collab remains authoritative for interrupt and interaction
   * replies. A Collab session without prompt control reports a visible error
   * instead of silently collapsing Queue into Steer. A `mediaFetch` is answered
   * here, from the retained media, a `historyRequest` from omp's session store,
   * and a `notifyPolicy` is kept (and saved) for the notifier. The switch is
   * exhaustive: a new `DownlinkFrame` variant fails to compile until it is
   * routed here.
   */
  deliverDownlink(frame: DownlinkCommand): void {
    switch (frame.t) {
      case "spawn":
        this.#deliverSpawn(frame);
        return;
      case "prompt":
      case "setModel":
      case "setThinkingLevel":
      case "compact":
      case "resourceInit":
      case "resourceChunk":
      case "resourceAbort":
        this.#deliverToPromptControl(frame);
        return;
      case "closeSession":
        this.#deliverClose(frame);
        return;
      case "interrupt":
      case "serviceTier":
        this.#deliverToSession(frame);
        return;
      case "interactionReply":
        this.#deliverToSession(frame);
        // First answer wins, and an IPC bridge settles a phone answer without
        // sending `interactionEnd`: stop replaying it, or every later sync would
        // ask the phone a question it already answered.
        this.#pending.get(frame.sessionId)?.delete(frame.id);
        return;
      case "mediaFetch":
        this.#fetchMedia(frame);
        return;
      case "historyRequest":
        this.#deliverHistory(frame);
        return;
      case "notifyPolicy":
        // Where the user is told, never what a session does: no session, no
        // control outcome. Saving never rejects; a failure is reported.
        void this.#notifyPolicy.set(frame.awaySec);
        return;
      default:
        frame satisfies never;
    }
  }

  #deliverSpawn(frame: Extract<DownlinkCommand, { t: "spawn" }>): void {
    const { machineId } = frame;
    // Sync throws and async launch errors both land in the catch; a failed
    // spawn is logged, never allowed to take the host-agent down.
    void (async (): Promise<string | undefined> => {
      // A resume reopens only a session the store holds for this very cwd.
      if (frame.resume !== undefined) {
        const stored = await findStoredSession(frame.cwd, frame.resume, {
          agentDir: this.#cfg.agentDir,
        });
        if (!stored) return "resume-not-found";
      }
      await this.#spawn({
        cwd: frame.cwd,
        model: frame.model,
        thinkingLevel: frame.thinkingLevel,
        approvalMode: frame.approvalMode,
        spawnId: frame.spawnId,
        resume: frame.resume,
      });
      return undefined;
    })()
      .catch(() => "spawn-failed")
      .then((code) =>
        this.#diagnostic(
          code === undefined
            ? { event: "session_spawned", machineId, outcome: "launched" }
            : { event: "session_spawned", machineId, outcome: "failed", code },
        ),
      );
  }

  /** Answer a `historyRequest` with the cwd's stored sessions, leaving out every
   *  session running now. Never rejects: a failed listing answers empty so the
   *  phone stops waiting, and is reported. */
  #deliverHistory({ cwd }: HistoryRequestFrame): void {
    const running = new Set(this.#promptControlMeta.keys());
    for (const { meta } of this.#registry.list()) running.add(meta.id);
    void listStoredSessions(cwd, {
      agentDir: this.#cfg.agentDir,
      exclude: running,
    }).then(
      (entries) => this.#emit({ t: "history", cwd, entries }),
      () => {
        this.#diagnostic({ event: "history_failed", code: "list-failed" });
        this.#emit({ t: "history", cwd, entries: [] });
      },
    );
  }

  #deliverToPromptControl(frame: PromptControlCommand): void {
    const promptControl = this.#promptControls.get(frame.sessionId);
    const feed = this.#conns.get(frame.sessionId);
    const target = promptControl ?? feed;
    if (target) {
      target.send(frame);
      this.#diagnostic({
        event: "control_outcome",
        action: frame.t,
        sessionId: frame.sessionId,
        ...(frame.t === "prompt" ? { mode: frame.mode } : {}),
        route: promptControl ? "ipc-prompt-control" : "ipc-feed",
        outcome: "forwarded",
        execution: "unconfirmed",
      });
    } else if (this.#collab.has(frame.sessionId)) {
      this.#emit({
        t: "controlError",
        sessionId: frame.sessionId,
        action: frame.t,
        code: "prompt-control-unavailable",
        message: PROMPT_CONTROL_UNAVAILABLE,
      });
      this.#diagnostic({
        event: "control_outcome",
        action: frame.t,
        sessionId: frame.sessionId,
        ...(frame.t === "prompt" ? { mode: frame.mode } : {}),
        route: "none",
        outcome: "rejected",
        execution: "unconfirmed",
        code: "prompt-control-unavailable",
      });
    } else {
      this.#diagnostic({
        event: "control_outcome",
        action: frame.t,
        sessionId: frame.sessionId,
        ...(frame.t === "prompt" ? { mode: frame.mode } : {}),
        route: "none",
        outcome: "rejected",
        execution: "unconfirmed",
        code: "session-not-found",
      });
    }
  }

  /** End a session through the conn prompts reach, iff that bridge declared it
   *  handles `closeSession`; an older bridge would drop the socket on the
   *  unknown frame, so the phone is told to restart omp once instead. */
  #deliverClose(frame: CloseSessionFrame): void {
    const promptControl = this.#promptControls.get(frame.sessionId);
    const target = promptControl ?? this.#conns.get(frame.sessionId);
    const route = promptControl
      ? "ipc-prompt-control"
      : target
        ? "ipc-feed"
        : "none";
    if (target && this.#capabilities.get(target)?.has("closeSession")) {
      target.send(frame);
      this.#diagnostic({
        event: "control_outcome",
        action: frame.t,
        sessionId: frame.sessionId,
        route,
        outcome: "forwarded",
        execution: "unconfirmed",
      });
      return;
    }
    this.#emit({
      t: "controlError",
      sessionId: frame.sessionId,
      action: frame.t,
      code: "close-unsupported",
      message: CLOSE_UNSUPPORTED,
    });
    this.#diagnostic({
      event: "control_outcome",
      action: frame.t,
      sessionId: frame.sessionId,
      route,
      outcome: "rejected",
      execution: "unconfirmed",
      code: "close-unsupported",
    });
  }

  #deliverToSession(frame: SessionCommand): void {
    const action = frame.t;
    const collab = this.#collab.get(frame.sessionId);
    if (collab) {
      collab(frame);
      this.#diagnostic({
        event: "control_outcome",
        action,
        sessionId: frame.sessionId,
        route: "collab",
        outcome: "forwarded",
        execution: "unconfirmed",
      });
      return;
    }
    const target = this.#conns.get(frame.sessionId);
    if (target) {
      target.send(frame);
      this.#diagnostic({
        event: "control_outcome",
        action,
        sessionId: frame.sessionId,
        route: "ipc-feed",
        outcome: "forwarded",
        execution: "unconfirmed",
      });
      return;
    }
    this.#diagnostic({
      event: "control_outcome",
      action,
      sessionId: frame.sessionId,
      route: "none",
      outcome: "rejected",
      execution: "unconfirmed",
      code: "session-not-found",
    });
  }

  /** Answer a `mediaFetch` for an image a replay announced `deferred`: its live
   *  `mediaInit` then its chunks, fanned out on the same path as live media, or
   *  `mediaError{expired}` once the host no longer retains it. */
  #fetchMedia({ sessionId, mediaId }: MediaFetchFrame): void {
    const rec = this.#media.get(sessionId)?.get(mediaId);
    if (!rec) {
      this.#emit({ t: "mediaError", sessionId, mediaId, code: "expired" });
      return;
    }
    // Chunks follow this init, so it must never read as a deferred announcement.
    const { deferred: _deferred, ...init } = rec.init;
    this.#emit(init);
    for (const chunk of rec.chunks) this.#emit(chunk);
  }

  /**
   * Register a non-IPC session source (a Collab guest adapter). The session
   * enters the registry so it shows in snapshots; the returned `emit` relays its
   * translated uplink frames to clients, and downlink control for its id routes
   * to `onDownlink` rather than an IPC connection. `close` deregisters it.
   */
  registerCollabSession(
    meta: SessionMeta,
    onDownlink: (frame: DownlinkFrame) => void,
  ): CollabRegistration {
    this.#registry.upsert(meta);
    // A restarted omp re-registers the same id before the old adapter closes,
    // and that close then returns early: the dead process's questions would
    // otherwise be replayed forever. History and media stay valid.
    if (this.#collab.has(meta.id)) this.#pending.delete(meta.id);
    this.#collab.set(meta.id, onDownlink);
    this.#diagnostic({
      event: "collab_session_registered",
      sessionId: meta.id,
    });
    return {
      emit: (frame) => {
        this.#relayToClients(frame);
      },
      close: () => {
        // A restarted process re-registers the same session id before the old
        // adapter is reaped; only the current registration may deregister it.
        if (this.#collab.get(meta.id) !== onDownlink) return;
        this.#collab.delete(meta.id);
        this.#registry.remove(meta.id);
        this.#dropRetained(meta.id);
        this.#diagnostic({
          event: "collab_session_deregistered",
          sessionId: meta.id,
        });
      },
    };
  }

  /** True when a session id is served by a live IPC bridge (the Collab controller skips those). */
  hasIpcSession(sessionId: string): boolean {
    return this.#conns.has(sessionId);
  }

  /** True when the Collab session has a mode-aware supplemental prompt channel. */
  hasPromptControl(sessionId: string): boolean {
    return this.#promptControls.has(sessionId);
  }

  #broadcastSnapshot(): void {
    this.#emit(this.snapshot());
  }
  #relayToClients(frame: UplinkFrame): void {
    if (frame.t === "state") this.#syncTitle(frame.sessionId, frame.title);
    const out = frame.t === "msg" ? this.#stampMsgAt(frame) : frame;
    this.#retain(out);
    this.#emit(out);
  }

  /** Give a msg frame its `at` (the time its message was written). A frame that
   *  carries one (Collab source time) keeps it; otherwise (the IPC feed) it takes
   *  the host time its message was first seen — the retained frame for the same
   *  msgId, so updates and a reconnecting client's replay agree. */
  #stampMsgAt(frame: MsgFrame): MsgFrame {
    if (frame.at !== undefined) return frame;
    const seen = this.#history.get(frame.sessionId)?.get(`m:${frame.msgId}`);
    const at =
      seen?.t === "msg" && seen.at !== undefined ? seen.at : Date.now();
    return { ...frame, at };
  }

  /** Carry a session's live title into its list meta, so the session list a
   *  (re)connecting client paints first already has the title the transcript
   *  will show. An empty title never replaces a known one. The registry change
   *  broadcasts the updated list before the state frame itself is relayed. */
  #syncTitle(sessionId: string, title: string): void {
    if (title.length === 0) return;
    const control = this.#promptControlMeta.get(sessionId);
    if (control && control.title !== title)
      this.#promptControlMeta.set(sessionId, { ...control, title });
    const meta = this.#registry.get(sessionId);
    if (meta && meta.title !== title) this.#registry.upsert({ ...meta, title });
  }

  /** Retain what a (re)connecting client's {@link replay} rebuilds: one
   *  coalesced frame per message/tool plus the latest state/jobs/catalog, the
   *  unanswered interactions, and the images. A `bye` retires all of it. */
  #retain(frame: UplinkFrame): void {
    if (frame.t === "bye") {
      this.#dropRetained(frame.sessionId);
      return;
    }
    if (
      frame.t === "mediaInit" ||
      frame.t === "mediaChunk" ||
      frame.t === "mediaError"
    ) {
      this.#retainMedia(frame);
      return;
    }
    if (frame.t === "interaction" || frame.t === "interactionEnd") {
      this.#retainPending(frame);
      return;
    }
    let key: string;
    if (frame.t === "msg") key = `m:${frame.msgId}`;
    else if (frame.t === "tool") key = `t:${frame.callId}`;
    else if (frame.t === "state" || frame.t === "jobs") key = frame.t;
    else if (frame.t === "modelCatalog") key = "modelCatalog";
    else return; // attention/controlError/resource* are events, not state
    let history = this.#history.get(frame.sessionId);
    if (!history) {
      history = new Map();
      this.#history.set(frame.sessionId, history);
    }
    history.set(key, frame);
    if (history.size > HISTORY_MAX) {
      const oldest = history.keys().next().value;
      if (oldest !== undefined) history.delete(oldest);
    }
  }
  /** Track a session's unanswered interactions; `interactionEnd` settles one. */
  #retainPending(frame: InteractionFrame | InteractionEndFrame): void {
    let pending = this.#pending.get(frame.sessionId);
    if (frame.t === "interactionEnd") {
      pending?.delete(frame.id);
      return;
    }
    if (!pending) {
      pending = new Map();
      this.#pending.set(frame.sessionId, pending);
    }
    pending.set(frame.id, frame);
  }
  #retainMedia(
    frame: MediaInitFrame | MediaChunkFrame | MediaErrorFrame,
  ): void {
    if (frame.t === "mediaError") {
      this.#media.get(frame.sessionId)?.delete(frame.mediaId);
      return;
    }
    let perSession = this.#media.get(frame.sessionId);
    if (!perSession) {
      perSession = new Map();
      this.#media.set(frame.sessionId, perSession);
    }
    if (frame.t === "mediaInit") {
      perSession.set(frame.mediaId, { init: frame, chunks: [], bytes: 0 });
    } else {
      const rec = perSession.get(frame.mediaId);
      if (!rec) return; // a chunk with no init — drop rather than orphan it
      rec.chunks.push(frame);
      rec.bytes += frame.data.length;
    }
    let total = 0;
    for (const rec of perSession.values()) total += rec.bytes;
    while (total > MEDIA_RETAIN_BYTES && perSession.size > 1) {
      const oldest = perSession.keys().next().value;
      if (oldest === undefined) break;
      total -= perSession.get(oldest)?.bytes ?? 0;
      perSession.delete(oldest);
    }
  }
  /** Forget a retired session's backfill: transcript, pending interactions, media. */
  #dropRetained(sessionId: string): void {
    this.#history.delete(sessionId);
    this.#pending.delete(sessionId);
    this.#media.delete(sessionId);
  }
  #emit(msg: ClientMessage): void {
    const wire = JSON.stringify(msg);
    for (const ws of this.#clients) ws.send(wire);
    for (const sink of this.#sinks) sink(msg);
  }
}
