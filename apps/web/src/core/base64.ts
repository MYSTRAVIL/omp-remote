/**
 * Base64 encoding/decoding helpers that work under both Bun (tests) and the
 * browser (the PWA). Uses the platform's `btoa`/`atob` rather than importing a
 * crypto module, so no Node/Bun-specific APIs slip in.
 */

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64url (RFC 4648 §5) without padding, as keys travel in JSON. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode base64url, padded or not. */
export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
}
