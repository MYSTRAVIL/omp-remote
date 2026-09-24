import { devClientProtocols } from "@omp-remote/protocol";
import type { DevClientConfig } from "../../src/service";

export const TEST_DEV_SECRET = "test-dev-client-secret";

/** The loopback dev client on a free port, open to non-browser clients only. */
export const testDevClient: DevClientConfig = {
  port: 0,
  secret: TEST_DEV_SECRET,
  allowedOrigins: [],
};

/** A dev-client WebSocket offering `secret` the way the web client does. */
export function devClientSocket(
  port: number,
  secret = TEST_DEV_SECRET,
): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}`, devClientProtocols(secret));
}
