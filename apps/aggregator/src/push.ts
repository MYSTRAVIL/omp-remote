import type { PushSubscriptionStore } from "./push-store";
import {
  type PushSubscription,
  type VapidKeys,
  buildPushRequest,
  importSigningKey,
} from "./vapid";

/** The slice of `fetch` the push sender needs. Injected so tests never hit the network. */
export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Uint8Array<ArrayBuffer>;
  },
) => Promise<{ status: number }>;

export interface PushServiceOptions {
  keys: VapidKeys;
  store: PushSubscriptionStore;
  /** Defaults to the global `fetch`; injected in tests. */
  fetch?: FetchFn;
  /** Defaults to `Date.now`; injected in tests. */
  now?: () => number;
}

/**
 * Fans "needs attention" Web Pushes to every stored subscription. A push is
 * either payloadless or carries the agent's SEALED notice — an envelope sealed
 * with a key the aggregator never holds, which it only RFC 8291-wraps per
 * subscription (see `buildPushRequest`) so the push service will deliver it.
 * So a fully compromised push service or VPS learns only that *a* device was
 * pinged, and roughly how big the notice was. A subscription the push service
 * reports gone (404/410) is pruned; any other transport or encryption error is
 * swallowed so one dead endpoint can neither break the fan-out nor crash the
 * content-blind aggregator.
 */
export class PushService {
  readonly #keys: VapidKeys;
  readonly #store: PushSubscriptionStore;
  readonly #fetch: FetchFn;
  readonly #now: () => number;
  #signingKey: Promise<CryptoKey> | undefined;

  constructor(opts: PushServiceOptions) {
    this.#keys = opts.keys;
    this.#store = opts.store;
    this.#fetch = opts.fetch ?? fetch;
    this.#now = opts.now ?? Date.now;
  }

  /** The app-server public key the PWA passes as `applicationServerKey`. */
  vapidPublicKey(): string {
    return this.#keys.publicKey;
  }

  /**
   * Persist a device's push subscription (replacing any prior one for its
   * endpoint), made by a sign-in of token epoch `epoch` — none without a gate.
   */
  async subscribe(sub: PushSubscription, epoch?: number): Promise<void> {
    await this.#store.add(sub, epoch);
  }

  /** Drop every subscription made before token epoch `epoch` (a sign-out-everywhere). */
  async retireBefore(epoch: number): Promise<void> {
    await this.#store.retireBefore(epoch);
  }

  /**
   * Push an attention signal to every subscribed device — with a token `epoch`
   * given, only to those subscribed under it (or untagged): a device signed out
   * everywhere is never woken, even while its subscription awaits retiring.
   * `notice`, when given, is the agent's opaque sealed envelope, sent verbatim
   * (as UTF-8) as each push's encrypted payload; absent, pushes are payloadless.
   */
  async notifyAll(epoch?: number, notice?: string): Promise<void> {
    let key: CryptoKey;
    try {
      if (this.#signingKey === undefined)
        this.#signingKey = importSigningKey(this.#keys);
      key = await this.#signingKey;
    } catch (err) {
      // A bad VAPID key must not become an unhandled rejection in the fire-and-
      // forget attention path. Clear the cache so a later fix can recover.
      this.#signingKey = undefined;
      console.error(
        `omp-remote push: VAPID key unusable: ${(err as Error).message}`,
      );
      return;
    }
    const now = this.#now();
    const payload =
      notice === undefined ? undefined : new TextEncoder().encode(notice);
    for (const sub of [...this.#store.list()]) {
      if (epoch !== undefined && sub.ep !== undefined && sub.ep !== epoch)
        continue;
      try {
        const req = await buildPushRequest(sub, this.#keys, now, key, payload);
        const res = await this.#fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
        // 404/410 mean the subscription is permanently gone (RFC 8030) — prune it.
        if (res.status === 404 || res.status === 410)
          await this.#store.remove(sub.endpoint);
      } catch (err) {
        console.error(
          `omp-remote push: ${sub.endpoint} failed: ${(err as Error).message}`,
        );
      }
    }
  }
}
