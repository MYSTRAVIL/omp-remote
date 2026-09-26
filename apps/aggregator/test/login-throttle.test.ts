import { expect, test } from "bun:test";
import { LoginThrottle } from "../src/login-throttle";

const T0 = 1_700_000_000_000;

function failTimes(
  t: LoginThrottle,
  key: string | undefined,
  n: number,
  at = T0,
): void {
  for (let i = 0; i < n; i++) t.fail(key, at);
}

test("the first five failures cost nothing", () => {
  const t = new LoginThrottle();
  failTimes(t, "k", 5);
  expect(t.check("k", T0)).toEqual({ ok: true });
});

test("each failure past five doubles the lock: 1, 2, 4 … s", () => {
  const t = new LoginThrottle();
  failTimes(t, "k", 5);
  const locks: number[] = [];
  for (let i = 0; i < 4; i++) {
    t.fail("k", T0);
    const r = t.check("k", T0);
    if (r.ok) throw new Error("expected a lock");
    locks.push(r.retryAfterSec);
  }
  expect(locks).toEqual([1, 2, 4, 8]);
});

test("the lock runs from the last failure and then lifts", () => {
  const t = new LoginThrottle();
  failTimes(t, "k", 7); // 2 s lock
  expect(t.check("k", T0 + 1_500)).toEqual({ ok: false, retryAfterSec: 1 });
  expect(t.check("k", T0 + 2_000)).toEqual({ ok: true });
});

test("the lock is capped at maxDelaySec", () => {
  const t = new LoginThrottle();
  failTimes(t, "k", 40);
  expect(t.check("k", T0)).toEqual({ ok: false, retryAfterSec: 900 });
});

test("a success clears the key", () => {
  const t = new LoginThrottle();
  failTimes(t, "k", 6);
  t.succeed("k");
  expect(t.check("k", T0)).toEqual({ ok: true });
});

test("keys are independent", () => {
  const t = new LoginThrottle();
  failTimes(t, "a", 6);
  expect(t.check("a", T0).ok).toBe(false);
  expect(t.check("b", T0).ok).toBe(true);
});

test("past maxKeys the least recently failed key not locked out is dropped", () => {
  const t = new LoginThrottle({ maxKeys: 2, globalFreeFailures: 1_000 });
  failTimes(t, "locked", 6);
  failTimes(t, "recent", 5); // one short of a lock
  t.fail("new", T0); // "locked" failed longest ago, but "recent" goes
  expect(t.check("locked", T0).ok).toBe(false);
  t.fail("recent", T0); // evicts "new"; "recent" starts over at one
  expect(t.check("recent", T0).ok).toBe(true);
});

test("a locked-out key is never dropped; with every key locked, new keys share one overflow lock", () => {
  const t = new LoginThrottle({ maxKeys: 2 });
  failTimes(t, "a", 6);
  failTimes(t, "b", 6);
  // Both kept keys are locked: a newcomer cannot push either out.
  t.fail("c", T0);
  expect(t.check("a", T0).ok).toBe(false);
  expect(t.check("b", T0).ok).toBe(false);
  // Newcomers' failures pile onto one shared key, however many addresses.
  for (const key of ["d", "e", "f", "g", "h"]) t.fail(key, T0);
  expect(t.check("fresh", T0)).toEqual({ ok: false, retryAfterSec: 1 });
  // Once a kept key's lock lapses it is the one dropped, and the newcomer kept.
  const later = T0 + 2_000;
  t.fail("i", later);
  expect(t.check("a", later).ok).toBe(true);
  expect(t.check("b", later).ok).toBe(true);
});

test("every failure counts against a global budget that locks every key", () => {
  const t = new LoginThrottle({ globalFreeFailures: 20 });
  // Twenty keys, one failure each: no key is over its own five.
  for (let i = 0; i < 20; i++) t.fail(`k${i}`, T0);
  expect(t.check("anyone", T0)).toEqual({ ok: true });
  t.fail("k20", T0);
  expect(t.check("anyone", T0)).toEqual({ ok: false, retryAfterSec: 30 });
  // The owner's success clears it.
  t.fail("k21", T0);
  t.succeed("owner");
  expect(t.check("anyone", T0)).toEqual({ ok: true });
});

test("the global budget drains one failure per 30 s: a burst locks everyone for seconds, and it lifts with no success", () => {
  const t = new LoginThrottle();
  for (let i = 0; i < 22; i++) t.fail(`k${i}`, T0);
  expect(t.check("owner", T0)).toEqual({ ok: false, retryAfterSec: 60 });
  expect(t.check("owner", T0 + 30_000)).toEqual({
    ok: false,
    retryAfterSec: 30,
  });
  expect(t.check("owner", T0 + 60_000)).toEqual({ ok: true });
});

test("one client failing whenever it may, all day, never locks another client out", () => {
  const t = new LoginThrottle();
  let ownerLocked = 0;
  for (let s = 0; s < 86_400; s++) {
    const now = T0 + s * 1_000;
    if (t.check("attacker", now).ok) t.fail("attacker", now);
    if (!t.check("owner", now).ok) ownerLocked += 1;
  }
  expect(t.check("attacker", T0 + 86_400_000).ok).toBe(false);
  expect(ownerLocked).toBe(0);
});

test("tries with no client key count only against the global budget, which drains", () => {
  const t = new LoginThrottle();
  failTimes(t, undefined, 20);
  expect(t.check(undefined, T0)).toEqual({ ok: true });
  t.fail(undefined, T0);
  expect(t.check(undefined, T0)).toEqual({ ok: false, retryAfterSec: 30 });
  expect(t.check("198.51.100.7", T0).ok).toBe(false);
  expect(t.check(undefined, T0 + 30_000)).toEqual({ ok: true });
});
