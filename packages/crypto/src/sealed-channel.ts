import {
  BoundedQueue,
  SealedAckPayload,
  type SealedFrame,
  SealedFrame as SealedFrameSchema,
  SealedWireEnvelope,
} from "@omp-remote/protocol";
import sodium from "libsodium-wrappers";
import type { ZodType } from "zod";
import { b64u } from "./identity";
import { type SessionKeys, open, seal } from "./session";

export interface ByteSink {
  send(bytes: Uint8Array): void;
  onBytes(cb: (b: Uint8Array) => void): void;
}

/**
 * `initiator`: the phone (client session keys), which binds to one responder
 * epoch through a hello/ack handshake. `responder`: the host-agent (server
 * session keys), whose frames are broadcast to every phone on the route.
 */
export type SealedChannelRole = "initiator" | "responder";

/**
 * Why an inbound line was dropped. `malformed`: not a v2 wire envelope.
 * `auth-failed`: it does not open under this channel's key and route (tampered
 * header or ciphertext, other keys). `replayed`: its counter is not past the
 * highest already accepted from that sender epoch, or an ack answers an old
 * hello. `stale-epoch`: phone data bound to a responder epoch that is no longer
 * current. `unknown-peer`: from a sender epoch no handshake verified.
 * `invalid-frame`: authentic, but its payload is not what its kind carries.
 */
export type SealedRejectReason =
  | "malformed"
  | "auth-failed"
  | "replayed"
  | "stale-epoch"
  | "unknown-peer"
  | "invalid-frame";

export interface SealedChannelOptions {
  role: SealedChannelRole;
  /** Responder: initiator epochs tracked before its own epoch rotates. Default 1024. */
  maxPeers?: number;
  /** Initiator: frames held until an ack verifies a responder epoch, drop-oldest. Default 256. */
  maxPending?: number;
  /** Diagnostics for every dropped inbound line. Never receives plaintext. */
  onReject?: (reason: SealedRejectReason) => void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Versions the associated data: a seal from another protocol version never opens. */
const AAD_TAG = "omp-remote/sealed/v2";
const EPOCH_BYTES = 16;
/**
 * Phone instances (one per page load) a responder tracks before it rotates its
 * epoch. An entry is a short epoch and a counter, so a full table stays near
 * 100 KiB, and a rotation, which drops what phones sealed to the old epoch,
 * stays rare.
 */
const DEFAULT_MAX_PEERS = 1024;
const DEFAULT_MAX_PENDING = 256;
const EMPTY = new Uint8Array(0);

type WireKind = SealedWireEnvelope["k"];
type WireHeader = Pick<SealedWireEnvelope, "k" | "e" | "c" | "a">;

/**
 * Every clear header field, so editing any of them fails authentication. The
 * route is the receiving channel's own, so an envelope never opens on a route
 * other than the one it was sealed for.
 */
function associatedData(route: string, h: WireHeader): Uint8Array {
  return enc.encode(
    JSON.stringify([AAD_TAG, route, h.k, h.e, h.c, h.a ?? null]),
  );
}

/** The payload if `schema` accepts its JSON, else `undefined`. */
function decodePayload<T>(
  plaintext: Uint8Array,
  schema: ZodType<T>,
): T | undefined {
  let json: unknown;
  try {
    json = JSON.parse(dec.decode(plaintext));
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

interface InitiatorState {
  role: "initiator";
  /** The responder epoch an accepted ack verified, and the highest counter accepted from it. */
  peer: { epoch: string; hi: number } | undefined;
  /** The hello counter the last accepted ack answered: older acks are replays. */
  answered: number;
  /**
   * The unverified responder envelope the last nudge answered: its epoch and
   * counter. A hello from that epoch nudges again only past that counter, its
   * data never. Kept across acks, so however often the relay replays one
   * envelope, it draws one hello at most. Only the last epoch is kept: a relay
   * alternating recordings of two dead epochs draws a hello and an ack per
   * injected line: denial of service, never a delivery.
   */
  nudged: { epoch: string; c: number } | undefined;
  /** Plaintext frames waiting for a verified responder epoch. */
  pending: BoundedQueue<SealedFrame>;
  /** A flush is draining `pending`: new frames queue behind it to keep FIFO order. */
  flushing: boolean;
}

interface ResponderState {
  role: "responder";
  /** Initiator epoch → the highest counter accepted from it under the current epoch. */
  peers: Map<string, number>;
  /**
   * Initiator epochs already sent a hello for data bound to a stale epoch. An
   * epoch leaves once a hello from it is accepted, so a lost ack is retried.
   */
  nudged: Set<string>;
  maxPeers: number;
}

/**
 * Carries protocol frames end-to-end over an untrusted byte transport and binds
 * them against replay. A relay forwarding the bytes sees only the clear header
 * of each `SealedWireEnvelope`: the route (for switching), the sender's random
 * per-instance epoch and counter, and the receiver epoch it is bound to. The
 * frame is sealed under the per-session key, and the header is authenticated.
 *
 * The initiator (phone) holds its frames until an ack verifies a responder
 * epoch, then seals them to that epoch. The ack must be bound to its own epoch
 * and answer a newer hello than the last ack it accepted. The responder
 * (host-agent) delivers phone data only when it is bound to its current epoch
 * and its counter is past the highest seen from that phone instance. The phone
 * delivers the responder's broadcast only from the verified epoch, with
 * counters past the ack. So a recorded envelope never delivers twice, nor to a
 * later instance of either end. A relay can still drop or delay lines, or force
 * a re-handshake: denial of service it can do anyway. A lost hello or ack is
 * retried rather than wedging the phone: it answers any hello newer than the
 * one it last answered, which the agent sends on every uplink open and, once
 * per hello it accepts from a phone, for that phone's stale frame.
 */
export class SealedChannel {
  readonly #keys: SessionKeys;
  readonly #wire: ByteSink;
  readonly #route: string;
  readonly #state: InitiatorState | ResponderState;
  readonly #onReject: ((reason: SealedRejectReason) => void) | undefined;
  /** This instance's epoch. A responder draws a new one when it rotates. */
  #epoch = b64u(sodium.randombytes_buf(EPOCH_BYTES));
  /** The last counter sent. Every envelope takes the next one, whatever its kind. */
  #counter = 0;
  #frameCbs: ((f: SealedFrame) => void)[] = [];
  #readyCbs: ((peerEpoch: string) => void)[] = [];
  #closed = false;

  constructor(
    keys: SessionKeys,
    wire: ByteSink,
    routeId: string,
    options: SealedChannelOptions,
  ) {
    this.#keys = keys;
    this.#wire = wire;
    this.#route = routeId;
    this.#onReject = options.onReject;
    if (options.role === "initiator") {
      this.#state = {
        role: "initiator",
        peer: undefined,
        answered: 0,
        nudged: undefined,
        pending: new BoundedQueue(options.maxPending ?? DEFAULT_MAX_PENDING),
        flushing: false,
      };
    } else {
      const maxPeers = options.maxPeers ?? DEFAULT_MAX_PEERS;
      if (!Number.isInteger(maxPeers) || maxPeers < 1)
        throw new RangeError(`maxPeers must be >= 1, got ${maxPeers}`);
      this.#state = {
        role: "responder",
        peers: new Map(),
        nudged: new Set(),
        maxPeers,
      };
    }
    this.#wire.onBytes((b) => this.#onBytes(b));
  }

  /**
   * Say hello. The owner calls it on every socket (re)open; it is never sent at
   * construction. An initiator asks for an ack binding it to the live responder
   * epoch. A responder announces its epoch, so a phone still bound to a dead or
   * rotated one re-handshakes, and one whose handshake was lost retries it.
   */
  hello(): void {
    if (!this.#closed) this.#emit("h", EMPTY);
  }

  /**
   * Initiator: `cb` runs after every accepted ack with the verified responder
   * epoch, once the held frames are flushed. Never fires on a responder.
   */
  onReady(cb: (peerEpoch: string) => void): void {
    this.#readyCbs.push(cb);
  }

  /**
   * Detach: stop emitting frames and refuse to send. Idempotent. The `ByteSink`
   * contract has no unsubscribe, so `#closed` also gates inbound dispatch — a
   * retained channel never decodes or answers under its keys after close. Held
   * frames are discarded.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#frameCbs = [];
    this.#readyCbs = [];
    if (this.#state.role === "initiator") this.#state.pending.clear();
  }

  /**
   * Seal a frame to the peer. A responder broadcasts it at once. An initiator
   * holds it until an ack verifies a responder epoch, then seals it to that
   * epoch. A frame sealed to an agent epoch that has since ended is dropped by
   * the agent: a known, accepted loss. The epoch ends when the agent restarts,
   * or when it rotates past `maxPeers` phone instances. The phone re-handshakes
   * on the first line it sees from the new epoch.
   */
  sendFrame(frame: SealedFrame): void {
    if (this.#closed) return;
    const s = this.#state;
    if (s.role === "responder") {
      this.#emit("d", enc.encode(JSON.stringify(frame)));
      return;
    }
    if (s.peer === undefined || s.flushing) {
      s.pending.push(frame);
      return;
    }
    this.#emit("d", enc.encode(JSON.stringify(frame)), s.peer.epoch);
  }

  onFrame(cb: (f: SealedFrame) => void): void {
    this.#frameCbs.push(cb);
  }

  #emit(k: WireKind, plaintext: Uint8Array, a?: string): void {
    this.#counter += 1;
    const header: WireHeader = { k, e: this.#epoch, c: this.#counter, a };
    const { n, ct } = seal(
      this.#keys.tx,
      plaintext,
      associatedData(this.#route, header),
    );
    const wire: SealedWireEnvelope = { route: this.#route, ...header, n, ct };
    this.#wire.send(enc.encode(`${JSON.stringify(wire)}\n`));
  }

  #onBytes(bytes: Uint8Array): void {
    for (const line of dec.decode(bytes).split("\n")) {
      if (this.#closed) return;
      if (line.trim() !== "") this.#onLine(line);
    }
  }

  #onLine(line: string): void {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      this.#onReject?.("malformed");
      return;
    }
    const parsed = SealedWireEnvelope.safeParse(json);
    if (!parsed.success) {
      this.#onReject?.("malformed");
      return;
    }
    const wire = parsed.data;
    let plaintext: Uint8Array;
    try {
      plaintext = open(this.#keys.rx, wire, associatedData(this.#route, wire));
    } catch {
      this.#onReject?.("auth-failed");
      return;
    }
    const s = this.#state;
    if (s.role === "initiator") {
      if (wire.k === "a") this.#initiatorOnAck(s, wire, plaintext);
      else if (wire.k === "d") this.#initiatorOnData(s, wire, plaintext);
      else this.#initiatorOnHello(s, wire, plaintext);
    } else if (wire.k === "h") this.#responderOnHello(s, wire, plaintext);
    else if (wire.k === "d") this.#responderOnData(s, wire, plaintext);
    // Only a responder sends acks: one that opens here was sealed by a phone.
    else this.#onReject?.("invalid-frame");
  }

  #initiatorOnAck(
    s: InitiatorState,
    wire: SealedWireEnvelope,
    plaintext: Uint8Array,
  ): void {
    // Acks are broadcast to every tab on the route: one bound to another
    // instance's epoch is not addressed to this one, so it is no drop either.
    if (wire.a !== this.#epoch) return;
    const answered = decodePayload(plaintext, SealedAckPayload);
    if (answered === undefined) {
      this.#onReject?.("invalid-frame");
      return;
    }
    // An ack answering a hello no newer than the last accepted one is a
    // recording: accepting it could re-bind to an older responder epoch and
    // reopen that epoch's stream at the ack's counter.
    if (answered <= s.answered) {
      this.#onReject?.("replayed");
      return;
    }
    const peer = s.peer;
    if (peer !== undefined && wire.e === peer.epoch) {
      if (wire.c <= peer.hi) {
        this.#onReject?.("replayed");
        return;
      }
      peer.hi = wire.c;
    } else s.peer = { epoch: wire.e, hi: wire.c };
    s.answered = answered;
    this.#flush(s);
    for (const cb of this.#readyCbs) {
      if (this.#closed) return;
      cb(wire.e);
    }
  }

  #initiatorOnData(
    s: InitiatorState,
    wire: SealedWireEnvelope,
    plaintext: Uint8Array,
  ): void {
    const peer = s.peer;
    if (peer === undefined || wire.e !== peer.epoch) {
      // A responder epoch no ack verified: the agent restarted or rotated, or
      // this is a recording. Drop it, and say hello once per such epoch (not
      // once per frame of its stream) so a live agent binds this instance anew.
      this.#onReject?.("unknown-peer");
      if (s.nudged?.epoch !== wire.e) this.#nudge(s, wire);
      return;
    }
    if (wire.c <= peer.hi) {
      this.#onReject?.("replayed");
      return;
    }
    peer.hi = wire.c;
    this.#deliver(plaintext);
  }

  #initiatorOnHello(
    s: InitiatorState,
    wire: SealedWireEnvelope,
    plaintext: Uint8Array,
  ): void {
    if (plaintext.length > 0) {
      this.#onReject?.("invalid-frame");
      return;
    }
    // The verified epoch announcing itself again changes nothing. Another
    // epoch is answered unless this hello is no newer than the envelope the
    // last nudge answered (a replay, or an announcement already answered). So
    // a lost hello or ack is retried on the agent's next announcement, while a
    // recording never draws a second hello.
    if (wire.e === s.peer?.epoch) return;
    const last = s.nudged;
    if (last?.epoch === wire.e && wire.c <= last.c) return;
    this.#nudge(s, wire);
  }

  /** Say hello to an unverified responder epoch, recording the envelope that prompted it. */
  #nudge(s: InitiatorState, wire: SealedWireEnvelope): void {
    s.nudged = { epoch: wire.e, c: wire.c };
    this.#emit("h", EMPTY);
  }

  /** Send the held frames in FIFO order, sealed to the verified responder epoch. */
  #flush(s: InitiatorState): void {
    // Re-entered from a synchronous transport: the outer flush drains the rest.
    if (s.flushing) return;
    s.flushing = true;
    try {
      let batch = s.pending.drain();
      while (batch.length > 0) {
        for (const frame of batch) {
          if (this.#closed || s.peer === undefined) return;
          this.#emit("d", enc.encode(JSON.stringify(frame)), s.peer.epoch);
        }
        batch = s.pending.drain();
      }
    } finally {
      s.flushing = false;
    }
  }

  #responderOnHello(
    s: ResponderState,
    wire: SealedWireEnvelope,
    plaintext: Uint8Array,
  ): void {
    if (plaintext.length > 0) {
      this.#onReject?.("invalid-frame");
      return;
    }
    const hi = s.peers.get(wire.e);
    if (hi !== undefined && wire.c <= hi) {
      this.#onReject?.("replayed");
      return;
    }
    // Initiator epochs leave `peers` only through a rotation, which kills every
    // binding to the old epoch, so a replayed hello can never reset a counter.
    // Rotating also sheds the epochs of closed tabs. The live ones re-handshake
    // on the broadcast hello. State settles before anything is sent, so a
    // synchronous transport answering at once sees it whole.
    const rotate = hi === undefined && s.peers.size >= s.maxPeers;
    if (rotate) {
      this.#epoch = b64u(sodium.randombytes_buf(EPOCH_BYTES));
      s.peers.clear();
      s.nudged.clear();
    }
    s.peers.set(wire.e, wire.c);
    // Answered: should the ack be lost, this phone's next stale frame nudges it
    // again. A replayed hello was refused above, so it cannot re-arm the nudge.
    s.nudged.delete(wire.e);
    if (rotate) this.#emit("h", EMPTY);
    this.#emit("a", enc.encode(JSON.stringify(wire.c)), wire.e);
  }

  #responderOnData(
    s: ResponderState,
    wire: SealedWireEnvelope,
    plaintext: Uint8Array,
  ): void {
    if (wire.a !== this.#epoch) {
      // The phone is bound to a dead or rotated epoch of ours. Broadcast a
      // hello so it re-handshakes: once per phone instance until a hello from
      // it is accepted, not once per stale frame.
      this.#onReject?.("stale-epoch");
      if (s.nudged.has(wire.e)) return;
      if (s.nudged.size >= s.maxPeers) s.nudged.clear();
      s.nudged.add(wire.e);
      this.#emit("h", EMPTY);
      return;
    }
    const hi = s.peers.get(wire.e);
    if (hi === undefined) {
      this.#onReject?.("unknown-peer");
      return;
    }
    if (wire.c <= hi) {
      this.#onReject?.("replayed");
      return;
    }
    s.peers.set(wire.e, wire.c);
    this.#deliver(plaintext);
  }

  #deliver(plaintext: Uint8Array): void {
    const frame = decodePayload(plaintext, SealedFrameSchema);
    if (frame === undefined) {
      this.#onReject?.("invalid-frame");
      return;
    }
    for (const cb of this.#frameCbs) {
      if (this.#closed) return;
      cb(frame);
    }
  }
}
