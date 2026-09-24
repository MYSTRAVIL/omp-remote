import { expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { pairLink, reachableUrls } from "../src/urls";

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

test("lists LAN and tailnet IPv4, tailnet first; skips loopback, link-local, IPv6 and duplicates", () => {
  const urls = reachableUrls(
    {
      lo: [v4("127.0.0.1", true)],
      eth0: [
        v4("192.168.1.5"),
        v4("169.254.10.2"),
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "fe80::1/64",
          scopeid: 1,
        },
      ],
      tailscale0: [v4("100.101.5.9")],
      dup: [v4("192.168.1.5")],
    },
    8788,
  );
  expect(urls).toEqual([
    { url: "http://100.101.5.9:8788", kind: "tailnet" },
    { url: "http://192.168.1.5:8788", kind: "lan" },
  ]);
});

test("VM and container adapters sort after the real LAN", () => {
  const urls = reachableUrls(
    {
      "vEthernet (Default Switch)": [v4("172.17.48.1")],
      docker0: [v4("172.18.0.1")],
      Ethernet: [v4("10.0.0.43")],
    },
    8799,
  );
  expect(urls.map((u) => [u.url, u.kind])).toEqual([
    ["http://10.0.0.43:8799", "lan"],
    ["http://172.17.48.1:8799", "virtual"],
    ["http://172.18.0.1:8799", "virtual"],
  ]);
});

test("the default-route address is the first LAN URL, even on a bridged adapter with a VM-like name", () => {
  const interfaces = {
    // A Hyper-V external switch: the host's real LAN sits on a vEthernet adapter.
    "vEthernet (External)": [v4("192.168.1.20")],
    "Ethernet 2": [v4("10.99.0.5")],
    tailscale0: [v4("100.101.5.9")],
  };
  expect(
    reachableUrls(interfaces, 8788, "192.168.1.20").map((u) => [u.url, u.kind]),
  ).toEqual([
    ["http://100.101.5.9:8788", "tailnet"],
    ["http://192.168.1.20:8788", "lan"],
    ["http://10.99.0.5:8788", "lan"],
  ]);
  // Without it, the name heuristic alone demotes the real LAN.
  expect(reachableUrls(interfaces, 8788).map((u) => u.kind)).toEqual([
    "tailnet",
    "lan",
    "virtual",
  ]);
});

test("the default-route LAN outranks another LAN address listed first", () => {
  const urls = reachableUrls(
    { a: [v4("172.20.0.1")], b: [v4("192.168.1.20")] },
    1,
    "192.168.1.20",
  );
  expect(urls[0]?.url).toBe("http://192.168.1.20:1");
});

test("100.x outside 100.64/10 is not tailnet", () => {
  expect(reachableUrls({ e: [v4("100.20.0.1")] }, 1)[0]?.kind).toBe("lan");
  expect(reachableUrls({ e: [v4("100.128.0.1")] }, 1)[0]?.kind).toBe("lan");
});

test("pairLink puts the code in the fragment", () => {
  expect(pairLink("http://box:8788/", "AB12-CD34")).toBe(
    "http://box:8788/#pair=AB12-CD34",
  );
});
