import sodium from "libsodium-wrappers";
import { b64u, unb64u } from "./identity";

/**
 * Aggregator-brokered pairing ceremony (spec §7, §12). The aggregator relays the
 * host's and phone's device public keys to each other, so a malicious/curious
 * relay could substitute its own key and MITM the pairing. The out-of-band
 * pairing **code** the operator carries (host prints it, user types it on the
 * phone) is the only shared secret, and every value here binds the key exchange
 * to it:
 *
 * - The relay only ever learns the two public keys, the two MACs, and a
 *   code-derived `rendezvousId`. To forge a MAC over a substituted key it must
 *   recover the code. Because the relay sees a MAC over a *known* public key it
 *   could brute-force a weak code OFFLINE (guess `code'`, recompute, compare) —
 *   which is exactly why the code carries 128 bits of entropy. A short PIN would
 *   be unsafe here; TTL + attempt caps at the broker are only defense-in-depth.
 * - Each side commits to its OWN public key with a role-tagged MAC; the peer
 *   recomputes and aborts on mismatch, so a swapped key is rejected before any
 *   session key is derived.
 */

/** Crockford base32 (no I, L, O, U) — unambiguous for an operator to read/type. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/**
 * 128-bit code → 16 random bytes → 26 Crockford base32 symbols. This entropy is
 * load-bearing: the relay sees a MAC over a known public key, so a shorter code
 * would be offline-brute-forceable against the fast KDF. NEVER shorten this
 * without switching to a memory-hard KDF (Argon2). Prod also runs the WebAuthn
 * gate, so `/pair/claim` is session-token-gated, not open.
 */
const CODE_BYTES = 16;
/** `crypto_kdf_derive_from_key` context (must be 8 bytes). */
const KDF_CONTEXT = "omprpair";
const SUBKEY_RENDEZVOUS = 1;
const SUBKEY_MAC = 2;
/** SAS length in bytes before base32 (5 bytes → 8 symbols). */
const SAS_BYTES = 5;

const enc = new TextEncoder();

export type PairingRole = "host" | "phone";

function toBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * Decode a user-typed code: uppercase, fold the Crockford look-alikes
 * (`O`→`0`, `I`/`L`→`1`), and ignore any non-alphabet character (hyphens,
 * spaces) so grouping and casing never change the derived secret.
 */
function fromBase32(text: string): Uint8Array {
  const normalized = text
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of normalized) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    buffer = (buffer << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** A role-separated MAC message tag, so a host MAC can never pass as a phone MAC. */
function roleTag(role: PairingRole): Uint8Array {
  return enc.encode(`omp-remote/pair/${role}\u0000`);
}

/** Length-prefix (u16 big-endian) a UTF-8 string for MAC input: a variable-length
 *  machineId placed before the fixed-size pubkey cannot be shifted or relabelled by
 *  the relay without breaking the MAC. */
function lenPrefixed(s: string): Uint8Array {
  const bytes = enc.encode(s);
  if (bytes.length > 0xffff) throw new Error("machineId too long to bind");
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >>> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

/** The authenticated message for a commitment: role tag, the length-prefixed
 *  machineId (empty for the phone), then the raw public key. Binding machineId
 *  stops a relay relabelling which machine a key belongs to (spec §7). */
function macMessage(
  role: PairingRole,
  machineId: string,
  pubKey: string,
): Uint8Array {
  return concat(concat(roleTag(role), lenPrefixed(machineId)), unb64u(pubKey));
}

/** Generate a fresh 128-bit pairing code, grouped in fours for the operator. */
export async function newPairingCode(): Promise<string> {
  await sodium.ready;
  const raw = sodium.randombytes_buf(CODE_BYTES);
  return (toBase32(raw).match(/.{1,4}/g) ?? []).join("-");
}

/**
 * Derive the two independent secrets from the code: the `rendezvousId` the
 * aggregator matches host↔phone on, and the `macKey` the commitments use. Both
 * come from domain-separated `crypto_kdf` subkeys of `BLAKE2b(code)`, so the
 * rendezvous id leaks nothing about the MAC key or the code.
 */
async function derive(
  code: string,
): Promise<{ rendezvousId: string; macKey: Uint8Array }> {
  await sodium.ready;
  const master = sodium.crypto_generichash(
    sodium.crypto_kdf_KEYBYTES,
    fromBase32(code),
    null,
  );
  const rendezvous = sodium.crypto_kdf_derive_from_key(
    32,
    SUBKEY_RENDEZVOUS,
    KDF_CONTEXT,
    master,
  );
  const macKey = sodium.crypto_kdf_derive_from_key(
    sodium.crypto_auth_KEYBYTES,
    SUBKEY_MAC,
    KDF_CONTEXT,
    master,
  );
  return { rendezvousId: b64u(rendezvous), macKey };
}

async function commit(
  code: string,
  role: PairingRole,
  pubKey: string,
  machineId = "",
): Promise<{ rendezvousId: string; mac: string }> {
  const { rendezvousId, macKey } = await derive(code);
  const mac = sodium.crypto_auth(macMessage(role, machineId, pubKey), macKey);
  return { rendezvousId, mac: b64u(mac) };
}

/** Host side: rendezvous id + a MAC committing to `machineId` AND `hostPub`. */
export function hostCommitment(
  code: string,
  machineId: string,
  hostPub: string,
): Promise<{ rendezvousId: string; mac: string }> {
  return commit(code, "host", hostPub, machineId);
}

/** Phone side: derive the rendezvous id and a MAC committing to `phonePub`. */
export function phoneCommitment(
  code: string,
  phonePub: string,
): Promise<{ rendezvousId: string; mac: string }> {
  return commit(code, "phone", phonePub);
}

/**
 * Verify a peer's role-tagged MAC over the public key (and, for the host role,
 * the `machineId`) the relay claims is theirs. Returns `false` on any mismatch
 * or malformed input — a relay that swapped the key OR relabelled the machineId
 * cannot pass this without the code. Never throws.
 */
export async function verifyPeerMac(
  code: string,
  role: PairingRole,
  pubKey: string,
  mac: string,
  machineId = "",
): Promise<boolean> {
  try {
    const { macKey } = await derive(code);
    return sodium.crypto_auth_verify(
      unb64u(mac),
      macMessage(role, machineId, pubKey),
      macKey,
    );
  } catch {
    return false;
  }
}

/**
 * A short authentication string over the machineId + both public keys, keyed by
 * the code. Shown on the host and the phone for the operator to eyeball as a
 * second check; correctness is enforced by {@link verifyPeerMac}, this is
 * display-only.
 */
export async function pairingSas(
  code: string,
  machineId: string,
  hostPub: string,
  phonePub: string,
): Promise<string> {
  const { macKey } = await derive(code);
  const digest = sodium.crypto_generichash(
    SAS_BYTES,
    concat(lenPrefixed(machineId), concat(unb64u(hostPub), unb64u(phonePub))),
    macKey,
  );
  return toBase32(digest);
}
