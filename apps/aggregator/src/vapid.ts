import { z } from "zod";
import { encryptPushPayload } from "./push-encrypt";

/**
 * VAPID (RFC 8292) application-server keys. `publicKey` is the base64url
 * uncompressed P-256 point (`0x04 ‖ x ‖ y`, the value a browser passes as
 * `applicationServerKey`); `privateKey` is the base64url 32-byte scalar `d`.
 * `subject` is a `mailto:`/`https:` contact the push service can reach. These
 * are the app-server identity ONLY — they seal nothing and never touch session
 * content.
 */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * A browser Push API subscription, as the store holds it and the sender reads
 * it. Deliberately lenient: a device registering a NEW one must also pass
 * {@link NewPushSubscription}, which is never applied to stored ones.
 * `keys.p256dh`/`auth` are the subscription's RFC 8291 payload-encryption
 * material: a push carrying a notice is encrypted to them. That payload is the
 * agent's sealed notice, opaque to the aggregator — these keys protect it only
 * from the push service, never from us, and never expose session content.
 */
export const PushSubscription = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
export type PushSubscription = z.infer<typeof PushSubscription>;

/** Real endpoints run to a few hundred characters; 2048, the de facto URL limit, leaves ample room. */
export const MAX_PUSH_ENDPOINT_LENGTH = 2048;
/** `p256dh` is 87 base64url characters and `auth` 22, so 256 fits any encoding of either. */
export const MAX_PUSH_KEY_LENGTH = 256;

/** The one push service a new endpoint may name as its whole host: FCM, which Chrome uses. */
const FCM_HOST = "fcm.googleapis.com";
/**
 * Push-service domains a new subscription's endpoint may name a subdomain of:
 * Mozilla autopush, Apple, and WNS (Edge on Windows).
 */
const PUSH_SERVICE_DOMAINS = [
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
] as const;
/**
 * What a subdomain puts before its domain: one or more non-empty DNS labels,
 * each ending in the dot that marks the domain's boundary.
 */
const SUBDOMAIN_LABELS = /^(?:[a-z0-9-]+\.)+$/;

/**
 * Whether a NEW subscription may register `endpoint`: an `https:` URL of at
 * most {@link MAX_PUSH_ENDPOINT_LENGTH} characters, with no userinfo and the
 * default port, whose host is exactly `fcm.googleapis.com` or a subdomain of
 * `push.services.mozilla.com`, `push.apple.com`, or `notify.windows.com`. The
 * relay POSTs to every stored endpoint, so this keeps an enrolling device from
 * aiming it anywhere but a browser push service. Legacy GCM's
 * `android.googleapis.com` is left out: Chrome stopped issuing it in version
 * 74, and a subscription made with a VAPID key, as the PWA's always are, gets
 * an FCM endpoint. Stored subscriptions are never re-checked.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) return false;
  const url = URL.parse(endpoint);
  if (url === null || url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "" || url.port !== "")
    return false;
  // The URL parser has lowercased the host (and turned an IDN into punycode).
  const host = url.hostname;
  if (host === FCM_HOST) return true;
  return PUSH_SERVICE_DOMAINS.some(
    (domain) =>
      host.endsWith(domain) &&
      SUBDOMAIN_LABELS.test(host.slice(0, -domain.length)),
  );
}

/**
 * A subscription as a device may NEWLY register it: {@link PushSubscription}
 * with an endpoint {@link isAllowedPushEndpoint} accepts and keys of at most
 * {@link MAX_PUSH_KEY_LENGTH} characters. Only the subscribe route parses with
 * it; the store and the sender keep the lenient shape, so a subscription stored
 * before the allowlist still loads and is still pushed to.
 */
export const NewPushSubscription = z.object({
  endpoint: z.string().refine(isAllowedPushEndpoint),
  keys: z.object({
    p256dh: z.string().max(MAX_PUSH_KEY_LENGTH),
    auth: z.string().max(MAX_PUSH_KEY_LENGTH),
  }),
});

/** VAPID JWT lifetime (RFC 8292 caps `exp` at 24h from issuance). */
const VAPID_JWT_TTL_SEC = 12 * 60 * 60;
/**
 * Push message time-to-live handed to the push service, in seconds. An hour
 * lets a phone that was briefly offline still receive the notice, and the
 * clear that follows it once the session is answered.
 */
const PUSH_TTL_SEC = 60 * 60;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Import the VAPID private scalar as a WebCrypto ECDSA P-256 signing key. The
 * public point supplies `x`/`y`; the private key supplies `d`. Kept out of the
 * hot path by callers that reuse the returned key.
 */
async function importSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const point = Buffer.from(keys.publicKey, "base64url");
  if (point.length !== 65 || point[0] !== 0x04)
    throw new Error(
      "VAPID public key must be a 65-byte uncompressed P-256 point",
    );
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * Mint a fresh VAPID key pair for `subject`: a P-256 point and scalar encoded
 * as {@link VapidKeys} describes, the form {@link buildVapidHeader} signs with.
 */
export async function generateVapidKeys(subject: string): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const point = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (d === undefined) throw new Error("generated VAPID key has no scalar");
  return { publicKey: b64url(point), privateKey: d, subject };
}

/**
 * Build the VAPID `Authorization` header value for a push to `audience` (the
 * push service origin). Signs an ES256 JWT `{aud,exp,sub}` with the app-server
 * private key; the signature is raw 64-byte `R‖S` (JOSE), NOT DER. Returns
 * `vapid t=<jwt>, k=<publicKey>`.
 */
export async function buildVapidHeader(
  keys: VapidKeys,
  audience: string,
  nowMs: number,
  signingKey?: CryptoKey,
): Promise<string> {
  const key = signingKey ?? (await importSigningKey(keys));
  const header = b64url(
    enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const claims = b64url(
    enc.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(nowMs / 1000) + VAPID_JWT_TTL_SEC,
        sub: keys.subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      enc.encode(signingInput),
    ),
  );
  return `vapid t=${signingInput}.${b64url(sig)}, k=${keys.publicKey}`;
}

/** A ready-to-send Web Push HTTP request. */
export interface PushRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  /**
   * `undefined` for a payloadless push; otherwise the RFC 8291 `aes128gcm`
   * body wrapping the agent's sealed notice, which the aggregator cannot read.
   */
  body: Uint8Array<ArrayBuffer> | undefined;
}

/**
 * Build the Web Push request for one subscription. The headers are VAPID auth +
 * `TTL` — no session identity, title or prompt text. Without `payload` the body
 * is EMPTY (a bare wake-up). With `payload` — the agent's sealed notice
 * envelope, opaque bytes the aggregator holds no key for — the body is those
 * bytes RFC 8291-encrypted to the subscription (plus `Content-Encoding:
 * aes128gcm`), so only the phone's service worker can unwrap and then open it.
 */
export async function buildPushRequest(
  sub: PushSubscription,
  keys: VapidKeys,
  nowMs: number,
  signingKey?: CryptoKey,
  payload?: Uint8Array,
): Promise<PushRequest> {
  const audience = new URL(sub.endpoint).origin;
  const authorization = await buildVapidHeader(
    keys,
    audience,
    nowMs,
    signingKey,
  );
  // `Urgency: high` asks the push service to deliver through Android doze:
  // every push here is something the user is waiting to see or dismiss.
  const headers: Record<string, string> = {
    Authorization: authorization,
    TTL: String(PUSH_TTL_SEC),
    Urgency: "high",
  };
  if (payload === undefined)
    return { url: sub.endpoint, method: "POST", headers, body: undefined };
  const body = await encryptPushPayload(payload, sub.keys);
  headers["Content-Encoding"] = "aes128gcm";
  headers["Content-Type"] = "application/octet-stream";
  return { url: sub.endpoint, method: "POST", headers, body };
}

export { importSigningKey };
