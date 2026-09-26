interface Entry {
  failures: number;
  /** Epoch ms of the most recent failure. */
  lastAt: number;
}

/** The global budget's fill: failures still counted as of `at` (epoch ms). */
interface Level {
  failures: number;
  at: number;
}

type Verdict = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * Brute-force brake for password sign-in. The first `freeFailures` failures
 * for a key cost nothing; each later one locks the key for 1, 2, 4 … seconds
 * (capped at `maxDelaySec`) from that failure. A success clears the key.
 *
 * Every failure also counts against one global budget, so a client that
 * rotates keys (fresh addresses) cannot outrun the lockout. The budget drains
 * one failure per `globalDrainMs`: past `globalFreeFailures` it locks every
 * key until it has drained back, which a burst makes seconds, not the
 * per-key maximum — and it lifts on its own, so no one client can hold it
 * shut: its own key locks long before its failures can keep the budget
 * full. A success clears it too. A try with no key (no usable client
 * address, as behind a proxy that hides clients) counts only against the
 * global budget: there every client looks alike, so a per-key lockout would
 * lock everyone out for as long as one guesser kept it armed.
 *
 * `now` is epoch ms. At most `maxKeys` keys are kept; when full, the least
 * recently failed key that is not locked out is dropped. A locked-out key is
 * never dropped — that would forget its lockout — so when every kept key is
 * locked out, a new key's failures count against one shared overflow key,
 * whose lock every key not kept is held to.
 */
export class LoginThrottle {
  readonly #entries = new Map<string, Entry>();
  #global: Level | undefined;
  #overflow: Entry | undefined;
  readonly #freeFailures: number;
  readonly #globalFreeFailures: number;
  readonly #globalDrainMs: number;
  readonly #maxDelaySec: number;
  readonly #maxKeys: number;

  constructor(
    opts: {
      freeFailures?: number;
      globalFreeFailures?: number;
      /** Ms for the global budget to drain one failure (default 30 s). */
      globalDrainMs?: number;
      maxDelaySec?: number;
      maxKeys?: number;
    } = {},
  ) {
    this.#freeFailures = opts.freeFailures ?? 5;
    this.#globalFreeFailures = opts.globalFreeFailures ?? 20;
    this.#globalDrainMs = opts.globalDrainMs ?? 30_000;
    this.#maxDelaySec = opts.maxDelaySec ?? 900;
    this.#maxKeys = opts.maxKeys ?? 1024;
  }

  /** Whether a try under `key` (undefined: no client key) may run now. */
  check(key: string | undefined, now: number): Verdict {
    const remainingMs = Math.max(
      key === undefined ? 0 : this.#keyRemainingMs(key, now),
      (this.#globalFailures(now) - this.#globalFreeFailures) *
        this.#globalDrainMs,
    );
    if (remainingMs <= 0) return { ok: true };
    return { ok: false, retryAfterSec: Math.ceil(remainingMs / 1000) };
  }

  fail(key: string | undefined, now: number): void {
    this.#global = { failures: this.#globalFailures(now) + 1, at: now };
    if (key === undefined) return;
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

  succeed(key: string | undefined): void {
    if (key !== undefined) this.#entries.delete(key);
    this.#global = undefined;
    this.#overflow = undefined;
  }

  /** Ms until `key`'s own lock lifts (≤ 0: not locked); a key not kept is held to the overflow's. */
  #keyRemainingMs(key: string, now: number): number {
    const entry = this.#entries.get(key);
    return entry === undefined
      ? this.#remainingMs(this.#overflow, this.#freeFailures, now)
      : this.#remainingMs(entry, this.#freeFailures, now);
  }

  /** The global budget's fill at `now`, drained since its last failure. */
  #globalFailures(now: number): number {
    if (this.#global === undefined) return 0;
    const drained = Math.max(0, now - this.#global.at) / this.#globalDrainMs;
    return Math.max(0, this.#global.failures - drained);
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
