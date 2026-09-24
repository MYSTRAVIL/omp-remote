/**
 * An independent RFC 8291 / RFC 8188 `aes128gcm` RECEIVER (what a browser does
 * with a push body), written against the RFCs in WebCrypto so the aggregator's
 * sender is checked by something other than itself.
 */

const enc = new TextEncoder();

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

/** A test subscription: its ECDH key pair, auth secret, and the wire `keys`. */
export interface TestSubscriber {
  pair: CryptoKeyPair;
  auth: Uint8Array<ArrayBuffer>;
  keys: { p256dh: string; auth: string };
}

export async function makeSubscriber(): Promise<TestSubscriber> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const pub = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    pair,
    auth,
    keys: {
      p256dh: Buffer.from(pub).toString("base64url"),
      auth: Buffer.from(auth).toString("base64url"),
    },
  };
}

/** Import a P-256 ECDH key pair from its base64url uncompressed point and scalar. */
export async function importEcdhPair(
  publicB64u: string,
  privateB64u: string,
): Promise<CryptoKeyPair> {
  const point = Buffer.from(publicB64u, "base64url");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: point.subarray(1, 33).toString("base64url"),
    y: point.subarray(33, 65).toString("base64url"),
  };
  const alg = { name: "ECDH", namedCurve: "P-256" };
  return {
    publicKey: await crypto.subtle.importKey("jwk", jwk, alg, true, []),
    privateKey: await crypto.subtle.importKey(
      "jwk",
      { ...jwk, d: privateB64u },
      alg,
      true,
      ["deriveBits"],
    ),
  };
}

/** Parsed `aes128gcm` header fields, for structural assertions. */
export interface PushBodyHeader {
  salt: Uint8Array;
  rs: number;
  keyid: Uint8Array;
}

export function parseHeader(body: Uint8Array): PushBodyHeader {
  const idlen = body[20] ?? 0;
  return {
    salt: body.subarray(0, 16),
    rs: new DataView(body.buffer, body.byteOffset).getUint32(16),
    keyid: body.subarray(21, 21 + idlen),
  };
}

/** Decrypt a single-record push body as the subscriber; throws if it is not valid. */
export async function decryptPushBody(
  body: Uint8Array,
  receiver: CryptoKeyPair,
  auth: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const idlen = body[20] ?? 0;
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", receiver.publicKey),
  );
  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: asKey },
      receiver.privateKey,
      256,
    ),
  );
  const keyInfo = new Uint8Array([
    ...enc.encode("WebPush: info\0"),
    ...uaPublic,
    ...asPublic,
  ]);
  const ikm = await hkdf(auth, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: nonce\0"),
    12,
  );
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "decrypt",
  ]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext,
    ),
  );
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 0x02) throw new Error("bad padding delimiter");
  return padded.subarray(0, end);
}
