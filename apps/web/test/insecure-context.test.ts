import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { capabilities } from "../src/core/capabilities";
import { randomId } from "../src/core/ids";
import { sha256Hex } from "../src/core/resource-upload";

// A plain-HTTP origin has no crypto.randomUUID, no crypto.subtle and
// isSecureContext === false. Simulate that and check the fallbacks.
const saved = {
  randomUUID: Object.getOwnPropertyDescriptor(crypto, "randomUUID"),
  subtle: Object.getOwnPropertyDescriptor(crypto, "subtle"),
  secure: Object.getOwnPropertyDescriptor(globalThis, "isSecureContext"),
};

function restore(
  target: object,
  key: string,
  d: PropertyDescriptor | undefined,
) {
  if (d) Object.defineProperty(target, key, d);
  else Reflect.deleteProperty(target, key);
}

beforeEach(() => {
  for (const key of ["randomUUID", "subtle"])
    Object.defineProperty(crypto, key, {
      value: undefined,
      configurable: true,
    });
  Object.defineProperty(globalThis, "isSecureContext", {
    value: false,
    configurable: true,
  });
});

afterEach(() => {
  restore(crypto, "randomUUID", saved.randomUUID);
  restore(crypto, "subtle", saved.subtle);
  restore(globalThis, "isSecureContext", saved.secure);
});

describe("plain-HTTP fallbacks", () => {
  test("randomId gives 32 hex chars and differs per call", () => {
    const a = randomId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(randomId()).not.toBe(a);
  });

  test("sha256Hex hashes without crypto.subtle", () => {
    const input = new TextEncoder().encode("abc");
    expect(sha256Hex(input.buffer)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("capabilities reports every secure-only feature off", () => {
    expect(capabilities()).toEqual({
      secure: false,
      passkey: false,
      push: false,
    });
  });
});
