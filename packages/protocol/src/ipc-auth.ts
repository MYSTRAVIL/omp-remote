import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Mutual authentication for the bridge↔host-agent IPC endpoint. The endpoint
 * (a Windows named pipe or a Unix socket) can be created by any local process
 * that gets there first, so neither side may reveal the IPC token to its peer:
 * each proves knowledge of it with an HMAC over both fresh nonces and a
 * direction label, and the bridge sends nothing else until the agent has proven
 * itself. Exchange (one JSON line each, before any `Frame`):
 *
 *   bridge → agent  ipcAuthInit      { v, clientNonce }
 *   agent  → bridge ipcAuthChallenge { serverNonce }
 *   bridge → agent  ipcAuthProof     { mac: HMAC(token, client ‖ nonces) }
 *   agent  → bridge ipcAuthAccept    { mac: HMAC(token, server ‖ nonces) }
 *                or ipcAuthReject    (the bridge's proof was wrong)
 *
 * The bridge speaks first so the agent can still tell an already-loaded bridge
 * (whose first line is a plain `hello`) from a new one.
 */
export const IPC_AUTH_VERSION = 1;

/** 32 random bytes / an HMAC-SHA256 digest, as unpadded base64url. */
const Bytes32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const IpcAuthInit = z.strictObject({
  t: z.literal("ipcAuthInit"),
  v: z.literal(IPC_AUTH_VERSION),
  clientNonce: Bytes32,
});
export const IpcAuthChallenge = z.strictObject({
  t: z.literal("ipcAuthChallenge"),
  serverNonce: Bytes32,
});
export const IpcAuthProof = z.strictObject({
  t: z.literal("ipcAuthProof"),
  mac: Bytes32,
});
export const IpcAuthAccept = z.strictObject({
  t: z.literal("ipcAuthAccept"),
  mac: Bytes32,
});
export const IpcAuthReject = z.strictObject({ t: z.literal("ipcAuthReject") });
/** What the agent may answer to a bridge's proof. */
export const IpcAuthVerdict = z.discriminatedUnion("t", [
  IpcAuthAccept,
  IpcAuthReject,
]);

export type IpcAuthInit = z.infer<typeof IpcAuthInit>;
export type IpcAuthChallenge = z.infer<typeof IpcAuthChallenge>;
export type IpcAuthProof = z.infer<typeof IpcAuthProof>;
export type IpcAuthAccept = z.infer<typeof IpcAuthAccept>;
export type IpcAuthReject = z.infer<typeof IpcAuthReject>;
export type IpcAuthFrame =
  | IpcAuthInit
  | IpcAuthChallenge
  | IpcAuthProof
  | IpcAuthAccept
  | IpcAuthReject;

export type IpcAuthDirection = "client" | "server";

export function ipcAuthNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** The proof one side sends: HMAC-SHA256 keyed by the IPC token. */
export function ipcAuthMac(
  token: string,
  direction: IpcAuthDirection,
  serverNonce: string,
  clientNonce: string,
): string {
  // Nonces are fixed-format base64url, so newline separators are unambiguous.
  return createHmac("sha256", token)
    .update(`omp-remote-ipc-auth/v${IPC_AUTH_VERSION}\n${direction}\n`)
    .update(`${serverNonce}\n${clientNonce}`)
    .digest("base64url");
}

/** Whether `mac` is the peer's valid proof, compared in constant time. */
export function ipcAuthMacMatches(
  mac: string,
  token: string,
  direction: IpcAuthDirection,
  serverNonce: string,
  clientNonce: string,
): boolean {
  const expected = Buffer.from(
    ipcAuthMac(token, direction, serverNonce, clientNonce),
  );
  const presented = Buffer.from(mac);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

/**
 * Why a bridge refused (or could not complete) the handshake:
 * - `agent-closed`: the endpoint closed before proving the token — a host-agent
 *   older than this bridge, or a process squatting the endpoint.
 * - `token-rejected`: the agent says our proof is wrong (the tokens differ).
 * - `server-unproven`: the endpoint answered but could not prove the token.
 * - `protocol-error`: the endpoint sent something that is not the handshake.
 */
export type IpcAuthFailureCode =
  | "agent-closed"
  | "token-rejected"
  | "server-unproven"
  | "protocol-error";

export class IpcAuthError extends Error {
  readonly code: IpcAuthFailureCode;
  constructor(code: IpcAuthFailureCode) {
    super(`IPC handshake failed: ${code}`);
    this.code = code;
  }
}

/** Why the agent dropped a bridge mid-handshake. */
export type IpcServerAuthFailureCode = "token-mismatch" | "protocol-error";
