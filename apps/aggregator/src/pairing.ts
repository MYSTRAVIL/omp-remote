import type {
  PairClaimRequest,
  PairClaimResponse,
  PairHostRequest,
  PairHostResponse,
  PairRefusalReason,
  PairResultRequest,
  PairResultResponse,
} from "@omp-remote/protocol";
import { oldestOfLargestShare } from "./largest-share";

/** Raised by {@link PairingBroker.registerHost} when no pending slot can be made. */
export class PairingBrokerError extends Error {}

/** Tunables for {@link PairingBroker}; every field is optional with a production default. */
export interface PairingBrokerOptions {
  /** How long a registered pairing stays claimable, in ms (default 5 minutes). */
  ttlMs?: number;
  /** Max concurrent pending pairings before a new rendezvous is rejected (default 256). */
  maxPending?: number;
  /**
   * Max pending pairings one client address may hold (default 4); its next
   * one displaces its own oldest.
   */
  maxPendingPerClient?: number;
  /** Max claim attempts on one rendezvous before it is purged (default 5). */
  maxClaimAttempts?: number;
  /** Injectable clock (epoch ms) — tests advance it instead of sleeping. */
  now?: () => number;
}

/**
 * Who registered a pending pairing: the client address it came from (the
 * server's `clientAddress`; undefined when none is usable), and whether it
 * presented the machine's current `/agent` token — the only way a claim may
 * replace the token of a machine that already exists.
 */
export interface PairingHost {
  client: string | undefined;
  renews: boolean;
}

/** A claim the broker accepted: the host side for the phone, and how the host registered. */
export interface PairingClaim {
  response: PairClaimResponse;
  renews: boolean;
}

/**
 * A pending pairing the broker holds between the host's registration and the
 * phone's claim. It carries ONLY public keys, MACs, the machine's route label,
 * the code-derived rendezvous id, who registered it, timing, and — once
 * claimed — the machine's `/agent` token for the host to collect, or why the
 * server refused the claim; never a private/session key or any session
 * plaintext (the aggregator stays content-blind, spec §7/§12).
 */
interface Pending extends PairingHost {
  readonly machineId: string;
  readonly hostPub: string;
  readonly hostMac: string;
  expiresAt: number;
  claimed: boolean;
  claimAttempts: number;
  phonePub?: string;
  phoneMac?: string;
  agentToken?: string;
  refused?: PairRefusalReason;
}

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_MAX_PENDING = 256;
/** A host pairs one machine at a time; 4 leaves room for a retry or two. */
const DEFAULT_MAX_PENDING_PER_CLIENT = 4;
const DEFAULT_MAX_CLAIM_ATTEMPTS = 5;

/**
 * In-memory, content-blind broker for the aggregator-brokered pairing ceremony.
 * It rendezvouses a host and a phone by the opaque, code-derived `rendezvousId`
 * alone and relays each side's public key + MAC to the other. The host commits
 * first (`registerHost`), the phone claims once (`claim`), and the host polls
 * for the phone side once (`result`); the entry is single-use on both the claim
 * and the result. TTL is swept lazily on every op and the clock is injectable so
 * tests advance time instead of sleeping.
 */
export class PairingBroker {
  readonly #ttlMs: number;
  readonly #maxPending: number;
  readonly #maxPendingPerClient: number;
  readonly #maxClaimAttempts: number;
  readonly #now: () => number;
  /** In registration order, oldest first. */
  readonly #pending = new Map<string, Pending>();

  constructor(opts: PairingBrokerOptions = {}) {
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.#maxPendingPerClient =
      opts.maxPendingPerClient ?? DEFAULT_MAX_PENDING_PER_CLIENT;
    this.#maxClaimAttempts =
      opts.maxClaimAttempts ?? DEFAULT_MAX_CLAIM_ATTEMPTS;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Register (or overwrite) a host's pending pairing under its `rendezvousId`,
   * resetting the TTL and the claim state. A client address at
   * `maxPendingPerClient` gives up its own oldest unclaimed pairing. With
   * every slot held, the client holding the most unclaimed pairings gives up
   * its oldest (registrations with no usable address count as one client),
   * so a flood displaces its own pairings long before anyone else's lone one;
   * a claimed pairing or a renewal never gives way. With nothing left to give
   * up it is refused with {@link PairingBrokerError}.
   */
  registerHost(
    req: PairHostRequest,
    host: PairingHost = { client: undefined, renews: false },
  ): PairHostResponse {
    this.#sweep();
    // An overwrite re-registers: it gives up its old slot and takes a new one.
    this.#pending.delete(req.rendezvousId);
    if (!this.#makeRoom(host.client))
      throw new PairingBrokerError("pairing broker full");
    const expiresAt = this.#now() + this.#ttlMs;
    this.#pending.set(req.rendezvousId, {
      machineId: req.machineId,
      hostPub: req.hostPub,
      hostMac: req.hostMac,
      client: host.client,
      renews: host.renews,
      expiresAt,
      claimed: false,
      claimAttempts: 0,
    });
    return { expiresAt };
  }

  /**
   * The phone claims a pending pairing by `rendezvousId`. Returns the host side
   * exactly once. A claim on an unknown/expired rendezvous, a re-claim of an
   * already-claimed pairing, or a claim past the attempt cap all yield
   * `undefined`; exceeding the cap also purges the entry so a claim-flood burns
   * the pairing rather than lingering.
   */
  claim(req: PairClaimRequest): PairingClaim | undefined {
    this.#sweep();
    const pending = this.#pending.get(req.rendezvousId);
    if (pending === undefined) return undefined;
    if (pending.claimed) return undefined; // already claimed: a cheap no-op, never burn an attempt
    pending.claimAttempts += 1;
    if (pending.claimAttempts > this.#maxClaimAttempts) {
      this.#pending.delete(req.rendezvousId);
      return undefined;
    }
    pending.phonePub = req.phonePub;
    pending.phoneMac = req.phoneMac;
    pending.claimed = true;
    return {
      response: {
        machineId: pending.machineId,
        hostPub: pending.hostPub,
        hostMac: pending.hostMac,
      },
      renews: pending.renews,
    };
  }

  /**
   * Hand the claimed pairing under `rendezvousId` the machine's freshly issued
   * `/agent` token, for the host's `result` to collect. A pairing that expired
   * meanwhile takes nothing.
   */
  grant(rendezvousId: string, agentToken: string): void {
    const pending = this.#pending.get(rendezvousId);
    if (pending?.claimed) pending.agentToken = agentToken;
  }

  /**
   * Refuse the claimed pairing under `rendezvousId` for `reason`: it issues no
   * token, and the host's next `result` learns why, once. A pairing that
   * expired meanwhile takes nothing.
   */
  refuse(rendezvousId: string, reason: PairRefusalReason): void {
    const pending = this.#pending.get(rendezvousId);
    if (pending?.claimed) pending.refused = reason;
  }

  /** Burn the pairing under `rendezvousId`: a claim that could not issue a token. */
  drop(rendezvousId: string): void {
    this.#pending.delete(rendezvousId);
  }

  /**
   * The host polls for the phone side. `pending` until the phone has claimed
   * and its token is granted (or if the rendezvous is unknown/expired); then it
   * returns the phone side and the token — or, if the claim was refused, why —
   * exactly once and drops the entry (single-use delivery).
   */
  result(req: PairResultRequest): PairResultResponse {
    this.#sweep();
    const pending = this.#pending.get(req.rendezvousId);
    if (pending?.refused !== undefined) {
      this.#pending.delete(req.rendezvousId);
      return { status: "refused", reason: pending.refused };
    }
    if (
      pending === undefined ||
      !pending.claimed ||
      pending.phonePub === undefined ||
      pending.phoneMac === undefined ||
      pending.agentToken === undefined
    )
      return { status: "pending" };
    const { phonePub, phoneMac, agentToken } = pending;
    this.#pending.delete(req.rendezvousId);
    return { status: "claimed", phonePub, phoneMac, agentToken };
  }

  /** Drop every entry that has reached its TTL. Called at the top of each op. */
  #sweep(): void {
    const now = this.#now();
    for (const [rendezvousId, pending] of this.#pending)
      if (pending.expiresAt <= now) this.#pending.delete(rendezvousId);
  }

  /**
   * Make a slot for a registration from `client`, or report there is none.
   * From a known address at `maxPendingPerClient` it displaces that
   * address's own oldest unclaimed pairing — never a claimed one, whose
   * token is already issued and waiting for its host — and is refused if it
   * has none. With every slot held it displaces the oldest unclaimed,
   * non-renewing pairing of the client holding the most of them.
   */
  #makeRoom(client: string | undefined): boolean {
    if (client !== undefined) {
      let oldestOwn: string | undefined;
      let own = 0;
      for (const [rendezvousId, pending] of this.#pending) {
        if (pending.client !== client) continue;
        own += 1;
        if (!pending.claimed) oldestOwn ??= rendezvousId;
      }
      if (own >= this.#maxPendingPerClient) {
        if (oldestOwn === undefined) return false;
        this.#pending.delete(oldestOwn);
        return true;
      }
    }
    if (this.#pending.size < this.#maxPending) return true;
    const displaced = oldestOfLargestShare(displaceable(this.#pending));
    if (displaced === undefined) return false;
    this.#pending.delete(displaced);
    return true;
  }
}

/**
 * Each pending pairing that may give way — unclaimed, and not a renewal by a
 * host holding the machine's token — with the client address it came from,
 * oldest first.
 */
function* displaceable(
  pending: ReadonlyMap<string, Pending>,
): Generator<[string, string | undefined]> {
  for (const [rendezvousId, entry] of pending)
    if (!entry.claimed && !entry.renews) yield [rendezvousId, entry.client];
}
