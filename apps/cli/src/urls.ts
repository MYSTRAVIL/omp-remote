import type { NetworkInterfaceInfo } from "node:os";

export interface ReachableUrl {
  url: string;
  /**
   * `tailnet` for Tailscale's 100.64.0.0/10 range; `virtual` for a VM or
   * container adapter (Hyper-V, WSL, Docker, libvirt), which a phone usually
   * cannot reach; else `lan`.
   */
  kind: "lan" | "tailnet" | "virtual";
}

function isTailnet(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

const VIRTUAL_ADAPTER =
  /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|^br-|^virbr|^veth|^vmnet|^lxc|^cni|^podman/i;

const KIND_ORDER: Record<ReachableUrl["kind"], number> = {
  tailnet: 0,
  lan: 1,
  virtual: 2,
};

/**
 * The http URLs a phone on the LAN or tailnet can open to reach a server
 * listening on `port` on all interfaces. IPv4 only; loopback and link-local
 * (169.254/16) addresses are skipped. Order, best QR target first: tailnet
 * addresses; then `defaultRoute`, the address the OS sends internet traffic
 * from (the real LAN, whatever its adapter is called); then other LAN
 * addresses; then VM and container adapters.
 */
export function reachableUrls(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  port: number,
  defaultRoute?: string,
): ReachableUrl[] {
  const seen = new Set<string>();
  const urls: (ReachableUrl & { rank: number })[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (info.address.startsWith("169.254.")) continue;
      if (seen.has(info.address)) continue;
      seen.add(info.address);
      const isDefault = info.address === defaultRoute;
      const kind = isTailnet(info.address)
        ? "tailnet"
        : !isDefault && VIRTUAL_ADAPTER.test(name)
          ? "virtual"
          : "lan";
      // The default-route address ranks ahead of every other LAN address.
      const rank =
        KIND_ORDER[kind] * 2 + (kind === "lan" && !isDefault ? 1 : 0);
      urls.push({ url: `http://${info.address}:${port}`, kind, rank });
    }
  }
  return urls
    .sort((x, y) => x.rank - y.rank)
    .map(({ url, kind }) => ({ url, kind }));
}

/** The `#pair=` link a phone opens (or scans) to sign in and pair in one go. */
export function pairLink(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/#pair=${encodeURIComponent(code)}`;
}

/** A URL the phone can open, labelled for the operator. */
export interface PhoneUrl {
  url: string;
  /** `public`: the HTTPS origin; `local`: only a browser on this machine. */
  kind: "public" | ReachableUrl["kind"] | "local";
}

/** A listen host that accepts connections on every interface. */
function listensEverywhere(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "";
}

/** `host` as a URL authority: an IPv6 literal goes in brackets. */
function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * The URL a process on this machine uses to reach a server listening on
 * `host`:`port`: loopback when it listens everywhere, else the address it
 * binds.
 */
export function localServerUrl(host: string, port: number): string {
  return `http://${urlHost(listensEverywhere(host) ? "127.0.0.1" : host)}:${port}`;
}

/**
 * The URLs a phone can open to reach a server listening on `listen.host` at
 * `port`, best first: the public HTTPS origin when there is one; every LAN and
 * tailnet address when it listens everywhere, or the one address it binds; and
 * the loopback URL a browser on this machine uses. Never empty.
 */
export function phoneUrls(
  server: { listen: { host: string }; publicUrl?: string },
  port: number,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  defaultRoute?: string,
): PhoneUrl[] {
  const urls: PhoneUrl[] = [];
  if (server.publicUrl !== undefined)
    urls.push({ url: server.publicUrl.replace(/\/+$/, ""), kind: "public" });
  const host = server.listen.host;
  const everywhere = listensEverywhere(host);
  const loopback =
    host === "localhost" || host === "::1" || host.startsWith("127.");
  if (everywhere) urls.push(...reachableUrls(interfaces, port, defaultRoute));
  else if (!loopback)
    urls.push({
      url: `http://${urlHost(host)}:${port}`,
      kind: isTailnet(host) ? "tailnet" : "lan",
    });
  if (everywhere || loopback)
    urls.push({ url: localServerUrl(host, port), kind: "local" });
  return urls;
}

/** The HTTP scheme for each scheme a configured server URL may use. */
const HTTP_SCHEMES: Record<string, string> = {
  "http:": "http:",
  "https:": "https:",
  "ws:": "http:",
  "wss:": "https:",
};

/**
 * The HTTP base of a configured server URL, where its `/pair/*` routes live:
 * `ws:` becomes `http:` and `wss:` `https:`. A path prefix (a reverse-proxy
 * mount) is kept, with no trailing slash; query and fragment are dropped.
 */
export function httpBaseUrl(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error(`not a URL: ${serverUrl}`);
  }
  const scheme = HTTP_SCHEMES[url.protocol];
  if (scheme === undefined)
    throw new Error(
      `the server URL must be http(s):// or ws(s)://, got ${serverUrl}`,
    );
  url.protocol = scheme;
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}
