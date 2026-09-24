import {
  type KeyObject,
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

/**
 * A minimal software WebAuthn authenticator for tests. It produces REAL ES256
 * (P-256 ECDSA) attestation and assertion responses — the same wire shapes a
 * browser posts back — so `@simplewebauthn/server` performs genuine signature
 * verification against them. Nothing here is stubbed: a broken signature makes
 * the server return `verified: false`, which is exactly what the negative tests
 * rely on.
 *
 * Only the "none" attestation format and the EC2/P-256 key type are supported —
 * enough to exercise the gate end to end without a live browser or hardware key.
 */

// ---- minimal CBOR encoder (definite-length; ints, bytes, text, maps) --------

function cborHead(major: number, len: number): Buffer {
  const mt = major << 5;
  if (len < 24) return Buffer.from([mt | len]);
  if (len < 0x100) return Buffer.from([mt | 24, len]);
  if (len < 0x10000) return Buffer.from([mt | 25, len >> 8, len & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = mt | 26;
  b.writeUInt32BE(len >>> 0, 1);
  return b;
}

function cborInt(n: number): Buffer {
  return n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n);
}
function cborBytes(buf: Buffer): Buffer {
  return Buffer.concat([cborHead(2, buf.length), buf]);
}
function cborText(str: string): Buffer {
  const b = Buffer.from(str, "utf8");
  return Buffer.concat([cborHead(3, b.length), b]);
}
function cborMap(entries: [Buffer, Buffer][]): Buffer {
  const parts = [cborHead(5, entries.length)];
  for (const [k, v] of entries) parts.push(k, v);
  return Buffer.concat(parts);
}

// ---- authenticator ----------------------------------------------------------

interface StoredKey {
  privateKey: KeyObject;
  cosePublicKey: Buffer;
  counter: number;
}

interface RegistrationOptionsLike {
  challenge: string;
}
interface AuthenticationOptionsLike {
  challenge: string;
}

export interface RegistrationResult {
  id: string;
  rawId: string;
  type: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports: string[];
  };
  clientExtensionResults: Record<string, never>;
}

export interface AuthenticationResult {
  id: string;
  rawId: string;
  type: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  };
  clientExtensionResults: Record<string, never>;
}

export class VirtualAuthenticator {
  readonly #rpID: string;
  readonly #origin: string;
  readonly #keys = new Map<string, StoredKey>();

  constructor(rpID: string, origin: string) {
    this.#rpID = rpID;
    this.#origin = origin;
  }

  /** Run a registration ceremony, returning the response the browser would post. */
  register(options: RegistrationOptionsLike): RegistrationResult {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const jwk = publicKey.export({ format: "jwk" });
    if (jwk.x === undefined || jwk.y === undefined)
      throw new Error("missing EC public point");
    const x = Buffer.from(jwk.x, "base64url");
    const y = Buffer.from(jwk.y, "base64url");
    // COSE_Key EC2/P-256: {1:2, 3:-7, -1:1, -2:x, -3:y}
    const cosePublicKey = cborMap([
      [cborInt(1), cborInt(2)],
      [cborInt(3), cborInt(-7)],
      [cborInt(-1), cborInt(1)],
      [cborInt(-2), cborBytes(x)],
      [cborInt(-3), cborBytes(y)],
    ]);

    const credId = randomBytes(32);
    this.#keys.set(credId.toString("base64url"), {
      privateKey,
      cosePublicKey,
      counter: 0,
    });

    // authData: rpIdHash | flags(UP|UV|AT=0x45) | signCount(0) | attestedCredData
    const rpIdHash = createHash("sha256").update(this.#rpID).digest();
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(credId.length, 0);
    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([0x45]),
      Buffer.alloc(4), // signCount 0
      Buffer.alloc(16), // aaguid
      credIdLen,
      credId,
      cosePublicKey,
    ]);

    const attestationObject = cborMap([
      [cborText("fmt"), cborText("none")],
      [cborText("attStmt"), cborMap([])],
      [cborText("authData"), cborBytes(authData)],
    ]);

    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge: options.challenge,
        origin: this.#origin,
        crossOrigin: false,
      }),
    );

    const idB64 = credId.toString("base64url");
    return {
      id: idB64,
      rawId: idB64,
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  /**
   * Run an assertion ceremony with the credential id registered earlier.
   * `userVerified: false` sets only the user-presence flag, as an authenticator
   * that skipped its PIN/biometric check would.
   */
  authenticate(
    options: AuthenticationOptionsLike,
    credentialId?: string,
    { userVerified = true }: { userVerified?: boolean } = {},
  ): AuthenticationResult {
    const id = credentialId ?? [...this.#keys.keys()][0];
    if (id === undefined) throw new Error("no registered credentials");
    const key = this.#keys.get(id);
    if (key === undefined) throw new Error(`no key for credential ${id}`);
    key.counter += 1;

    const rpIdHash = createHash("sha256").update(this.#rpID).digest();
    const signCount = Buffer.alloc(4);
    signCount.writeUInt32BE(key.counter, 0);
    // authData: rpIdHash | flags(UP|UV=0x05, or UP alone=0x01) | signCount
    const flags = userVerified ? 0x05 : 0x01;
    const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), signCount]);

    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: options.challenge,
        origin: this.#origin,
        crossOrigin: false,
      }),
    );
    const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
    const signature = createSign("SHA256")
      .update(Buffer.concat([authData, clientDataHash]))
      .sign(key.privateKey); // DER-encoded ECDSA, as WebAuthn requires

    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
      },
      clientExtensionResults: {},
    };
  }
}
