import {
  type ByteSink,
  SealedChannel,
  type SessionKeys,
} from "@omp-remote/crypto";
import {
  type AttentionMsg,
  type BackoffConfig,
  BoundedQueue,
  type ClientMessage,
  DEFAULT_BACKOFF,
  type DownlinkCommand,
  type Scheduler,
  backoffCeil,
  backoffDelay,
  defaultScheduler,
  isDownlinkFrame,
} from "@omp-remote/protocol";
import {
  type AgentDiagnosticSink,
  type ClientFrameRejectCode,
  noAgentDiagnostic,
} from "./diagnostics";
import { Notifier } from "./notifier";
import { NotifyPolicy, type NotifyPolicySource } from "./notify-policy";

/**
 * The slice of `AgentService` the uplink drives. Kept structural so the uplink
 * can be tested against a fake feed and so it never reaches into service internals.
 */
export interface SessionFeed {
  /** Register an outbound sink for every frame the feed emits; returns an unsubscribe. */
  subscribe(sink: (msg: ClientMessage) => void): () => void;
  /** Full backfill for a (re)connecting client: session list + retained state. */
  replay(): ClientMessage[];
  /** Route any phone command (every downlink frame but `sync`) to its target. */
  deliverDownlink(frame: DownlinkCommand): void;
}

/** `WebSocket.OPEN`; named so the socket seam needn't reference the DOM global. */
export const WS_OPEN = 1;

/**
 * The transport the uplink dials, abstracted from the ambient `WebSocket` so the
 * reconnect / backpressure / keepalive machinery can be driven by a test double.
 * The default factory wraps a real `WebSocket`.
 */
export interface UplinkSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(): void;
  onOpen(cb: () => void): void;
  onClose(cb: () => void): void;
  onMessage(cb: (data: unknown) => void): void;
  onError(cb: () => void): void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toU8(data: unknown): Uint8Array {
  if (typeof data === "string") return enc.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array();
}

/**
 * Whether a line is the aggregator's clear control rather than a sealed
 * envelope: control carries a discriminant `type`, an envelope only its clear
 * header (the aggregator tells them apart the same way).
 */
function isClearControl(bytes: Uint8Array): boolean {
  let json: unknown;
  try {
    json = JSON.parse(dec.decode(bytes));
  } catch {
    return false;
  }
  return typeof json === "object" && json !== null && "type" in json;
}

/**
 * Bun's `WebSocket` accepts an options object carrying upgrade `headers`, but
 * lib.dom's constructor type (loaded workspace-wide) only admits subprotocols.
 */
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

/**
 * The production socket seam: a real outbound `WebSocket` that presents
 * `token` as `Authorization: Bearer` on the upgrade, so the aggregator
 * authenticates the agent before accepting the socket.
 */
export function browserUplinkSocket(url: string, token: string): UplinkSocket {
  const ws = new BunWebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    get readyState() {
      return ws.readyState;
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onOpen: (cb) => ws.addEventListener("open", () => cb(), { once: true }),
    onClose: (cb) => ws.addEventListener("close", () => cb(), { once: true }),
    onMessage: (cb) =>
      ws.addEventListener("message", (e) => cb((e as MessageEvent).data)),
    onError: (cb) => ws.addEventListener("error", () => cb(), { once: true }),
  };
}

/** Default outbound keepalive interval; under the aggregator's idle timeout (120s). */
export const DEFAULT_KEEPALIVE_MS = 30_000;
/** Default depth of the queue that holds transient frames while the link is
 *  down (drop-oldest on overflow; drops are reported on the next open). */
export const DEFAULT_MAX_QUEUE = 256;
/** Default per-socket outbound byte cap before the backlog holds frames back. */
export const DEFAULT_MAX_BUFFERED = 1 << 20;
/**
 * Safety cap on the connected backlog: frames waiting for room in the socket
 * buffer. A full replay is at most ~1000 retained frames per session plus its
 * pending interactions and image announcements, so this holds the replays of
 * dozens of sessions with live traffic on top; a socket that drains never gets
 * near it. A backlog this deep means the socket stopped draining. Trimming it
 * would silently corrupt the phone's view, so the uplink closes the socket
 * instead and the reconnect sends a fresh full replay.
 */
export const MAX_CONNECTED_BACKLOG = 65_536;
/** How long a backlog the byte cap held back waits before the next flush. */
const FLUSH_RETRY_MS = 50;

/**
 * What becomes of an outbound frame produced while the link is down, by type.
 * `replayed`: the full `replay()` sent on the next open rebuilds it, so it is
 * not queued. `held`: an event no replay can rebuild, so it waits in the bounded
 * queue and follows that replay. Exhaustive: a new frame type does not compile
 * until it is classified here.
 */
const WHILE_DOWN: Record<ClientMessage["t"], "replayed" | "held"> = {
  // The replay leads with a fresh session list.
  sessions: "replayed",
  // Retained per session: the latest state, jobs and catalog, and each message
  // and tool call coalesced to its latest frame.
  state: "replayed",
  jobs: "replayed",
  modelCatalog: "replayed",
  msg: "replayed",
  tool: "replayed",
  // Retained until it is answered or ended.
  interaction: "replayed",
  // A retained image is re-announced `deferred`; the phone fetches its chunks.
  mediaInit: "replayed",
  mediaChunk: "replayed",
  // Events, not state: nothing is retained for them.
  attention: "held",
  controlError: "held",
  resourceProgress: "held",
  resourceReady: "held",
  resourceError: "held",
  // The replay omits a settled interaction but cannot retract one the phone shows.
  interactionEnd: "held",
  // An error drops the image from retention: the replay can omit it, not fail it.
  mediaError: "held",
  // A Collab `bye` leaves the session listed until its adapter stops.
  bye: "held",
  // An answer to one phone request: no replay rebuilds it, and dropping it
  // would leave the phone waiting, so it follows the reconnect's replay once.
  history: "held",
  // The host consumes bridge hellos and never relays one; held if one ever is.
  hello: "held",
};

export interface UplinkConfig {
  /** The aggregator's `/agent` WebSocket URL (see `agentSocketUrl`). */
  url: string;
  /** The machineId this agent claims — also the sealed-channel route. */
  machineId: string;
  /**
   * This machine's `/agent` token, issued by pairing: sent as the upgrade's
   * `Authorization` bearer, and bound to `machineId` by the aggregator.
   */
  token: string;
  /** Server-side session keys derived against the paired phone. */
  keys: SessionKeys;
  /** The local session feed to bridge (an `AgentService`). */
  feed: SessionFeed;
  backoff?: BackoffConfig;
  /** Jitter source in `[0, 1)`; defaults to `Math.random`. */
  random?: () => number;
  /** Reconnect/keepalive timer source; defaults to the ambient globals. */
  scheduler?: Scheduler;
  /** Keepalive ping interval in ms while connected; `0` disables it. */
  keepaliveMs?: number;
  /** Depth of the queue holding transient frames while the link is down;
   *  overflow drops the oldest, reported on the next open. */
  maxQueue?: number;
  /** Socket buffered-bytes cap; over it the backlog holds frames back and the
   *  flush retries on a timer. */
  maxBufferedBytes?: number;
  /**
   * Transport factory, handed `url` and the bearer token to present on the
   * upgrade; defaults to {@link browserUplinkSocket}.
   */
  socketFactory?: (url: string, token: string) => UplinkSocket;
  /** Privacy-safe operational diagnostics. */
  diagnostic?: AgentDiagnosticSink;
  /**
   * The key that seals push notices: `notifyKey(keys.tx)`, which the paired
   * phone derives from its `rx`. With it, a session that needs the user asks
   * the aggregator for a push once the user has been away from this machine
   * long enough, and for a clear once it is answered (see {@link Notifier});
   * without it the uplink never asks for a push.
   */
  notifyKey?: Uint8Array;
  /** How long the user must be away before a push (the phone sets it);
   *  defaults to an in-memory {@link NotifyPolicy}. */
  notifyPolicy?: NotifyPolicySource;
  /** Milliseconds since this machine's last keyboard or mouse input, `null`
   *  when unknown; defaults to the Win32 probe `hostIdleMs`. */
  hostIdleMs?: () => number | null;
}

/**
 * The host-agent's persistent OUTBOUND link to the aggregator. It dials the
 * `/agent` `url` presenting the token as the upgrade bearer, registers
 * `machineId` (the only route the token claims), and bridges the local session feed to the
 * paired phone over a server-side (responder) `SealedChannel` keyed only by the
 * clear `route` (= machineId): it seals the session list and relayed frames OUT
 * and opens phone commands IN, routing them to the owning session. No inbound
 * ports; reconnects with bounded jittered backoff and holds an idle keepalive.
 *
 * A phone binds to the channel's random per-process epoch with a hello the
 * channel acks; a phone command opens only under that epoch and with a counter
 * past the phone's last, so a line the relay records and replays, to this run
 * or a later one, is dropped and reported as `client_frame_rejected`. A relay
 * can send any number of bad lines, so only the first of each code on a
 * connection is reported at once, and the count of the rest when it closes.
 *
 * Every (re)open sends `register`, then the channel's hello, then the feed's
 * full replay, then the transient frames held while the link was down; a
 * `sync` is answered with the replay the same way. Frames queue UNSEALED and
 * are sealed as they are written, so order holds. While connected the uplink
 * drops nothing: what the socket's byte cap holds back drains on a retry timer,
 * and a backlog past {@link MAX_CONNECTED_BACKLOG} closes the socket so the
 * reconnect replays full state. While down only frames no replay can rebuild
 * are kept (see `WHILE_DOWN`), in a bounded drop-oldest queue whose drops are
 * reported. The aggregator stays content-blind — it only ever sees sealed
 * envelopes (the clear route and handshake header, the payload sealed), the
 * clear register/ping control, and `attention` push requests whose only
 * payload is a notice sealed under a key it never holds (see {@link Notifier}).
 */
export class Uplink {
  readonly #cfg: UplinkConfig;
  readonly #backoff: BackoffConfig;
  readonly #random: () => number;
  readonly #scheduler: Scheduler;
  readonly #keepaliveMs: number;
  readonly #maxBufferedBytes: number;
  readonly #socketFactory: (url: string, token: string) => UplinkSocket;
  /**
   * The persistent sealed channel, reused across reconnects: its epoch and each
   * phone's counter outlive a dropped socket, so a replay after a reconnect is
   * still refused.
   */
  readonly #channel: SealedChannel;
  /** The current socket: dialing, or open once `#onOpen` ran for it. */
  #ws: UplinkSocket | undefined;
  /** `#ws` is open and registered: outbound frames go to the backlog. */
  #open = false;
  /** Unsealed frames for the open socket, FIFO; each is sealed as it is written. */
  #backlog: ClientMessage[] = [];
  /** Transient frames produced while the link is down (see `WHILE_DOWN`). */
  readonly #held: BoundedQueue<ClientMessage>;
  /** Held frames evicted since the last open, reported on the next one. */
  #heldDropped = 0;
  /**
   * Lines refused on the current socket, by code: how many past the first,
   * which alone was reported. The counts are reported when the socket goes.
   */
  readonly #rejected = new Map<ClientFrameRejectCode, number>();
  /** Inbound byte pump, set by the channel; the current socket feeds it. */
  #onBytes: ((b: Uint8Array) => void) | undefined;
  #unsubscribe: (() => void) | undefined;
  #cancelReconnect: (() => void) | undefined;
  #cancelKeepalive: (() => void) | undefined;
  #cancelFlushRetry: (() => void) | undefined;
  #attempt = 0;
  #stopped = false;
  readonly #diagnostic: AgentDiagnosticSink;
  #lastReportedReconnectCeil: number | undefined;
  #connectedOnce = false;
  /** Decides the pushes; absent without a notify key. */
  readonly #notifier: Notifier | undefined;

  constructor(cfg: UplinkConfig) {
    this.#cfg = cfg;
    this.#backoff = cfg.backoff ?? DEFAULT_BACKOFF;
    this.#random = cfg.random ?? Math.random;
    this.#scheduler = cfg.scheduler ?? defaultScheduler;
    this.#keepaliveMs = cfg.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.#maxBufferedBytes = cfg.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED;
    this.#socketFactory = cfg.socketFactory ?? browserUplinkSocket;
    this.#diagnostic = cfg.diagnostic ?? noAgentDiagnostic;
    this.#held = new BoundedQueue(cfg.maxQueue ?? DEFAULT_MAX_QUEUE);
    this.#notifier =
      cfg.notifyKey === undefined
        ? undefined
        : new Notifier({
            machineId: cfg.machineId,
            key: cfg.notifyKey,
            send: (notice) => this.#push(notice),
            policy: cfg.notifyPolicy ?? new NotifyPolicy(),
            idleMs: cfg.hostIdleMs,
            scheduler: this.#scheduler,
            diagnostic: this.#diagnostic,
          });
    // The channel seals straight onto the socket. Only #flush hands it frames,
    // and only while the socket is open, so the backlog alone fixes the order.
    // Its handshake lines (hello, ack) bypass the backlog and go out at once;
    // frames still waiting there are sealed later, under higher counters, so a
    // phone that verifies an ack still accepts them.
    const sink: ByteSink = {
      send: (bytes) => this.#ws?.send(bytes),
      onBytes: (cb) => {
        this.#onBytes = cb;
      },
    };
    // The agent is the responder: it acks each phone's hello, opens only
    // commands bound to its current epoch with a counter past that phone's
    // last, and broadcasts to every phone on the route.
    this.#channel = new SealedChannel(cfg.keys, sink, cfg.machineId, {
      role: "responder",
      onReject: (reason) => this.#reject(reason),
    });
    this.#channel.onFrame((f) => {
      // The channel carries both directions; only phone→agent frames are routed.
      if (!isDownlinkFrame(f)) {
        this.#reject("invalid-frame");
        return;
      }
      // A (re)connecting phone requests backfill: the full replay, queued behind
      // whatever is still waiting so it lands in order.
      if (f.t === "sync") {
        for (const msg of this.#cfg.feed.replay()) this.#queue(msg);
        this.#flush();
      }
      // Every command goes to the one router the loopback client also uses; a
      // reply also answers the need a push may be waiting on.
      else {
        this.#cfg.feed.deliverDownlink(f);
        this.#notifier?.command(f);
      }
    });
  }

  /** Begin bridging: subscribe to the feed and open the first connection. */
  start(): void {
    this.#stopped = false;
    this.#diagnostic({
      event: "uplink_started",
      machineId: this.#cfg.machineId,
    });
    this.#notifier?.start();
    this.#unsubscribe = this.#cfg.feed.subscribe((msg) => {
      this.#queue(msg);
      this.#flush();
      // The same live frame tells the notifier what the sessions need; it asks
      // the aggregator for a push (or a clear) through `#push`.
      this.#notifier?.observe(msg);
    });
    this.#connect();
  }

  /** Stop bridging and release the socket; no further reconnects occur. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#cancelReconnect?.();
    this.#cancelReconnect = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#notifier?.stop();
    this.#backlog = [];
    this.#held.clear();
    this.#heldDropped = 0;
    const ws = this.#ws;
    this.#detach();
    ws?.close();
    this.#diagnostic({
      event: "uplink_stopped",
      machineId: this.#cfg.machineId,
    });
  }

  /** Pre-jitter, capped delay for a given attempt (exposed for testing). */
  backoffCeil(attempt: number): number {
    return backoffCeil(this.#backoff, attempt);
  }

  #connect(): void {
    if (this.#stopped) return;
    const ws = this.#socketFactory(this.#cfg.url, this.#cfg.token);
    this.#ws = ws;
    ws.onOpen(() => this.#onOpen(ws));
    ws.onClose(() => this.#onClose(ws));
    ws.onMessage((data) => {
      if (ws !== this.#ws) return;
      const bytes = toU8(data);
      // The aggregator's clear control (`pong`, `error`) shares the socket with
      // the phones' sealed envelopes. Only envelopes go to the channel, which
      // reports any other line it is handed as malformed.
      if (!isClearControl(bytes)) this.#onBytes?.(bytes);
    });
    // An error is always followed by a close event, which schedules the retry;
    // swallow it here so it never bubbles out of the socket.
    ws.onError(() => {});
  }

  #onOpen(ws: UplinkSocket): void {
    if (this.#stopped || ws !== this.#ws) return;
    this.#attempt = 0;
    const reconnected = this.#connectedOnce;
    this.#connectedOnce = true;
    this.#lastReportedReconnectCeil = undefined;
    this.#diagnostic({
      event: "uplink_connected",
      machineId: this.#cfg.machineId,
      reconnected,
    });
    if (this.#heldDropped > 0) {
      this.#diagnostic({
        event: "uplink_frames_dropped",
        machineId: this.#cfg.machineId,
        dropped: this.#heldDropped,
      });
      this.#heldDropped = 0;
    }
    ws.send(
      JSON.stringify({ type: "register", machineId: this.#cfg.machineId }),
    );
    // Say hello before the replay: a phone still bound to an earlier run of
    // this agent (an epoch that is gone) answers with a hello of its own, and
    // once this agent's ack binds it, syncs the replay it could not verify.
    this.#channel.hello();
    this.#startKeepalive();
    // Rebuild the phone's view in full (session list, transcripts, pending
    // interactions, image announcements), then deliver what was held while the
    // link was down. It all goes through the backlog, so a replay bigger than
    // the socket buffer drains on the retry timer instead of being cut short.
    this.#open = true;
    for (const msg of this.#cfg.feed.replay()) this.#queue(msg);
    for (const msg of this.#held.drain()) this.#queue(msg);
    this.#flush();
    // The pushes (and clears) the notifier decided while the link was down.
    this.#notifier?.resume();
  }

  /** Ask the aggregator to push a sealed notice to the paired phone's devices;
   *  `false` while the link is down. */
  #push(notice: string): boolean {
    const ws = this.#ws;
    if (!this.#open || !ws || ws.readyState !== WS_OPEN) return false;
    const msg: AttentionMsg = { type: "attention", notice };
    ws.send(JSON.stringify(msg));
    return true;
  }

  #onClose(ws: UplinkSocket): void {
    if (ws !== this.#ws) return;
    this.#detach();
    this.#scheduleReconnect();
  }

  /** Leave the current socket: stop its timers, report the rejections counted
   *  on it, and keep, of its unsent backlog, only the frames the reconnect's
   *  replay cannot rebuild. */
  #detach(): void {
    this.#ws = undefined;
    this.#open = false;
    this.#stopKeepalive();
    this.#stopFlushRetry();
    this.#reportSuppressedRejections();
    const unsent = this.#backlog;
    this.#backlog = [];
    for (const msg of unsent) this.#queue(msg);
  }

  /**
   * Report a line the phone channel refused: the first of each code on a
   * connection at once. A relay can send any number of bad lines, so the rest
   * are only counted.
   */
  #reject(code: ClientFrameRejectCode): void {
    const suppressed = this.#rejected.get(code);
    if (suppressed === undefined) {
      this.#rejected.set(code, 0);
      this.#diagnostic({ event: "client_frame_rejected", code });
    } else this.#rejected.set(code, suppressed + 1);
  }

  /** Report, once, the rejections counted but not reported on the socket left. */
  #reportSuppressedRejections(): void {
    const suppressedCount: Partial<Record<ClientFrameRejectCode, number>> = {};
    let suppressed = false;
    for (const [code, count] of this.#rejected) {
      if (count === 0) continue;
      suppressedCount[code] = count;
      suppressed = true;
    }
    this.#rejected.clear();
    if (suppressed)
      this.#diagnostic({
        event: "client_frame_rejections_suppressed",
        suppressedCount,
      });
  }

  /** Open: append to the backlog. Down: hold it only if no replay rebuilds it. */
  #queue(msg: ClientMessage): void {
    if (this.#open) this.#backlog.push(msg);
    else if (WHILE_DOWN[msg.t] === "held" && this.#held.push(msg) !== undefined)
      this.#heldDropped += 1;
  }

  /**
   * Write the backlog to the open socket in FIFO order, sealing each frame as it
   * goes, until the socket's buffer passes the byte cap. What the cap holds back
   * drains on a retry timer, never waiting for the next outbound frame; a
   * backlog past MAX_CONNECTED_BACKLOG closes the socket instead of trimming it.
   */
  #flush(): void {
    const ws = this.#ws;
    if (!this.#open || !ws || ws.readyState !== WS_OPEN) return;
    let sent = 0;
    for (const msg of this.#backlog) {
      if (ws.bufferedAmount > this.#maxBufferedBytes) break;
      this.#channel.sendFrame(msg);
      sent += 1;
    }
    this.#backlog.splice(0, sent);
    if (this.#backlog.length > MAX_CONNECTED_BACKLOG) this.#overflow(ws);
    else if (this.#backlog.length > 0) this.#scheduleFlushRetry();
    else this.#stopFlushRetry();
  }

  #scheduleFlushRetry(): void {
    if (this.#cancelFlushRetry) return;
    this.#cancelFlushRetry = this.#scheduler.setTimer(() => {
      this.#cancelFlushRetry = undefined;
      this.#flush();
    }, FLUSH_RETRY_MS);
  }

  #stopFlushRetry(): void {
    this.#cancelFlushRetry?.();
    this.#cancelFlushRetry = undefined;
  }

  /** The socket stopped draining and the backlog passed the safety cap. Rather
   *  than trim it, drop the socket: the reconnect replays full state. */
  #overflow(ws: UplinkSocket): void {
    this.#diagnostic({
      event: "uplink_backlog_overflow",
      machineId: this.#cfg.machineId,
      backlog: this.#backlog.length,
    });
    this.#detach();
    ws.close();
    this.#scheduleReconnect();
  }

  #startKeepalive(): void {
    if (this.#keepaliveMs <= 0) return;
    this.#stopKeepalive();
    this.#cancelKeepalive = this.#scheduler.setInterval(() => {
      if (this.#ws?.readyState === WS_OPEN)
        this.#ws.send(JSON.stringify({ type: "ping" }));
    }, this.#keepaliveMs);
  }

  #stopKeepalive(): void {
    this.#cancelKeepalive?.();
    this.#cancelKeepalive = undefined;
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const ceiling = backoffCeil(this.#backoff, this.#attempt);
    const delay = backoffDelay(this.#backoff, this.#attempt, this.#random);
    this.#attempt += 1;
    if (ceiling !== this.#lastReportedReconnectCeil) {
      this.#lastReportedReconnectCeil = ceiling;
      this.#diagnostic({
        event: "uplink_reconnect_scheduled",
        machineId: this.#cfg.machineId,
        retryDelayMs: delay,
        code: "transport-closed",
      });
    }
    this.#cancelReconnect = this.#scheduler.setTimer(() => {
      this.#cancelReconnect = undefined;
      this.#connect();
    }, delay);
  }
}
