import { expect, test } from "bun:test";
import { signSessionToken, verifySessionToken } from "../src/session-token";

const SECRET = "unit-test-signing-secret-0123456789";
const NOW = 1_700_000_000_000; // fixed epoch ms

test("a freshly signed token verifies and carries its claims", () => {
  const token = signSessionToken(
    { sub: "cred-1", uv: true, ep: 0, m: "pk" },
    SECRET,
    {
      now: NOW,
      ttlSec: 3600,
    },
  );
  const payload = verifySessionToken(token, SECRET, NOW);
  expect(payload).toBeDefined();
  expect(payload?.sub).toBe("cred-1");
  expect(payload?.uv).toBe(true);
  expect(payload?.exp).toBe(Math.floor(NOW / 1000) + 3600);
});

test("uv=false is preserved (a non-user-verifying login)", () => {
  const token = signSessionToken(
    { sub: "cred-1", uv: false, ep: 0, m: "pk" },
    SECRET,
    {
      now: NOW,
      ttlSec: 60,
    },
  );
  expect(verifySessionToken(token, SECRET, NOW)?.uv).toBe(false);
});

test("an expired token is rejected once now reaches exp", () => {
  const token = signSessionToken(
    { sub: "cred-1", uv: true, ep: 0, m: "pk" },
    SECRET,
    {
      now: NOW,
      ttlSec: 60,
    },
  );
  // still valid one second before exp
  expect(verifySessionToken(token, SECRET, NOW + 59_000)).toBeDefined();
  // rejected exactly at exp and after
  expect(verifySessionToken(token, SECRET, NOW + 60_000)).toBeUndefined();
  expect(verifySessionToken(token, SECRET, NOW + 120_000)).toBeUndefined();
});

test("a token signed with a different secret is rejected", () => {
  const token = signSessionToken(
    { sub: "cred-1", uv: true, ep: 0, m: "pk" },
    SECRET,
    {
      now: NOW,
      ttlSec: 3600,
    },
  );
  expect(verifySessionToken(token, `${SECRET}-other`, NOW)).toBeUndefined();
});

test("a tampered payload is rejected (signature no longer matches)", () => {
  const token = signSessionToken(
    { sub: "cred-1", uv: false, ep: 0, m: "pk" },
    SECRET,
    {
      now: NOW,
      ttlSec: 3600,
    },
  );
  const [payloadB64, sig] = token.split(".");
  // forge uv:true while keeping the old signature
  const forgedPayload = Buffer.from(
    JSON.stringify({
      sub: "cred-1",
      uv: true,
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 3600,
    }),
  ).toString("base64url");
  expect(
    verifySessionToken(`${forgedPayload}.${sig}`, SECRET, NOW),
  ).toBeUndefined();
  // sanity: the untouched token still verifies
  expect(verifySessionToken(`${payloadB64}.${sig}`, SECRET, NOW)).toBeDefined();
});

test("malformed tokens are rejected, never thrown", () => {
  for (const bad of ["", ".", "abc", "a.b.c", ".sig", "payload.", "!!!.###"]) {
    expect(verifySessionToken(bad, SECRET, NOW)).toBeUndefined();
  }
});
