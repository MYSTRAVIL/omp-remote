/**
 * omp Collab wire primitives for the headless guest: link parsing, AES-256-GCM
 * sealing, and the peerId envelope. Mirrors pi-coding-agent@18.1.20
 * collab/{crypto,protocol}.ts exactly; verified against a live relay in
 * scripts/parity/collab-guest-spike.ts.
 *
 * The relay is content-blind: it sees only `[4B BE peerId][sealed]`. The room
 * key never leaves this process. Frames are JSON sealed with a random 12-byte
 * IV as `[12B IV][ciphertext+tag]`, no AAD.
 */
import {
  COLLAB_PROTO,
  ENVELOPE_HEADER_LENGTH,
  type GuestFrame,
  ROOM_KEY_BYTES,
  WRITE_TOKEN_BYTES,
} from "@oh-my-pi/pi-wire";

export { COLLAB_PROTO };

const IV_LENGTH = 12;
const DEFAULT_RELAY_ORIGIN = "wss://my.omp.sh";
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;

export interface ParsedLink {
  /** `wss://host[:port]/r/<roomId>` — no query string; the socket appends `?role=`. */
  wsUrl: string;
  /** 32-byte AES-256-GCM room key. */
  key: Uint8Array;
  /** 16-byte write token when the link grants control; absent for view links. */
  writeToken?: Uint8Array;
}

/** Guarantee a zero-offset ArrayBuffer view (WebCrypto rejects SharedArrayBuffer-backed views). */
function asStrict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * Parse a Collab control/view link into a relay ws URL + room secrets. Accepts
 * the browser deep link (`https://host/#<inner>`), the bare `<roomId>.<key>`
 * default-relay form, and an explicit `ws[s]://host/r/<roomId>.<key>`.
 */
export function parseCollabLink(link: string): ParsedLink {
  let text = link.trim().replace(/%23/gi, "#");
  if (/^https?:\/\//i.test(text)) {
    const hash = text.indexOf("#");
    if (hash >= 0) text = text.slice(hash + 1);
  }
  let origin = DEFAULT_RELAY_ORIGIN;
  let roomId: string;
  let secretB64: string;
  const bare = BARE_LINK_RE.exec(text);
  if (bare) {
    roomId = bare[1] ?? "";
    secretB64 = bare[2] ?? "";
  } else {
    if (!text.includes("://")) text = `wss://${text}`;
    const url = new URL(text);
    const scheme =
      url.protocol === "ws:" || url.protocol === "http:" ? "ws:" : "wss:";
    origin = `${scheme}//${url.host}`;
    const m = ROOM_PATH_RE.exec(url.pathname);
    if (!m) throw new Error(`collab link missing /r/<roomId>: ${link}`);
    roomId = m[1] ?? "";
    secretB64 =
      m[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  }
  const secret = new Uint8Array(Buffer.from(secretB64, "base64url"));
  if (
    secret.byteLength !== ROOM_KEY_BYTES &&
    secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES
  ) {
    throw new Error(
      `collab link key must be 32 (view) or 48 (control) bytes, got ${secret.byteLength}`,
    );
  }
  return {
    wsUrl: `${origin}/r/${roomId}`,
    key: secret.subarray(0, ROOM_KEY_BYTES),
    writeToken:
      secret.byteLength > ROOM_KEY_BYTES
        ? secret.subarray(ROOM_KEY_BYTES)
        : undefined,
  };
}

export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asStrict(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Seal a guest frame: `[12B IV][ciphertext+tag]`. */
export async function seal(
  key: CryptoKey,
  frame: GuestFrame,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const pt = asStrict(new TextEncoder().encode(JSON.stringify(frame)));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt),
  );
  const out = new Uint8Array(IV_LENGTH + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, IV_LENGTH);
  return out;
}

/** Open a sealed payload; returns the decoded JSON as `unknown` for the caller to validate. */
export async function open(key: CryptoKey, data: Uint8Array): Promise<unknown> {
  if (data.byteLength <= IV_LENGTH) throw new Error("sealed frame too short");
  const iv = asStrict(data.subarray(0, IV_LENGTH));
  const ct = asStrict(data.subarray(IV_LENGTH));
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array {
  const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
  new DataView(out.buffer).setUint32(0, peerId, false);
  out.set(sealed, ENVELOPE_HEADER_LENGTH);
  return out;
}

export function unpackEnvelope(
  data: Uint8Array,
): { peerId: number; payload: Uint8Array } | null {
  if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
  const peerId = new DataView(
    data.buffer,
    data.byteOffset,
    ENVELOPE_HEADER_LENGTH,
  ).getUint32(0, false);
  return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}
