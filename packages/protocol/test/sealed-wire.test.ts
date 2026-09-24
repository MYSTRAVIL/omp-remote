import { expect, test } from "bun:test";
import { SealedWireEnvelope } from "../src/sealed-wire";

test("the v2 envelope refuses v1 envelopes, unknown kinds and non-counter values", () => {
  const data = {
    route: "m1",
    k: "d",
    e: "epoch",
    c: 3,
    a: "peer",
    n: "nonce",
    ct: "sealed",
  };
  expect(SealedWireEnvelope.safeParse(data).success).toBe(true);
  // v1 carried no epoch or counter. Agent and web roll together: no legacy path.
  expect(
    SealedWireEnvelope.safeParse({ route: "m1", n: "nonce", ct: "sealed" })
      .success,
  ).toBe(false);
  expect(SealedWireEnvelope.safeParse({ ...data, k: "x" }).success).toBe(false);
  for (const c of [-1, 1.5, 2 ** 53, "3"])
    expect(SealedWireEnvelope.safeParse({ ...data, c }).success).toBe(false);
});
