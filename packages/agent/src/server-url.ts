/** WebSocket scheme for each scheme a configured server URL may use. */
const SOCKET_SCHEMES: Record<string, string> = {
  "http:": "ws:",
  "https:": "wss:",
  "ws:": "ws:",
  "wss:": "wss:",
};

/**
 * The aggregator's `/agent` WebSocket URL for the configured server URL:
 * `http:` dials `ws:`, `https:` dials `wss:`, and `ws:`/`wss:` pass through. A
 * path prefix (a reverse-proxy mount) is kept, minus any trailing slash.
 */
export function agentSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  const scheme = SOCKET_SCHEMES[url.protocol];
  if (scheme === undefined)
    throw new Error(
      `server URL must be http(s):// or ws(s)://, got ${url.protocol}`,
    );
  url.protocol = scheme;
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/agent`;
  url.search = "";
  url.hash = "";
  return url.href;
}
