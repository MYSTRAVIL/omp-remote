import sodium from "libsodium-wrappers";

const NOTIFY_CONTEXT = new TextEncoder().encode("omp-remote/notify/v1");

/**
 * The key that seals push notices (see `sealNotice` in `@omp-remote/protocol`).
 * Derived from the host→phone session key: the host passes its `tx`, the phone
 * its `rx`, and both get the same 32 bytes. A keyed BLAKE2b keeps it separate
 * from the sealed channel's own use of that key.
 */
export async function notifyKey(sessionKey: Uint8Array): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_generichash(32, NOTIFY_CONTEXT, sessionKey);
}
