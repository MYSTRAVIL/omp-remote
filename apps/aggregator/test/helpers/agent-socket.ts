/**
 * Bun's `WebSocket` accepts an options object carrying upgrade `headers`, but
 * lib.dom's constructor type (loaded workspace-wide) only admits subprotocols.
 */
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

/** Dial `${base}/agent` presenting `token` as the upgrade's bearer header. */
export function dialAgent(base: string, token: string): WebSocket {
  return new BunWebSocket(`${base}/agent`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
