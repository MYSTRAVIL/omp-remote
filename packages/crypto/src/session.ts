import sodium from "libsodium-wrappers";
import { type Identity, b64u, unb64u } from "./identity";

export interface SessionKeys {
  rx: Uint8Array;
  tx: Uint8Array;
}

export interface SealedEnvelope {
  n: string;
  ct: string;
}

export class AeadError extends Error {}

export async function clientSessionKeys(
  self: Identity,
  peerPublicKey: string,
): Promise<SessionKeys> {
  await sodium.ready;
  const k = sodium.crypto_kx_client_session_keys(
    unb64u(self.publicKey),
    unb64u(self.secretKey),
    unb64u(peerPublicKey),
  );
  return { rx: k.sharedRx, tx: k.sharedTx };
}

export async function serverSessionKeys(
  self: Identity,
  peerPublicKey: string,
): Promise<SessionKeys> {
  await sodium.ready;
  const k = sodium.crypto_kx_server_session_keys(
    unb64u(self.publicKey),
    unb64u(self.secretKey),
    unb64u(peerPublicKey),
  );
  return { rx: k.sharedRx, tx: k.sharedTx };
}

export function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): SealedEnvelope {
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
  );
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    key,
  );
  return { n: b64u(nonce), ct: b64u(ct) };
}

export function open(
  key: Uint8Array,
  env: SealedEnvelope,
  aad: Uint8Array,
): Uint8Array {
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      unb64u(env.ct),
      aad,
      unb64u(env.n),
      key,
    );
  } catch (err) {
    throw new AeadError(`aead open failed: ${(err as Error).message}`);
  }
}
