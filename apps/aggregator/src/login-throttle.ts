interface Entry {
  failures: number;
  /** Epoch ms of the most recent failure. */
  lastAt: number;
}

type Verdict = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * Brute-force brake for password sign-in. The first `freeFailures` failures
 * for a key cost nothing; each later one locks the key for 1, 2, 4 … seconds
 * (capped at `maxDelaySec`) from that failure. A success clears the key.
 *
 * Every failure also counts against one global budget, which locks every key
 * the same way once it is past `globalFreeFailures` — so a client that rotates
 * keys (fresh addresses) cannot outrun the lockout. A success clears it too:
 * only the password earns one.
 *
 * `now` is epoch ms. At most `maxKeys` keys are kept; when full, the least
 * recently failed key that is not locked out is dropped. A locked-out key is
 * never dropped — that would forget its lockout — so when every kept key is
 * locked out, a new key's failures count against one shared overflow key,
 * whose lock every key not kept is held to.
 */
export class LoginThrottle {
  readonly #entries = new Map<string, Entry>();
  #global: Entry | undefined;
  #overflow: Entry | undefined;
  readonly #freeFailures: number;
  readonly #globalFreeFailures: number;
  readonly #maxDelaySec: number;
  readonly #maxKeys: number;

  constructor(
    opts: {
      freeFailures?: number;
      globalFreeFailures?: number;
      maxDelaySec?: number;
      maxKeys?: number;
    } = {},
  ) {
    this.#freeFailures = opts.freeFailures ?? 5;
    this.#globalFreeFailures = opts.globalFreeFailures ?? 20;
    this.#maxDelaySec = opts.maxDelaySec ?? 900;
    this.#maxKeys = opts.maxKeys ?? 1024;
  }

  check(key: string, now: number): Verdict {
    const entry = this.#entries.get(key);
    const remainingMs = Math.max(
      entry === undefined
        ? this.#remainingMs(this.#overflow, this.#freeFailures, now)
        : this.#remainingMs(entry, this.#freeFailures, now),
      this.#remainingMs(this.#global, this.#globalFreeFailures, now),
    );
    if (remainingMs <= 0) return { ok: true };
    return { ok: false, retryAfterSec: Math.ceil(remainingMs / 1000) };
  }

  fail(key: string, now: number): void {
    this.#global = bump(this.#global, now);
    const entry = this.#entries.get(key);
    if (entry === undefined && this.#entries.size >= this.#maxKeys) {
      if (!this.#dropUnlocked(now)) {
        this.#overflow = bump(this.#overflow, now);
        return;
      }
    }
    // Re-insert so Map order tracks recency of failure.
    this.#entries.delete(key);
    this.#entries.set(key, bump(entry, now));
  }

  succeed(key: string): void {
    this.#entries.delete(key);
    this.#global = undefined;
    this.#overflow = undefined;
  }

  /** Ms until `entry`'s lock lifts (≤ 0: not locked), past `free` free failures. */
  #remainingMs(entry: Entry | undefined, free: number, now: number): number {
    if (entry === undefined) return 0;
    const over = entry.failures - free;
    if (over <= 0) return 0;
    const delayMs = Math.min(2 ** (over - 1), this.#maxDelaySec) * 1000;
    return entry.lastAt + delayMs - now;
  }

  /** Drop the least recently failed key not locked out; false if every key is. */
  #dropUnlocked(now: number): boolean {
    for (const [key, entry] of this.#entries) {
      if (this.#remainingMs(entry, this.#freeFailures, now) > 0) continue;
      this.#entries.delete(key);
      return true;
    }
    return false;
  }
}

function bump(entry: Entry | undefined, now: number): Entry {
  return { failures: (entry?.failures ?? 0) + 1, lastAt: now };
}
