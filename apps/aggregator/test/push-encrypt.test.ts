import { expect, test } from "bun:test";
import { MAX_PUSH_PLAINTEXT, encryptPushPayload } from "../src/push-encrypt";
import {
  decryptPushBody,
  importEcdhPair,
  makeSubscriber,
  parseHeader,
} from "./helpers/webpush-receiver";

const b64u = (s: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(s.replace(/\s+/g, ""), "base64url"));

/** RFC 8291 §5 / Appendix A. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

test("with the RFC 8291 Appendix A salt and sender key, the body is the RFC's byte for byte", async () => {
  const body = await encryptPushPayload(
    new TextEncoder().encode(RFC.plaintext),
    { p256dh: RFC.uaPublic, auth: RFC.auth },
    {
      salt: b64u(RFC.salt),
      senderKeys: await importEcdhPair(RFC.asPublic, RFC.asPrivate),
    },
  );
  expect(Buffer.from(body).toString("base64url")).toBe(
    RFC.body.replace(/\s+/g, ""),
  );
});

test("the test receiver opens the RFC 8291 example as the user agent", async () => {
  const plain = await decryptPushBody(
    b64u(RFC.body),
    await importEcdhPair(RFC.uaPublic, RFC.uaPrivate),
    b64u(RFC.auth),
  );
  expect(new TextDecoder().decode(plain)).toBe(RFC.plaintext);
});

test("a subscriber recovers the exact payload bytes; each message has a fresh salt and sender key", async () => {
  const sub = await makeSubscriber();
  const notice = new TextEncoder().encode(
    JSON.stringify({ v: 1, m: "machine-1", n: "aXY", ct: "Y2lwaGVy" }),
  );
  const a = await encryptPushPayload(notice, sub.keys);
  const b = await encryptPushPayload(notice, sub.keys);

  expect(await decryptPushBody(a, sub.pair, sub.auth)).toEqual(notice);
  expect(await decryptPushBody(b, sub.pair, sub.auth)).toEqual(notice);

  const ha = parseHeader(a);
  const hb = parseHeader(b);
  expect(ha.rs).toBe(4096);
  expect(ha.keyid).toHaveLength(65);
  expect(ha.keyid[0]).toBe(0x04);
  // header(86) + payload + delimiter(1) + tag(16): one record, no padding.
  expect(a).toHaveLength(86 + notice.length + 1 + 16);
  expect(ha.salt).not.toEqual(hb.salt);
  expect(ha.keyid).not.toEqual(hb.keyid);
});

test("a body for one subscriber does not open for another", async () => {
  const alice = await makeSubscriber();
  const bob = await makeSubscriber();
  const body = await encryptPushPayload(Uint8Array.of(1, 2, 3), alice.keys);
  await expect(decryptPushBody(body, bob.pair, bob.auth)).rejects.toThrow();
  await expect(decryptPushBody(body, alice.pair, bob.auth)).rejects.toThrow();
});

test("the largest single-record plaintext fits a 4096-octet body; one more octet is refused", async () => {
  const sub = await makeSubscriber();
  const max = new Uint8Array(MAX_PUSH_PLAINTEXT).fill(0x61);
  const body = await encryptPushPayload(max, sub.keys);
  expect(body).toHaveLength(4096);
  expect(await decryptPushBody(body, sub.pair, sub.auth)).toEqual(max);
  await expect(
    encryptPushPayload(new Uint8Array(MAX_PUSH_PLAINTEXT + 1), sub.keys),
  ).rejects.toThrow(/limit/);
});

test("malformed subscription keys are refused, not encrypted to", async () => {
  const sub = await makeSubscriber();
  const payload = Uint8Array.of(1);
  await expect(
    encryptPushPayload(payload, { ...sub.keys, p256dh: "cGtleQ" }),
  ).rejects.toThrow(/p256dh/);
  await expect(
    encryptPushPayload(payload, { ...sub.keys, auth: "YXV0aA" }),
  ).rejects.toThrow(/auth/);
  // Right length and prefix, but not a point on P-256.
  const offCurve = Buffer.concat([
    Buffer.from([4]),
    Buffer.alloc(64, 1),
  ]).toString("base64url");
  await expect(
    encryptPushPayload(payload, { ...sub.keys, p256dh: offCurve }),
  ).rejects.toThrow();
});
