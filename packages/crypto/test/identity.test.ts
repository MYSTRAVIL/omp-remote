import { expect, test } from "bun:test";
import { b64u, newIdentity, unb64u } from "../src/index";

test("newIdentity produces distinct 32-byte keys", async () => {
  const a = await newIdentity();
  const b = await newIdentity();
  expect(unb64u(a.publicKey).length).toBe(32);
  expect(unb64u(a.secretKey).length).toBe(32);
  expect(a.publicKey).not.toBe(b.publicKey);
});

test("b64u round-trips", () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  expect([...unb64u(b64u(bytes))]).toEqual([...bytes]);
});

test("b64u matches Node base64url exactly (interoperability with stored pairing keys)", () => {
  // Reference outputs: Buffer.from(bytes).toString("base64url") — covers every
  // padding class and both non-alphanumeric alphabet characters.
  expect(b64u(new Uint8Array([0, 1, 2, 253, 254, 255]))).toBe("AAEC_f7_");
  expect(b64u(new Uint8Array([251, 255, 191]))).toBe("-_-_");
  expect(b64u(new Uint8Array([100]))).toBe("ZA");
  expect(b64u(new Uint8Array([100, 101]))).toBe("ZGU");
  expect(b64u(new Uint8Array([0, 0, 0]))).toBe("AAAA");
});
