import { z } from "zod";

/**
 * Sealed push notices: the host agent seals a short notice for the phone's
 * service worker, and the aggregator carries it as an opaque Web Push payload.
 * The aggregator never holds the key, so it stays content-blind.
 *
 * Key: `notifyKey()` from `@omp-remote/crypto`, derived from the pairing's
 * session key (agent `tx` = phone `rx`). Cipher: AES-256-GCM through WebCrypto,
 * so the service worker can open a notice without libsodium. The AAD binds the
 * envelope to its machine.
 */

/** Longest session title a notice carries. */
export const NOTICE_TITLE_MAX = 80;
/** Longest detail line (last reply, question or tool) a notice carries. */
export const NOTICE_DETAIL_MAX = 180;
/** Longest serialized envelope the aggregator accepts as a push payload. */
export const NOTICE_ENVELOPE_MAX = 3000;

/** Why a session needs the user. */
export const NoticeReason = z.enum(["idle", "approval", "question"]);
export type NoticeReason = z.infer<typeof NoticeReason>;

export const NotifyNotice = z.discriminatedUnion("kind", [
  /** A session needs the user: show (or replace) its notification. */
  z.object({
    kind: z.literal("attention"),
    sessionId: z.string().min(1),
    reason: NoticeReason,
    title: z.string().max(NOTICE_TITLE_MAX),
    project: z.string().max(NOTICE_TITLE_MAX),
    detail: z.string().max(NOTICE_DETAIL_MAX),
  }),
  /** The user answered the session somewhere: close its notification. */
  z.object({
    kind: z.literal("clear"),
    sessionId: z.string().min(1),
  }),
]);
export type NotifyNotice = z.infer<typeof NotifyNotice>;

/** The opaque push payload: machine id in the clear, the notice sealed. */
export const NotifyEnvelope = z.object({
  v: z.literal(1),
  /** The machine whose notify key opens `ct`. */
  m: z.string().min(1),
  /** base64url 12-byte AES-GCM IV. */
  n: z.string().min(1),
  /** base64url ciphertext with the GCM tag appended. */
  ct: z.string().min(1),
});
export type NotifyEnvelope = z.infer<typeof NotifyEnvelope>;

/** Cut `text` to at most `max` characters, marking a cut with an ellipsis. */
export function clipNoticeText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function b64u(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function noticeAad(machineId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`omp-remote/notify/v1|${machineId}`);
}

function importNotifyKey(
  key: Uint8Array,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, [
    usage,
  ]);
}

/** Seal `notice` for the phone paired to machine `machineId`. */
export async function sealNotice(
  key: Uint8Array,
  machineId: string,
  notice: NotifyNotice,
): Promise<NotifyEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: noticeAad(machineId) },
    await importNotifyKey(key, "encrypt"),
    new TextEncoder().encode(JSON.stringify(notice)),
  );
  return { v: 1, m: machineId, n: b64u(iv), ct: b64u(new Uint8Array(ct)) };
}

/**
 * Open a sealed notice. Throws when the key is wrong, the envelope was altered,
 * or the plaintext is not a valid {@link NotifyNotice}.
 */
export async function openNotice(
  key: Uint8Array,
  envelope: NotifyEnvelope,
): Promise<NotifyNotice> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unb64u(envelope.n),
      additionalData: noticeAad(envelope.m),
    },
    await importNotifyKey(key, "decrypt"),
    unb64u(envelope.ct),
  );
  return NotifyNotice.parse(JSON.parse(new TextDecoder().decode(plain)));
}
