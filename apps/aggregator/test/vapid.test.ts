import { expect, test } from "bun:test";
import {
  MAX_PUSH_ENDPOINT_LENGTH,
  MAX_PUSH_KEY_LENGTH,
  NewPushSubscription,
  type VapidKeys,
  buildPushRequest,
  buildVapidHeader,
  generateVapidKeys,
  isAllowedPushEndpoint,
} from "../src/vapid";
import { decryptPushBody, makeSubscriber } from "./helpers/webpush-receiver";

/** Generate a web-push-style VAPID keypair for the test run. */
async function makeKeys(): Promise<{ keys: VapidKeys; verifyKey: CryptoKey }> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const x = Buffer.from(pub.x ?? "", "base64url");
  const y = Buffer.from(pub.y ?? "", "base64url");
  const point = Buffer.concat([Buffer.from([4]), x, y]);
  return {
    keys: {
      publicKey: point.toString("base64url"),
      privateKey: priv.d ?? "",
      subject: "mailto:me@example.com",
    },
    verifyKey: kp.publicKey,
  };
}

const NOW = 1_700_000_000_000;
const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "cGtleQ", auth: "YXV0aA" },
};

test("buildVapidHeader signs a verifiable ES256 JWT with a raw R‖S signature", async () => {
  const { keys, verifyKey } = await makeKeys();
  const header = await buildVapidHeader(
    keys,
    "https://fcm.googleapis.com",
    NOW,
  );

  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  expect(match).not.toBeNull();
  if (!match) return;
  const [, jwt = "", k = ""] = match;
  expect(k).toBe(keys.publicKey);

  const [h = "", c = "", s = ""] = jwt.split(".");
  expect(jwt.split(".")).toHaveLength(3);
  const decodedHeader = JSON.parse(Buffer.from(h, "base64url").toString());
  expect(decodedHeader).toEqual({ typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  expect(claims.aud).toBe("https://fcm.googleapis.com");
  expect(claims.sub).toBe("mailto:me@example.com");
  // exp is in seconds and within 24h of issuance (RFC 8292)
  expect(claims.exp).toBeGreaterThan(Math.floor(NOW / 1000));
  expect(claims.exp).toBeLessThanOrEqual(Math.floor(NOW / 1000) + 86_400);

  const sig = new Uint8Array(Buffer.from(s, "base64url"));
  expect(sig.length).toBe(64); // JOSE raw R‖S, never DER
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyKey,
    sig,
    new TextEncoder().encode(`${h}.${c}`),
  );
  expect(ok).toBe(true);
});

test("a generated key pair signs a VAPID header its own public key verifies", async () => {
  const keys = await generateVapidKeys("mailto:owner@example.com");
  expect(keys.subject).toBe("mailto:owner@example.com");
  const point = Buffer.from(keys.publicKey, "base64url");
  expect(point).toHaveLength(65);
  expect(point[0]).toBe(0x04);
  expect(Buffer.from(keys.privateKey, "base64url")).toHaveLength(32);

  const header = await buildVapidHeader(
    keys,
    "https://fcm.googleapis.com",
    NOW,
  );
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  if (!match) throw new Error(`unexpected header: ${header}`);
  const [, jwt = "", k = ""] = match;
  expect(k).toBe(keys.publicKey);
  const [h = "", c = "", s = ""] = jwt.split(".");
  const verifyKey = await crypto.subtle.importKey(
    "raw",
    point,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyKey,
    Buffer.from(s, "base64url"),
    new TextEncoder().encode(`${h}.${c}`),
  );
  expect(ok).toBe(true);
});

test("the audience is the push-service origin only, never the full endpoint", async () => {
  const { keys } = await makeKeys();
  const header = await buildVapidHeader(
    keys,
    new URL(SUB.endpoint).origin,
    NOW,
  );
  const jwt = /t=([^,]+),/.exec(header)?.[1] ?? "";
  const claims = JSON.parse(
    Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString(),
  );
  expect(claims.aud).toBe("https://fcm.googleapis.com");
  expect(claims.aud).not.toContain("abc123");
});

test("buildPushRequest without a payload is payloadless and leaks NO session content", async () => {
  const { keys } = await makeKeys();
  const req = await buildPushRequest(SUB, keys, NOW);

  expect(req.method).toBe("POST");
  expect(req.url).toBe(SUB.endpoint);
  // The whole point: an empty body, no content-carrying headers.
  expect(req.body).toBeUndefined();
  expect(req.headers.Authorization?.startsWith("vapid t=")).toBe(true);
  expect(req.headers.TTL).toBe("3600");
  expect(Object.keys(req.headers).sort()).toEqual([
    "Authorization",
    "TTL",
    "Urgency",
  ]);

  // No frame plaintext could exist here, but assert nothing session-shaped did
  // leak into the wire: scan the entire serialized request for forbidden tokens.
  const wire = JSON.stringify(req);
  for (const forbidden of [
    "sessionId",
    "session",
    "title",
    "prompt",
    "idle",
    "approval",
  ])
    expect(wire.includes(forbidden)).toBe(false);
});

test("buildPushRequest with a payload sends it aes128gcm-encrypted to the subscription", async () => {
  const { keys } = await makeKeys();
  const device = await makeSubscriber();
  const sub = { endpoint: SUB.endpoint, keys: device.keys };
  const payload = new TextEncoder().encode('{"v":1,"m":"m1","n":"x","ct":"y"}');
  const req = await buildPushRequest(sub, keys, NOW, undefined, payload);

  expect(Object.keys(req.headers).sort()).toEqual([
    "Authorization",
    "Content-Encoding",
    "Content-Type",
    "TTL",
    "Urgency",
  ]);
  expect(req.headers["Content-Encoding"]).toBe("aes128gcm");
  expect(req.headers["Content-Type"]).toBe("application/octet-stream");
  if (req.body === undefined) throw new Error("expected an encrypted body");
  expect(await decryptPushBody(req.body, device.pair, device.auth)).toEqual(
    payload,
  );
});

test("a malformed VAPID public key is rejected, not silently mis-signed", async () => {
  const bad: VapidKeys = {
    publicKey: Buffer.from("too-short").toString("base64url"),
    privateKey: "AAAA",
    subject: "mailto:me@example.com",
  };
  await expect(
    buildVapidHeader(bad, "https://fcm.googleapis.com", NOW),
  ).rejects.toThrow(/65-byte/);
});

test("isAllowedPushEndpoint accepts the endpoints FCM, Mozilla, Apple and WNS issue", () => {
  const issued = [
    "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ-hQMRKRrZuJAEcl7B338qju59zJMjw2DELjzEvxwYv7hH5Ynpc1ODQ0aT4U4OFEeco8ohsN5PjL1iC2dNtk2BAokeMCg2ZXKqpc8FXKmhX94kIxQ",
    "https://fcm.googleapis.com/wp/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABmT1nKzXqf2Hl8y0sJp9vQ3dR4mB7cE6aF1uW5tY8iO0pL2kN3jH4gG5fD6sA7",
    "https://web.push.apple.com/QGuQyavXutnMH_Sd9yJ3Lks3zj0Py1bvS0dhdR8f9oeeJyomUAbbfCkXJNgJBqMp5K8pPo6hX0BaN_hk2xDMr6lwFRCAiQ9d24lmIaUfVi-_wGsSyVuK7cYPd9TsPH6f",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAC9U2dGmBG8ZqsPHnN0V8yvMcJ5k%2bpNGKcW3AAAAB3nrXJ5o%2fE",
    // Scheme and host compare case-insensitively; :443 is the default port.
    "HTTPS://FCM.GoogleAPIs.com/fcm/send/abc",
    "https://web.push.apple.com:443/abc",
  ];
  expect(issued.filter((e) => !isAllowedPushEndpoint(e))).toEqual([]);
});

test("isAllowedPushEndpoint refuses anything but https on a push service's default port without userinfo", () => {
  const refused = [
    "http://fcm.googleapis.com/fcm/send/abc",
    "wss://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://attacker.example/fcm/send/abc",
    // Legacy GCM: Chrome stopped issuing it in version 74.
    "https://android.googleapis.com/gcm/send/abc",
    "https://142.250.180.10/fcm/send/abc",
    "https://[2a00:1450:4001::200a]/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://updates.push.services.mozilla.com:444/wpush/v2/abc",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "https://user@web.push.apple.com/abc",
    "https://:pass@web.push.apple.com/abc",
    // The real host here is attacker.example; the allowlisted name is userinfo.
    "https://web.push.apple.com@attacker.example/abc",
    "not a url",
    "",
  ];
  expect(refused.filter(isAllowedPushEndpoint)).toEqual([]);
});

test("isAllowedPushEndpoint matches a push-service domain only on a label boundary", () => {
  const refused = [
    "https://fcm.googleapis.com.attacker.net/fcm/send/abc",
    "https://sub.fcm.googleapis.com/fcm/send/abc",
    "https://evilfcm.googleapis.com/fcm/send/abc",
    "https://evilpush.apple.com.attacker.net/abc",
    "https://notify.windows.com.evil/w/?token=abc",
    "https://xpush.apple.com/abc",
    "https://attackerpush.services.mozilla.com/wpush/v2/abc",
    "https://evil-notify.windows.com/w/?token=abc",
    // The domain itself, or an empty label before it, is not a subdomain.
    "https://push.apple.com/abc",
    "https://.push.apple.com/abc",
    "https://a..notify.windows.com/w/?token=abc",
  ];
  expect(refused.filter(isAllowedPushEndpoint)).toEqual([]);
  expect(
    isAllowedPushEndpoint("https://db5p.notify.windows.com/w/?token=abc"),
  ).toBe(true);
});

test("isAllowedPushEndpoint caps the endpoint at MAX_PUSH_ENDPOINT_LENGTH characters", () => {
  const base = "https://fcm.googleapis.com/fcm/send/";
  const atCap = base + "a".repeat(MAX_PUSH_ENDPOINT_LENGTH - base.length);
  expect(atCap).toHaveLength(MAX_PUSH_ENDPOINT_LENGTH);
  expect(isAllowedPushEndpoint(atCap)).toBe(true);
  expect(isAllowedPushEndpoint(`${atCap}a`)).toBe(false);
});

test("a new subscription's keys are capped at MAX_PUSH_KEY_LENGTH characters", () => {
  const atCap = "A".repeat(MAX_PUSH_KEY_LENGTH);
  const over = `${atCap}A`;
  const sub = (p256dh: string, auth: string) => ({
    endpoint: SUB.endpoint,
    keys: { p256dh, auth },
  });
  expect(NewPushSubscription.safeParse(sub(atCap, atCap)).success).toBe(true);
  expect(NewPushSubscription.safeParse(sub(over, "YXV0aA")).success).toBe(
    false,
  );
  expect(NewPushSubscription.safeParse(sub("cGtleQ", over)).success).toBe(
    false,
  );
  // The endpoint allowlist applies to the whole subscription too.
  expect(
    NewPushSubscription.safeParse({
      ...SUB,
      endpoint: "https://attacker.example/push",
    }).success,
  ).toBe(false);
});
