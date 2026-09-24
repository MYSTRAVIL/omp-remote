import { expect, test } from "bun:test";
import {
  PairClaimRequest,
  PairClaimResponse,
  PairHostRequest,
  PairHostResponse,
  PairResultRequest,
  PairResultResponse,
} from "../src/pairing";

/** A 32-byte value as the ceremony sends it: 43 base64url characters. */
const B32 = (c: string): string => c.repeat(43);

test("PairHostRequest accepts a full body and round-trips", () => {
  const body = {
    machineId: "machine-a",
    rendezvousId: B32("r"),
    hostPub: B32("H"),
    hostMac: B32("m"),
  };
  expect(PairHostRequest.parse(body)).toEqual(body);
});

test("PairHostRequest rejects an empty required field", () => {
  expect(
    PairHostRequest.safeParse({
      machineId: "",
      rendezvousId: B32("r"),
      hostPub: B32("p"),
      hostMac: B32("m"),
    }).success,
  ).toBe(false);
});

test("the pairing requests accept only 32-byte base64url values", () => {
  const host = {
    machineId: "m",
    rendezvousId: B32("r"),
    hostPub: B32("p"),
    hostMac: B32("m"),
  };
  for (const field of ["rendezvousId", "hostPub", "hostMac"] as const) {
    for (const bad of ["r".repeat(42), "r".repeat(44), `${"r".repeat(42)}=`])
      expect(PairHostRequest.safeParse({ ...host, [field]: bad }).success).toBe(
        false,
      );
  }
  const claim = {
    rendezvousId: B32("r"),
    phonePub: B32("P"),
    phoneMac: B32("M"),
  };
  expect(PairClaimRequest.safeParse(claim).success).toBe(true);
  for (const field of ["rendezvousId", "phonePub", "phoneMac"] as const)
    expect(
      PairClaimRequest.safeParse({ ...claim, [field]: "x".repeat(1 << 16) })
        .success,
    ).toBe(false);
  expect(PairResultRequest.safeParse({ rendezvousId: B32("_") }).success).toBe(
    true,
  );
  expect(PairResultRequest.safeParse({ rendezvousId: "r+/" }).success).toBe(
    false,
  );
});

test("PairHostResponse requires an integer expiry", () => {
  expect(
    PairHostResponse.safeParse({ expiresAt: 1_700_000_000_000 }).success,
  ).toBe(true);
  expect(PairHostResponse.safeParse({ expiresAt: 1.5 }).success).toBe(false);
});

test("PairClaimRequest and its response validate the exchanged public keys", () => {
  expect(
    PairClaimRequest.parse({
      rendezvousId: B32("r"),
      phonePub: B32("P"),
      phoneMac: B32("M"),
    }).phonePub,
  ).toBe(B32("P"));
  expect(
    PairClaimResponse.parse({
      machineId: "m",
      hostPub: "HPUB",
      hostMac: "HMAC",
    }).hostPub,
  ).toBe("HPUB");
});

test("PairResultResponse is a discriminated union on status", () => {
  expect(PairResultResponse.parse({ status: "pending" }).status).toBe(
    "pending",
  );
  const claimed = PairResultResponse.parse({
    status: "claimed",
    phonePub: "PPUB",
    phoneMac: "PMAC",
    agentToken: "TOK",
  });
  expect(claimed.status === "claimed" && claimed.agentToken).toBe("TOK");
  // A claim without the machine token is not a result the host can use.
  expect(
    PairResultResponse.safeParse({
      status: "claimed",
      phonePub: "PPUB",
      phoneMac: "PMAC",
    }).success,
  ).toBe(false);
});

test("PairResultResponse rejects a claimed status missing the phone side", () => {
  expect(
    PairResultResponse.safeParse({ status: "claimed", phonePub: "P" }).success,
  ).toBe(false);
});

test("PairResultResponse carries a refusal and its reason, and only a known reason", () => {
  expect(
    PairResultResponse.parse({ status: "refused", reason: "machine-exists" }),
  ).toEqual({ status: "refused", reason: "machine-exists" });
  expect(
    PairResultResponse.safeParse({ status: "refused", reason: "nope" }).success,
  ).toBe(false);
  expect(PairResultResponse.safeParse({ status: "refused" }).success).toBe(
    false,
  );
});
