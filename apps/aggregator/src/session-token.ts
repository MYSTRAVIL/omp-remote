import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * A short-lived, HMAC-signed session token issued after a successful sign-in —
 * a WebAuthn assertion or the owner's password — and required to open a
 * `/client` WS connection. It is NOT a sealed frame and carries no session
 * content — only who signed in, how, and whether a passkey login performed user
 * verification (spec §7). The aggregator is the only holder of the signing
 * secret; the token proves *who may connect*, never *what flows*.
 */
export const SessionTokenPayload = z.object({
  /**
   * Subject — for a passkey sign-in, the credential id the assertion
   * authenticated; for a password sign-in, {@link PASSWORD_SUBJECT}.
   */
  sub: z.string(),
  /**
   * Whether the login assertion performed user verification (fresh UV).
   * Always false for a password sign-in: no authenticator took part.
   */
  uv: z.boolean(),
  /** Issued-at, epoch seconds. */
  iat: z.number().int(),
  /** Expiry, epoch seconds. */
  exp: z.number().int(),
  /**
   * The gate's token epoch when this was signed (see `WebAuthnGate`). Absent on
   * tokens minted before epochs existed, which count as epoch 0.
   */
  ep: z.number().int().optional(),
  /**
   * How the session signed in: `pk` with a passkey, `pw` with the owner's
   * password. Absent on tokens minted before password sign-in existed — every
   * one of them a passkey sign-in.
   */
  m: z.enum(["pk", "pw"]).default("pk"),
});
export type SessionTokenPayload = z.infer<typeof SessionTokenPayload>;

/** The subject of every password sign-in: one owner per instance, no account ids. */
export const PASSWORD_SUBJECT = "owner";

/**
 * Sign `{ sub, uv, ep, m }` into a `<payload>.<sig>` token, both parts
 * base64url. `now` is epoch ms (injectable for tests — no wall-clock reads
 * here); `ttlSec` sets `exp`.
 */
export function signSessionToken(
  claims: { sub: string; uv: boolean; ep: number; m: SessionTokenPayload["m"] },
  secret: string,
  opts: { now: number; ttlSec: number },
): string {
  const iat = Math.floor(opts.now / 1000);
  const payload: SessionTokenPayload = {
    sub: claims.sub,
    uv: claims.uv,
    iat,
    exp: iat + opts.ttlSec,
    ep: claims.ep,
    m: claims.m,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadB64).digest();
  return `${payloadB64}.${sig.toString("base64url")}`;
}
/**
 * Verify a token against `secret` and reject it if malformed, tampered, signed
 * with a different secret, or expired at `now` (epoch ms). Returns the parsed
 * payload on success, `undefined` otherwise. Signature is checked in constant
 * time before the payload is trusted. Whether the token was since revoked (its
 * passkey removed, its epoch superseded) is the gate's call, not this one's.
 */
export function verifySessionToken(
  raw: string,
  secret: string,
  now: number,
): SessionTokenPayload | undefined {
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return undefined;
  const payloadB64 = raw.slice(0, dot);
  const sigB64 = raw.slice(dot + 1);

  let sig: Buffer;
  try {
    sig = Buffer.from(sigB64, "base64url");
  } catch {
    return undefined;
  }
  const expected = createHmac("sha256", secret).update(payloadB64).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected))
    return undefined;

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const parsed = SessionTokenPayload.safeParse(json);
  if (!parsed.success) return undefined;
  if (Math.floor(now / 1000) >= parsed.data.exp) return undefined;
  return parsed.data;
}
