import {
  type ByteSink,
  SealedChannel,
  type SessionKeys,
} from "@omp-remote/crypto";
import {
  type BackoffConfig,
  BoundedQueue,
  RoutedEnvelope,
  type Scheduler,
  ServerControl,
  backoffDelay,
  defaultScheduler,
} from "@omp-remote/protocol";
import type { SessionCheck } from "./session-check";
import type { AppStore } from "./store";

/**
 * The transport the client drives, abstracted from the browser `WebSocket` so it
 * can be tested against a double and driven against a real aggregator in the E2E.
 */
export interface ClientSocket {
  send(raw: string): void;
  onMessage(cb: (raw: string) => void): void;
  onOpen(cb: () => void): void;
  /** `cb` gets the close code the socket reported. */
  onClose(cb: (code: number) => void): void;
  close(): void;
}

/** A machine this phone has paired with, plus the derived per-session keys. */
export interface PairedMachine {
  machineId: string;
  keys: SessionKeys;
}

/**
 * The client's link to the relay (aggregator): the socket is open, being
 * dialled, or down, waiting to retry or stopped.
 */
export type RelayState = "connected" | "connecting" | "offline";

/**
 * Why this sign-in ended: the relay revoked it, or its session token ran out
 * or is no longer accepted.
 */
export type SignOutReason = "revoked" | "expired";

/** Reconnect / keepalive / backpressure tuning for the client. */
export interface PhoneClientOptions {
  backoff?: BackoffConfig;
  /** Jitter source in `[0, 1)`; defaults to `Math.random`. */
  random?: () => number;
  /** Reconnect/keepalive timer source; defaults to the ambient globals. */
  scheduler?: Scheduler;
  /** Keepalive ping interval in ms while connected; `0` disables it. */
  keepaliveMs?: number;
  /** Outbound line queue depth; overflow drops the oldest line. */
  maxQueue?: number;
  /** Called once per change of {@link PhoneClient.relayState}. */
  onRelayState?: (state: RelayState) => void;
  /**
   * Called once when this sign-in ends; the client has stopped for good by
   * then. `"revoked"`: the relay closed the socket as signed out (a passkey
   * was revoked, or every device was signed out). `"expired"`: the session
   * token ran out (`tokenExpiresAt`), or the relay no longer accepts it
   * (`checkSession`).
   */
  onSignedOut?: (reason: SignOutReason) => void;
  /** Session token expiry, epoch ms. Undefined = never expires (local dev). */
  tokenExpiresAt?: number;
  /** Clock for the expiry check; default Date.now. */
  now?: () => number;
  /** Pong deadline after each keepalive ping, ms; default 10_000; 0 disables the watchdog. */
  pongTimeoutMs?: number;
  /**
   * How long a dial may take to open before it is dropped and retried, ms;
   * default 8_000; 0 waits for the browser. A phone waking its radio can leave
   * a dial hanging far longer than a retry takes.
   */
  dialTimeoutMs?: number;
  /** How long `probe()` waits for the relay's pong before redialling, ms; default 3_000. */
  probeTimeoutMs?: number;
  /** Asks the relay whether the token is still accepted (HTTP). */
  checkSession?: () => Promise<SessionCheck>;
  /**
   * Seconds the user must be away from a machine before it pushes a
   * notification; each machine is told on every connect (`notifyPolicy`).
   * Absent, machines are never told.
   */
  notifyAwaySec?: (machineId: string) => number;
}

/**
 * The close code the relay gives the `/client` socket of a sign-in it has
 * just ended (a passkey revoked, or signed out everywhere).
 */
const SIGNED_OUT_CLOSE = 4401;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Default outbound keepalive interval; under the aggregator's idle timeout (120s). */
export const DEFAULT_KEEPALIVE_MS = 30_000;
/** Default outbound line queue depth (drop-oldest on overflow). */
export const DEFAULT_MAX_QUEUE = 256;
/** Default wait for any line after a keepalive ping before the socket counts as dead. */
export const DEFAULT_PONG_TIMEOUT_MS = 10_000;
/** Default wait for a dial to open; see `dialTimeoutMs`. */
export const DEFAULT_DIAL_TIMEOUT_MS = 8_000;
/** Default wait for the pong a resume probe asks for; see `probe()`. */
export const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
/**
 * The phone's reconnect backoff: capped at 8 s, not the agent's 30 s, since a
 * person is waiting on it. Still growing, so a relay shedding load (1013) is
 * not hammered.
 */
export const PHONE_BACKOFF: BackoffConfig = {
  baseMs: 500,
  maxMs: 8_000,
  factor: 2,
};
/**
 * Dials in a row that close without ever opening before the client asks the
 * relay whether it still accepts the token.
 */
const FAILED_DIALS_BEFORE_CHECK = 2;

function toU8(data: unknown): Uint8Array {
  if (typeof data === "string") return enc.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array();
}

/**
 * A `ByteSink` for one machine's `SealedChannel`, multiplexed over the single
 * `/client` socket. Outbound bytes are written through the client's send path
 * (which queues while disconnected); inbound bytes are only ever the lines the
 * client has already matched to this route.
 */
class RouteSink implements ByteSink {
  #onBytes: ((b: Uint8Array) => void) | undefined;
  readonly #send: (raw: string) => void;
  constructor(send: (raw: string) => void) {
    this.#send = send;
  }
  send(bytes: Uint8Array): void {
    this.#send(dec.decode(bytes));
  }
  onBytes(cb: (b: Uint8Array) => void): void {
    this.#onBytes = cb;
  }
  deliver(raw: string): void {
    this.#onBytes?.(enc.encode(raw));
  }
}

/** The production `ClientSocket`: the browser `WebSocket` to the aggregator `/client`. */
export function browserSocket(url: string): ClientSocket {
  const ws = new WebSocket(url);
  return {
    send: (raw) => ws.send(raw),
    onMessage: (cb) =>
      ws.addEventListener("message", (e) =>
        cb(dec.decode(toU8((e as MessageEvent).data))),
      ),
    onOpen: (cb) => ws.addEventListener("open", () => cb()),
    onClose: (cb) => ws.addEventListener("close", (e) => cb(e.code)),
    close: () => ws.close(),
  };
}

/**
 * The PWA's connection to the aggregator: one `/client` WebSocket carrying, for
 * each paired machine, an initiator `SealedChannel` keyed by the clear `route`
 * (= machineId). On (re)connect it attaches to every paired machine and says a
 * sealed hello on each channel. The agent answers with an ack bound to this
 * page's channel, which proves it live and bound, and each ack pulls one sealed
 * `sync`, so a late attach to a steady machine still gets the current snapshot.
 * The channel opens agent frames only under an agent epoch an ack verified, so
 * the relay cannot replay a recorded agent stream; a restarted agent's first
 * broadcast makes the channel say hello again. Frames sent before a machine's
 * first ack wait in its channel. Inbound lines are demultiplexed by their clear
 * `route` to the matching channel; clear control (`machines`/`auth`) drives the
 * store. Frame plaintext is never on the wire. When the socket drops it
 * reconnects with bounded jittered backoff and re-attaches; lines sealed
 * meanwhile wait in a bounded drop-oldest queue, and an idle keepalive ping
 * holds the connection open (spec §4.1/§9).
 * A ping no line answers in time marks the socket half-open, so it is redialled.
 * The sign-in ends, and the client stops for good, when the relay closes it as
 * signed out, when the session token runs out, or when the relay says it no
 * longer accepts the token after dials that never open.
 */
export class PhoneClient {
  readonly #factory: () => ClientSocket;
  readonly #machines: PairedMachine[];
  /** The machines this phone holds keys for; the aggregator lists every live one. */
  readonly #paired: ReadonlySet<string>;
  readonly #store: AppStore;
  readonly #channels = new Map<string, SealedChannel>();
  /** Machine → the agent epoch this socket already synced from. */
  readonly #synced = new Map<string, string>();
  readonly #sinks = new Map<string, RouteSink>();
  readonly #outbound: BoundedQueue<string>;
  readonly #backoff: BackoffConfig;
  readonly #random: () => number;
  readonly #scheduler: Scheduler;
  readonly #keepaliveMs: number;
  readonly #pongTimeoutMs: number;
  readonly #dialTimeoutMs: number;
  readonly #probeTimeoutMs: number;
  readonly #tokenExpiresAt: number | undefined;
  readonly #now: () => number;
  readonly #checkSession: (() => Promise<SessionCheck>) | undefined;
  readonly #notifyAwaySec: ((machineId: string) => number) | undefined;
  readonly #onRelayState: ((state: RelayState) => void) | undefined;
  readonly #onSignedOut: ((reason: SignOutReason) => void) | undefined;
  /** The state `onRelayState` last heard, so each change is reported once. */
  #reportedRelay: RelayState = "offline";
  #socket: ClientSocket | undefined;
  #connected = false;
  #generation = 0;
  #attempt = 0;
  /** Dials in a row that closed without ever opening. */
  #failedDials = 0;
  /**
   * The run of failed dials a session check belongs to. A new run starts when
   * a socket opens, and on `wake()` and `stop()`.
   */
  #streak = 0;
  #stopped = false;
  #cancelReconnect: (() => void) | undefined;
  #cancelKeepalive: (() => void) | undefined;
  /** The pong deadline a keepalive ping armed; any inbound line disarms it. */
  #cancelPong: (() => void) | undefined;
  /** Drops a dial that has not opened in time; see `dialTimeoutMs`. */
  #cancelDial: (() => void) | undefined;
  /** The pong deadline `probe()` armed; only a pong disarms it. */
  #cancelProbe: (() => void) | undefined;

  constructor(
    factory: () => ClientSocket,
    machines: PairedMachine[],
    store: AppStore,
    opts: PhoneClientOptions = {},
  ) {
    this.#factory = factory;
    this.#machines = machines;
    this.#paired = new Set(machines.map((machine) => machine.machineId));
    this.#store = store;
    this.#backoff = opts.backoff ?? PHONE_BACKOFF;
    this.#random = opts.random ?? Math.random;
    this.#scheduler = opts.scheduler ?? defaultScheduler;
    this.#keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.#pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.#dialTimeoutMs = opts.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS;
    this.#probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#tokenExpiresAt = opts.tokenExpiresAt;
    this.#now = opts.now ?? Date.now;
    this.#checkSession = opts.checkSession;
    this.#notifyAwaySec = opts.notifyAwaySec;
    this.#outbound = new BoundedQueue(opts.maxQueue ?? DEFAULT_MAX_QUEUE);
    this.#onRelayState = opts.onRelayState;
    this.#onSignedOut = opts.onSignedOut;
  }

  start(): void {
    this.#stopped = false;
    // Build each machine's sealed channel ONCE: its keys, epoch and the agent
    // it verified persist across reconnects, so a new socket only re-attaches
    // and says hello again.
    for (const machine of this.#machines) {
      const sink = new RouteSink((raw) => this.#sendRaw(raw));
      const channel = new SealedChannel(machine.keys, sink, machine.machineId, {
        role: "initiator",
      });
      channel.onFrame((f) => this.#store.applyFrame(machine.machineId, f));
      // Each ack proves the agent live and bound to this channel: pull its
      // full state (the snapshot, transcripts, pending interactions) then.
      // Only once per agent epoch per socket: a second ack from the same epoch
      // (the agent answered two hellos) would pull a second full replay.
      channel.onReady((peerEpoch) => {
        if (this.#synced.get(machine.machineId) === peerEpoch) return;
        this.#synced.set(machine.machineId, peerEpoch);
        channel.sendFrame({ t: "sync" });
        // The agent keeps where the user is told; tell it on every connect.
        this.#sendNotifyPolicy(machine.machineId, channel);
      });
      this.#sinks.set(machine.machineId, sink);
      this.#channels.set(machine.machineId, channel);
    }
    this.#connect();
  }

  /** The sealed channel for a machine, for later control frames (prompt/interrupt). */
  channelFor(machineId: string): SealedChannel | undefined {
    return this.#channels.get(machineId);
  }

  /**
   * Tell a machine its away time again, after it changed: now when its
   * channel is ready on this socket, else on its next ready, as every
   * connect does.
   */
  sendNotifyPolicy(machineId: string): void {
    const channel = this.#channels.get(machineId);
    if (channel && this.#connected && this.#synced.has(machineId))
      this.#sendNotifyPolicy(machineId, channel);
  }

  #sendNotifyPolicy(machineId: string, channel: SealedChannel): void {
    const awaySec = this.#notifyAwaySec?.(machineId);
    if (awaySec !== undefined)
      channel.sendFrame({ t: "notifyPolicy", awaySec });
  }

  /** The link to the relay now; see {@link RelayState}. */
  get relayState(): RelayState {
    if (this.#connected) return "connected";
    return this.#socket === undefined ? "offline" : "connecting";
  }

  stop(): void {
    this.#stopped = true;
    this.#leaveSocket();
    this.#outbound.clear();
    for (const ch of this.#channels.values()) ch.close();
    this.#channels.clear();
    this.#sinks.clear();
    this.#relayChanged();
  }

  /**
   * Force a fresh reconnect + resync, at once and with the backoff reset: a
   * person or the network asked for it (Retry, the network returning, a
   * bfcache restore, a socket found dead). It drops the current socket and
   * dials a new one, which re-attaches and says hello on every machine; each
   * agent's ack pulls a sync, so the agent backfills the current snapshot and
   * transcript. A no-op after `stop()`.
   */
  wake(): void {
    if (this.#stopped) return;
    this.#attempt = 0;
    this.#leaveSocket();
    this.#connect();
  }

  /**
   * Check the link on resume without dropping a healthy one. A backgrounded
   * PWA freezes its keepalive, so the relay may have idle-closed the socket
   * while the frozen tab never saw it (half-open). A link that is down and
   * waiting out its backoff redials at once. An open one is pinged and kept
   * if the relay's pong comes back within `probeTimeoutMs`; else it is
   * redialled as `wake()` does. Only a pong counts: lines the browser queued
   * while the tab was frozen prove nothing about the socket now. A dial in
   * flight is left to its own timeout.
   */
  probe(): void {
    if (this.#stopped) return;
    const socket = this.#socket;
    if (socket === undefined) {
      this.wake();
      return;
    }
    if (!this.#connected || this.#cancelProbe !== undefined) return;
    socket.send(JSON.stringify({ type: "ping" }));
    const gen = this.#generation;
    this.#cancelProbe = this.#scheduler.setTimer(() => {
      this.#cancelProbe = undefined;
      if (gen === this.#generation) this.wake();
    }, this.#probeTimeoutMs);
  }

  /**
   * Let go of the current socket: cancel every timer it runs (reconnect, dial,
   * keepalive, pong and probe deadlines), orphan its callbacks (generation check) so its
   * own close can't schedule a competing reconnect nor a late line land, then
   * close it. The run of failed dials ends with it, so a session check still
   * out is ignored when it answers.
   */
  #leaveSocket(): void {
    this.#cancelReconnect?.();
    this.#cancelReconnect = undefined;
    this.#disarmDial();
    this.#stopKeepalive();
    this.#connected = false;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#generation += 1;
    this.#endStreak();
    socket?.close();
  }

  #connect(): void {
    if (this.#stopped) return;
    // A token past its expiry can only be refused, and a refused upgrade shows
    // the browser nothing but 1006: sign in again rather than dial.
    if (this.#tokenExpired()) {
      this.#signOut("expired");
      return;
    }
    const socket = this.#factory();
    this.#socket = socket;
    this.#generation += 1;
    const gen = this.#generation;
    socket.onOpen(() => this.#onOpen(gen));
    socket.onClose((code) => this.#onClose(gen, code));
    if (this.#dialTimeoutMs > 0)
      this.#cancelDial = this.#scheduler.setTimer(() => {
        this.#cancelDial = undefined;
        if (gen === this.#generation) this.#dialTimedOut();
      }, this.#dialTimeoutMs);
    socket.onMessage((raw) => {
      if (gen !== this.#generation) return;
      // Any line proves the socket alive, not just the pong.
      this.#disarmPong();
      this.#onMessage(raw);
    });
    this.#relayChanged();
  }

  #sendRaw(raw: string): void {
    // Send when the current socket is open; otherwise buffer (drop-oldest) until
    // the next open flushes the queue in FIFO order.
    if (this.#connected && this.#socket) this.#socket.send(raw);
    else this.#outbound.push(raw);
  }

  #onOpen(gen: number): void {
    if (this.#stopped || gen !== this.#generation) return;
    this.#connected = true;
    this.#disarmDial();
    // The relay took the token: a later run of failed dials counts from zero.
    this.#endStreak();
    // The backoff resets only once the link has stayed up a keepalive interval
    // (first keepalive tick): a relay that closes each new socket at once (1013
    // backpressure while a burst replays) then meets a growing delay, not a
    // tight reconnect loop. Without a keepalive, an open is proof enough.
    if (this.#keepaliveMs <= 0) this.#attempt = 0;
    // Image transfers in flight on the old socket are lost with it.
    this.#store.restartMediaTransfers();
    this.#relayChanged();
    const socket = this.#socket;
    if (!socket) return;
    // (Re)attach every machine first: the aggregator drops envelopes for a route
    // this socket has not attached, so a frame buffered while disconnected must
    // follow its attach. Then flush the buffer in order, then say hello on every
    // channel: the agent's ack triggers the sync that restores full state. A
    // buffered frame was sealed to the agent epoch its channel had verified; if
    // that agent restarted meanwhile, the new one drops it (an accepted loss),
    // and its first broadcast makes the channel handshake again.
    for (const machine of this.#machines)
      socket.send(
        JSON.stringify({ type: "attach", machineId: machine.machineId }),
      );
    for (const raw of this.#outbound.drain()) socket.send(raw);
    // A new socket may have missed broadcasts: the next ack syncs again.
    this.#synced.clear();
    for (const machine of this.#machines)
      this.#channels.get(machine.machineId)?.hello();
    this.#startKeepalive();
    // With nothing to attach the relay sends no machine list, yet the live
    // answer is known: this phone has no machines.
    if (this.#machines.length === 0) this.#store.setMachineList([]);
  }

  #onClose(gen: number, code: number): void {
    if (gen !== this.#generation) return;
    const opened = this.#connected;
    this.#connected = false;
    this.#socket = undefined;
    this.#disarmDial();
    if (code === SIGNED_OUT_CLOSE) {
      // The relay refuses this token from now on, so dialling again could only
      // fail: stop for good and let the app return to the sign-in screen.
      this.#signOut("revoked");
      return;
    }
    this.#relayChanged();
    this.#stopKeepalive();
    this.#scheduleReconnect();
    if (!opened) this.#onDialFailed();
  }

  /**
   * A dial that never opened in time: drop it (its late close is orphaned)
   * and retry on the backoff, counting it as a failed dial.
   */
  #dialTimedOut(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#generation += 1;
    socket?.close();
    this.#relayChanged();
    this.#scheduleReconnect();
    this.#onDialFailed();
  }

  #disarmDial(): void {
    this.#cancelDial?.();
    this.#cancelDial = undefined;
  }

  /** This sign-in is over: stop for good, then tell the app why. */
  #signOut(reason: SignOutReason): void {
    this.stop();
    this.#onSignedOut?.(reason);
  }

  /** Whether the session token has run out by this client's clock. */
  #tokenExpired(): boolean {
    return (
      this.#tokenExpiresAt !== undefined && this.#now() >= this.#tokenExpiresAt
    );
  }

  /** Start a new run of failed dials; a session check the old run asked is stale. */
  #endStreak(): void {
    this.#failedDials = 0;
    this.#streak += 1;
  }

  /**
   * A dial closed without ever opening. The relay refusing the upgrade — what
   * a token it no longer accepts gets — looks to the browser like a dead link
   * (1006), so after two such dials in a row the relay is asked about the
   * token, once per run. "invalid" ends the sign-in; any other answer, or
   * none, leaves the backoff retrying.
   */
  #onDialFailed(): void {
    this.#failedDials += 1;
    const checkSession = this.#checkSession;
    if (
      checkSession === undefined ||
      this.#failedDials !== FAILED_DIALS_BEFORE_CHECK
    )
      return;
    const streak = this.#streak;
    void checkSession().then(
      (status) => {
        // Stale once a socket opened, or the client woke or stopped, since.
        if (status === "invalid" && streak === this.#streak)
          this.#signOut("expired");
      },
      () => {}, // no answer: keep retrying
    );
  }

  /** Tell `onRelayState` when `relayState` moved; call after `#connected` or `#socket` does. */
  #relayChanged(): void {
    const state = this.relayState;
    if (state === this.#reportedRelay) return;
    this.#reportedRelay = state;
    this.#onRelayState?.(state);
  }

  #onMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return; // not a JSON line — drop
    }
    // Clear control carries a discriminant `type`; sealed envelopes carry `route`.
    if (typeof json === "object" && json !== null && "type" in json) {
      this.#onControl(json);
      return;
    }
    const env = RoutedEnvelope.safeParse(json);
    if (!env.success) return;
    this.#sinks.get(env.data.route)?.deliver(raw);
  }

  #onControl(json: unknown): void {
    const parsed = ServerControl.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;
    // The aggregator lists every live agent; show only the machines paired
    // here, so one forgotten on this device stays out of the tree.
    if (msg.type === "machines")
      this.#store.setMachineList(
        msg.machineIds.filter((machineId) => this.#paired.has(machineId)),
      );
    // A pong answers a resume probe. It also disarmed the keepalive deadline,
    // as any line does. "error" is surfaced by the shell.
    if (msg.type === "pong") this.#disarmProbe();
  }

  #startKeepalive(): void {
    if (this.#keepaliveMs <= 0) return;
    this.#stopKeepalive();
    this.#cancelKeepalive = this.#scheduler.setInterval(
      () => this.#keepalive(),
      this.#keepaliveMs,
    );
  }

  /**
   * One keepalive tick: end the sign-in if the token ran out meanwhile, else
   * ping and await an answer. A link that stayed up a whole interval also
   * resets the reconnect backoff.
   */
  #keepalive(): void {
    if (this.#tokenExpired()) {
      this.#signOut("expired");
      return;
    }
    this.#attempt = 0;
    const socket = this.#socket;
    if (!this.#connected || socket === undefined) return;
    socket.send(JSON.stringify({ type: "ping" }));
    this.#armPong();
  }

  /**
   * Expect a line within the pong deadline. It runs from the oldest unanswered
   * ping, so a later ping does not push it back. If it passes, the socket is
   * half-open (the relay, or the path to it, went away without a close): it is
   * dropped and redialled at once, as `wake()` does, and a redial that fails
   * backs off as usual.
   */
  #armPong(): void {
    if (this.#pongTimeoutMs <= 0 || this.#cancelPong !== undefined) return;
    const gen = this.#generation;
    this.#cancelPong = this.#scheduler.setTimer(() => {
      this.#cancelPong = undefined;
      if (gen === this.#generation) this.wake();
    }, this.#pongTimeoutMs);
  }

  #disarmPong(): void {
    this.#cancelPong?.();
    this.#cancelPong = undefined;
  }

  #disarmProbe(): void {
    this.#cancelProbe?.();
    this.#cancelProbe = undefined;
  }

  #stopKeepalive(): void {
    this.#cancelKeepalive?.();
    this.#cancelKeepalive = undefined;
    this.#disarmPong();
    this.#disarmProbe();
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const delay = backoffDelay(this.#backoff, this.#attempt, this.#random);
    this.#attempt += 1;
    this.#cancelReconnect = this.#scheduler.setTimer(() => {
      this.#cancelReconnect = undefined;
      this.#connect();
    }, delay);
  }
}
