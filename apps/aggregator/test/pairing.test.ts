import { expect, test } from "bun:test";
import type {
  PairClaimRequest,
  PairHostRequest,
  PairResultRequest,
} from "@omp-remote/protocol";
import { PairingBroker, PairingBrokerError } from "../src/pairing";

/** A mutable injectable clock — tests advance time instead of sleeping. */
function clock(start = 1_000): {
  now: () => number;
  advance(ms: number): void;
} {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

const HOST: PairHostRequest = {
  machineId: "mach-1",
  rendezvousId: "rv-1",
  hostPub: "host-pub",
  hostMac: "host-mac",
};
const CLAIM: PairClaimRequest = {
  rendezvousId: "rv-1",
  phonePub: "phone-pub",
  phoneMac: "phone-mac",
};
const RESULT: PairResultRequest = { rendezvousId: "rv-1" };
const HOST_SIDE = {
  machineId: "mach-1",
  hostPub: "host-pub",
  hostMac: "host-mac",
};
/** What a claim on a pairing registered with no bearer returns. */
const CLAIMED = { response: HOST_SIDE, renews: false };

test("registerHost returns a TTL-bounded expiry", () => {
  const c = clock();
  const broker = new PairingBroker({ now: c.now, ttlMs: 300_000 });
  expect(broker.registerHost(HOST)).toEqual({ expiresAt: 301_000 });
});

test("claim on an unknown rendezvous is undefined", () => {
  const broker = new PairingBroker({ now: clock().now });
  expect(broker.claim(CLAIM)).toBeUndefined();
});

test("a fresh claim returns the host side; once its token is granted, result delivers the phone side and token once", () => {
  const broker = new PairingBroker({ now: clock().now });
  broker.registerHost(HOST);

  expect(broker.claim(CLAIM)).toEqual(CLAIMED);
  // Claimed but not yet granted its token: the host keeps polling.
  expect(broker.result(RESULT)).toEqual({ status: "pending" });
  broker.grant(RESULT.rendezvousId, "agent-tok");
  expect(broker.result(RESULT)).toEqual({
    status: "claimed",
    phonePub: "phone-pub",
    phoneMac: "phone-mac",
    agentToken: "agent-tok",
  });
  // Single-use delivery: the claimed side is dropped once handed to the host.
  expect(broker.result(RESULT)).toEqual({ status: "pending" });
});

test("a grant before any claim gives the host nothing; a dropped pairing is gone", () => {
  const broker = new PairingBroker({ now: clock().now });
  broker.registerHost(HOST);
  broker.grant(RESULT.rendezvousId, "agent-tok");
  expect(broker.result(RESULT)).toEqual({ status: "pending" });
  expect(broker.claim(CLAIM)).toEqual(CLAIMED);
  broker.drop(RESULT.rendezvousId);
  broker.grant(RESULT.rendezvousId, "agent-tok");
  expect(broker.result(RESULT)).toEqual({ status: "pending" });
  expect(broker.claim(CLAIM)).toBeUndefined();
});

test("a refused claim issues nothing, and the host's result reports the refusal exactly once", () => {
  const broker = new PairingBroker({ now: clock().now });
  broker.registerHost(HOST);
  // Refusing before any claim changes nothing.
  broker.refuse(RESULT.rendezvousId, "machine-exists");
  expect(broker.result(RESULT)).toEqual({ status: "pending" });
  expect(broker.claim(CLAIM)).toEqual(CLAIMED);
  broker.refuse(RESULT.rendezvousId, "machine-exists");
  expect(broker.result(RESULT)).toEqual({
    status: "refused",
    reason: "machine-exists",
  });
  expect(broker.result(RESULT)).toEqual({ status: "pending" });
  expect(broker.claim(CLAIM)).toBeUndefined();
});

test("result is pending until the phone claims", () => {
  const broker = new PairingBroker({ now: clock().now });
  broker.registerHost(HOST);
  expect(broker.result(RESULT)).toEqual({ status: "pending" });
});

test("a second claim after a successful one is rejected (single-use)", () => {
  const broker = new PairingBroker({ now: clock().now });
  broker.registerHost(HOST);
  expect(broker.claim(CLAIM)).toEqual(CLAIMED);
  expect(broker.claim(CLAIM)).toBeUndefined();
});

test("TTL: once now reaches expiresAt, claim and result treat the pairing as gone", () => {
  const c = clock();
  const broker = new PairingBroker({ now: c.now, ttlMs: 300_000 });
  broker.registerHost(HOST);
  c.advance(300_000); // now === expiresAt → swept (expiresAt <= now)
  expect(broker.claim(CLAIM)).toBeUndefined();
  expect(broker.result(RESULT)).toEqual({ status: "pending" });
});

test("maxPending: a new rendezvous past the cap throws, overwriting an existing one does not", () => {
  const broker = new PairingBroker({ now: clock().now, maxPending: 2 });
  broker.registerHost({ ...HOST, rendezvousId: "rv-a" });
  broker.registerHost({ ...HOST, rendezvousId: "rv-b" });
  expect(() => broker.registerHost({ ...HOST, rendezvousId: "rv-c" })).toThrow(
    PairingBrokerError,
  );
  // Re-registering a rendezvous already in the map is an overwrite, not growth.
  expect(() =>
    broker.registerHost({ ...HOST, rendezvousId: "rv-a" }),
  ).not.toThrow();
});

test("a swept-away expired entry frees a slot for a new registration", () => {
  const c = clock();
  const broker = new PairingBroker({ now: c.now, ttlMs: 1_000, maxPending: 1 });
  broker.registerHost({ ...HOST, rendezvousId: "rv-a" });
  c.advance(1_000); // rv-a is now expired and swept on the next op
  expect(() =>
    broker.registerHost({ ...HOST, rendezvousId: "rv-b" }),
  ).not.toThrow();
});

test("re-claim floods never destroy an already-claimed pairing (F2)", () => {
  const broker = new PairingBroker({ now: clock().now, maxClaimAttempts: 5 });
  broker.registerHost(HOST);
  expect(broker.claim(CLAIM)).toEqual(CLAIMED);
  // A burst of re-claims — benign phone retries after a lost 200, or a griefer —
  // must be cheap no-ops: a claimed entry is never purged before the host polls
  // the result, so an honest pairing can't be knocked out mid-delivery.
  for (let attempt = 0; attempt < 10; attempt++)
    expect(broker.claim(CLAIM)).toBeUndefined();
  // The phone side is still delivered exactly once.
  broker.grant(RESULT.rendezvousId, "agent-tok");
  expect(broker.result(RESULT)).toEqual({
    status: "claimed",
    phonePub: CLAIM.phonePub,
    phoneMac: CLAIM.phoneMac,
    agentToken: "agent-tok",
  });
});

test("a claim reports whether its host registered with the machine's token", () => {
  const broker = new PairingBroker({ now: clock().now });
  broker.registerHost(HOST, { client: "198.51.100.7", renews: true });
  expect(broker.claim(CLAIM)).toEqual({ response: HOST_SIDE, renews: true });
});

test("a client at its cap displaces its own oldest unclaimed pairing, never another client's or a claimed one", () => {
  const broker = new PairingBroker({
    now: clock().now,
    maxPending: 5,
    maxPendingPerClient: 2,
  });
  const host = (rendezvousId: string, client: string | undefined) =>
    broker.registerHost({ ...HOST, rendezvousId }, { client, renews: false });
  const claimable = (rendezvousId: string): boolean =>
    broker.claim({ ...CLAIM, rendezvousId }) !== undefined;
  host("victim", "198.51.100.7");
  host("f1", "203.0.113.9");
  expect(claimable("f1")).toBe(true); // claimed: its token awaits its host
  host("f2", "203.0.113.9");
  host("f3", "203.0.113.9"); // at the cap: displaces f2, not the claimed f1
  host("f4", "203.0.113.9"); // displaces f3
  expect(claimable("f2")).toBe(false);
  expect(claimable("f3")).toBe(false);
  expect(claimable("f4")).toBe(true);
  // f1 and f4 are both claimed now: nothing of its own left to give up.
  expect(() => host("f5", "203.0.113.9")).toThrow(PairingBrokerError);
  expect(claimable("victim")).toBe(true);
});

test("with every slot held, an addressed client takes its own oldest slot; one with none of its own, or no address, is refused", () => {
  const broker = new PairingBroker({
    now: clock().now,
    maxPending: 3,
    maxPendingPerClient: 4,
  });
  const host = (rendezvousId: string, client: string | undefined) =>
    broker.registerHost({ ...HOST, rendezvousId }, { client, renews: false });
  host("a1", "198.51.100.7");
  host("b1", "203.0.113.9");
  host("b2", "203.0.113.9");
  expect(() => host("c1", "192.0.2.1")).toThrow(PairingBrokerError);
  expect(() => host("n1", undefined)).toThrow(PairingBrokerError);
  host("b3", "203.0.113.9"); // gives up b1
  expect(broker.claim({ ...CLAIM, rendezvousId: "b1" })).toBeUndefined();
  expect(broker.claim({ ...CLAIM, rendezvousId: "a1" })).toBeDefined();
});
