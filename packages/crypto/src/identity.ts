import sodium from "libsodium-wrappers";

export interface Identity {
  publicKey: string;
  secretKey: string;
}

/**
 * base64url (RFC 4648 §5, no padding) without Node's `Buffer` — these helpers
 * run in the browser (phone PWA) as well as on the host, where only `btoa`/
 * `atob` are guaranteed. Output is byte-identical to Node's "base64url".
 */
export function b64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function newIdentity(): Promise<Identity> {
  await sodium.ready;
  const kp = sodium.crypto_kx_keypair();
  return { publicKey: b64u(kp.publicKey), secretKey: b64u(kp.privateKey) };
}
