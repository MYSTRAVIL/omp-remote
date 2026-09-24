import { expect, test } from "bun:test";
import {
  type BackoffConfig,
  DEFAULT_BACKOFF,
  backoffCeil,
  backoffDelay,
} from "../src/scheduler";

const cfg: BackoffConfig = { baseMs: 100, maxMs: 800, factor: 2 };

test("backoffCeil grows exponentially then caps", () => {
  expect(backoffCeil(cfg, 0)).toBe(100);
  expect(backoffCeil(cfg, 1)).toBe(200);
  expect(backoffCeil(cfg, 2)).toBe(400);
  expect(backoffCeil(cfg, 3)).toBe(800);
  expect(backoffCeil(cfg, 4)).toBe(800); // capped
  expect(backoffCeil(cfg, 50)).toBe(800); // never overflows the cap
});

test("backoffDelay applies full jitter within [0.5, 1.0) of the ceiling", () => {
  // random=0 → half the ceiling; random→1 → just under the full ceiling.
  expect(backoffDelay(cfg, 1, () => 0)).toBe(100); // 200 * 0.5
  expect(backoffDelay(cfg, 1, () => 0.9999999)).toBeLessThan(200);
  expect(backoffDelay(cfg, 1, () => 0.5)).toBe(150); // 200 * 0.75
});

test("DEFAULT_BACKOFF is a sane bounded shape", () => {
  expect(DEFAULT_BACKOFF.maxMs).toBeGreaterThan(DEFAULT_BACKOFF.baseMs);
  expect(backoffCeil(DEFAULT_BACKOFF, 100)).toBe(DEFAULT_BACKOFF.maxMs);
});
