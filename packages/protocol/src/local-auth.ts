import { z } from "zod";

/**
 * A per-install secret (the IPC token, the dev-client secret): 32 random bytes
 * as unpadded base64url, so it is also a valid WebSocket subprotocol token.
 */
export const InstallSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * The subprotocol the host-agent's loopback dev client negotiates. Browsers
 * cannot set WebSocket headers, so a client offers this protocol plus
 * `omp-remote-dev.<secret>`; the agent checks the secret before upgrading and
 * echoes only this protocol back.
 */
export const DEV_CLIENT_PROTOCOL = "omp-remote-dev";
const DEV_CLIENT_SECRET_PREFIX = `${DEV_CLIENT_PROTOCOL}.`;

/** The subprotocols a dev client offers to authenticate with `secret`. */
export function devClientProtocols(secret: string): string[] {
  return [DEV_CLIENT_PROTOCOL, `${DEV_CLIENT_SECRET_PREFIX}${secret}`];
}

/**
 * The secret offered by a `Sec-WebSocket-Protocol` request header, or
 * `undefined` unless it offers both the dev-client protocol and a secret.
 */
export function devClientSecretOffered(
  header: string | null,
): string | undefined {
  if (header === null) return undefined;
  const offered = header.split(",").map((protocol) => protocol.trim());
  if (!offered.includes(DEV_CLIENT_PROTOCOL)) return undefined;
  return offered
    .find((protocol) => protocol.startsWith(DEV_CLIENT_SECRET_PREFIX))
    ?.slice(DEV_CLIENT_SECRET_PREFIX.length);
}

/** Same-origin path where the local web dev server hands the page the secret. */
export const DEV_CLIENT_SECRET_PATH = "/__dev/client-secret";

/** Body served at {@link DEV_CLIENT_SECRET_PATH}. */
export const DevClientSecretResponse = z.object({ secret: InstallSecret });
export type DevClientSecretResponse = z.infer<typeof DevClientSecretResponse>;
