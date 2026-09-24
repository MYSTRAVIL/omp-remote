/**
 * Web Push message encryption (RFC 8291) in the `aes128gcm` content coding
 * (RFC 8188), WebCrypto only. The aggregator runs this over bytes it cannot
 * read — the agent's sealed notice envelope — purely so the push service will
 * carry them: RFC 8291 is the push-service transport, not the confidentiality
 * boundary (that is the phone↔agent seal inside the payload).
 */

/** Record size written into the header; one record always fits (see {@link MAX_PUSH_PLAINTEXT}). */
const RECORD_SIZE = 4096;
/** `salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid(65)`. */
const HEADER_LENGTH = 86;
/** AEAD_AES_128_GCM expansion. */
const TAG_LENGTH = 16;
/**
 * The largest plaintext a push may carry: push services need only accept a
 * 4096-octet body (RFC 8030 §7.2), less the header, the 0x02 padding delimiter
 * and the tag (RFC 8291 §4).
 */
export const MAX_PUSH_PLAINTEXT = RECORD_SIZE - HEADER_LENGTH - 1 - TAG_LENGTH;

/**
 * Fixed inputs that are random in production. ONLY for reproducing the RFC 8291
 * Appendix A vector — reusing a salt or sender key across messages is unsafe.
 */
export interface PushEncryptionSeam {
  /** 16-octet salt. */
  salt: Uint8Array<ArrayBuffer>;
  /** Sender (application-server) ECDH P-256 key pair; the public key must be extractable. */
  senderKeys: CryptoKeyPair;
}

const enc = new TextEncoder();
const KEY_INFO_LABEL = enc.encode("WebPush: info\0");
const CEK_INFO = enc.encode("Content-Encoding: aes128gcm\0");
const NONCE_INFO = enc.encode("Content-Encoding: nonce\0");

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** HKDF-SHA-256 (extract + expand) of `ikm` into `bytes` octets. */
async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      bytes * 8,
    ),
  );
}

/**
 * Encrypt `plaintext` for one subscription as a single `aes128gcm` record:
 * a fresh ephemeral P-256 key and random salt per call, ECDH with the
 * subscription's `p256dh`, HKDF with its `auth` secret exactly as RFC 8291 §3.4,
 * padding delimiter 0x02 and no padding. Returns the whole request body —
 * `salt ‖ rs=4096 ‖ idlen=65 ‖ senderPublicKey ‖ ciphertext`. Throws on a
 * malformed/off-curve `p256dh`, an `auth` that is not 16 octets, or a
 * plaintext over {@link MAX_PUSH_PLAINTEXT}.
 */
export async function encryptPushPayload(
  plaintext: Uint8Array,
  keys: { p256dh: string; auth: string },
  seam?: PushEncryptionSeam,
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PUSH_PLAINTEXT)
    throw new Error(
      `push payload is ${plaintext.length} octets; the limit is ${MAX_PUSH_PLAINTEXT}`,
    );
  const uaPublic = new Uint8Array(Buffer.from(keys.p256dh, "base64url"));
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04)
    throw new Error(
      "subscription p256dh must be a 65-byte uncompressed P-256 point",
    );
  const authSecret = new Uint8Array(Buffer.from(keys.auth, "base64url"));
  if (authSecret.length !== 16)
    throw new Error("subscription auth secret must be 16 octets");
  const salt = seam?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("push salt must be 16 octets");

  // Importing validates the point is on the curve (RFC 8291 §7).
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sender =
    seam?.senderKeys ??
    (await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    ));
  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", sender.publicKey),
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey },
      sender.privateKey,
      256,
    ),
  );

  // HKDF(salt=auth_secret, IKM=ecdh_secret, key_info, 32), then RFC 8188's
  // HKDF(salt, IKM, cek_info/nonce_info) — each HKDF-Expand here is the single
  // `HMAC(PRK, info ‖ 0x01)` block of §3.4, truncated.
  const ikm = await hkdf(
    authSecret,
    ecdhSecret,
    concat(KEY_INFO_LABEL, uaPublic, asPublic),
    32,
  );
  const cek = await hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(salt, ikm, NONCE_INFO, 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  // The last (only) record ends with the 0x02 delimiter; the sequence number
  // is 0, so the nonce is used as derived.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      aesKey,
      concat(plaintext, Uint8Array.of(0x02)),
    ),
  );

  const header = new Uint8Array(HEADER_LENGTH);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}
