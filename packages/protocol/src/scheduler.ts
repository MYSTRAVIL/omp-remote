/**
 * Reconnect/backoff timing primitives shared by the host-agent uplink and the
 * PWA client (spec §4.1/§4.2/§9). A `Scheduler` abstracts the wall clock so
 * reconnect and keepalive can be driven deterministically by a test double — its
 * methods return a canceller closure rather than an opaque handle, which sidesteps
 * the Bun `Timer` vs DOM `number` handle-type split entirely.
 */

/** Bounded jittered reconnect backoff. */
export interface BackoffConfig {
  /** First-attempt delay in ms. */
  baseMs: number;
  /** Upper bound on the pre-jitter delay in ms. */
  maxMs: number;
  /** Exponential growth per attempt. */
  factor: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
};

/** The pre-jitter, capped delay for a given (zero-based) attempt. */
export function backoffCeil(cfg: BackoffConfig, attempt: number): number {
  return Math.min(cfg.maxMs, cfg.baseMs * cfg.factor ** attempt);
}

/**
 * The actual delay to wait before a reconnect attempt: the capped ceiling with
 * full jitter over `[0.5, 1.0)` of the ceiling, from an injectable `[0,1)` source.
 */
export function backoffDelay(
  cfg: BackoffConfig,
  attempt: number,
  random: () => number,
): number {
  return backoffCeil(cfg, attempt) * (0.5 + random() * 0.5);
}

/**
 * A minimal timer surface. Each scheduling call returns a canceller; calling it
 * cancels the pending timeout / stops the interval. No handle type crosses the
 * boundary, so the same interface serves Bun and the browser.
 */
export interface Scheduler {
  /** Run `fn` once after `ms`; returns a canceller. */
  setTimer(fn: () => void, ms: number): () => void;
  /** Run `fn` every `ms`; returns a canceller. */
  setInterval(fn: () => void, ms: number): () => void;
}

/** The production scheduler backed by the ambient global timers. */
export const defaultScheduler: Scheduler = {
  setTimer(fn, ms) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  },
};
