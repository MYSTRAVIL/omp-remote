import { expect, test } from "bun:test";
import { type CollabPort, CollabRelay } from "../src/collab-relay";

function fakePort(id: string) {
  const binary: Uint8Array[] = [];
  const text: string[] = [];
  let closed: { code?: number; reason?: string } | null = null;
  const port: CollabPort = {
    id,
    sendBinary: (d) => void binary.push(d),
    sendText: (t) => void text.push(t),
    close: (code, reason) => {
      closed = { code, reason };
    },
  };
  return {
    port,
    binary,
    text,
    get closed() {
      return closed;
    },
  };
}

function envelope(peerId: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, peerId, false);
  out.set(payload, 4);
  return out;
}

function peerOf(data: Uint8Array): number {
  return new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false);
}

function requirePeer(value: number | null): number {
  if (value === null) throw new Error("join was rejected");
  return value;
}

test("host then guest join; the host is told a guest joined", () => {
  const relay = new CollabRelay();
  const host = fakePort("h");
  const guest = fakePort("g");
  expect(relay.join(host.port, "room1", "host")).toBe(0);
  expect(relay.join(guest.port, "room1", "guest")).toBe(1);
  expect(host.text).toEqual([JSON.stringify({ t: "peer-joined", peer: 1 })]);
});

test("a second host for a live room evicts the first instead of being rejected", () => {
  // omp treats 4009 as fatal; a reconnecting host whose old socket is still
  // half-open must replace it, not lose hosting for good.
  const relay = new CollabRelay();
  const h1 = fakePort("h1");
  const g1 = fakePort("g1");
  relay.join(h1.port, "r", "host");
  relay.join(g1.port, "r", "guest");

  const h2 = fakePort("h2");
  expect(relay.join(h2.port, "r", "host")).toBe(0);
  expect(h1.closed?.code).toBe(1012); // non-fatal: omp would reconnect
  expect(g1.text).toContain(JSON.stringify({ t: "room-closed" }));
  expect(g1.closed?.code).toBe(4001);

  const g2 = fakePort("g2");
  expect(relay.join(g2.port, "r", "guest")).toBe(1);
  relay.routeBinary(h2.port, "r", "host", 0, envelope(0, [7]));
  relay.routeBinary(h1.port, "r", "host", 0, envelope(0, [8])); // evicted host is ignored
  expect(g2.binary).toHaveLength(1);
  expect(g1.binary).toHaveLength(0);
});

test("late leaves from an evicted host or its guests do not touch the new room", () => {
  const relay = new CollabRelay();
  const h1 = fakePort("h1");
  const g1 = fakePort("g1");
  relay.join(h1.port, "r", "host");
  const oldPeer = requirePeer(relay.join(g1.port, "r", "guest"));
  const h2 = fakePort("h2");
  relay.join(h2.port, "r", "host");
  const g2 = fakePort("g2");
  const newPeer = requirePeer(relay.join(g2.port, "r", "guest"));
  expect(newPeer).toBe(oldPeer); // numbering restarted, so ids collide

  // The evicted sockets finally close.
  relay.leave(h1.port, "r", "host", 0);
  relay.leave(g1.port, "r", "guest", oldPeer);

  expect(g2.closed).toBeNull();
  expect(h2.text).not.toContain(
    JSON.stringify({ t: "peer-left", peer: newPeer }),
  );
  relay.routeBinary(h2.port, "r", "host", 0, envelope(newPeer, [1]));
  relay.routeBinary(g1.port, "r", "guest", oldPeer, envelope(0, [2])); // stale guest
  expect(h2.binary).toHaveLength(0);
  expect(g2.binary).toHaveLength(1);
});

test("a guest frame reaches the host stamped with the guest's id", () => {
  const relay = new CollabRelay();
  const host = fakePort("h");
  const guest = fakePort("g");
  relay.join(host.port, "r", "host");
  const peer = requirePeer(relay.join(guest.port, "r", "guest"));
  relay.routeBinary(guest.port, "r", "guest", peer, envelope(0, [9, 9])); // guest always sends peerId 0
  expect(host.binary).toHaveLength(1);
  const frame = host.binary[0];
  if (!frame) throw new Error("host received no frame");
  expect(peerOf(frame)).toBe(peer);
});

test("host broadcast reaches every guest (peer 0); a targeted frame reaches only one", () => {
  const relay = new CollabRelay();
  const host = fakePort("h");
  relay.join(host.port, "r", "host");
  const g1 = fakePort("g1");
  const g2 = fakePort("g2");
  relay.join(g1.port, "r", "guest");
  const p2 = requirePeer(relay.join(g2.port, "r", "guest"));

  relay.routeBinary(host.port, "r", "host", 0, envelope(0, [1])); // broadcast
  expect(g1.binary).toHaveLength(1);
  expect(g2.binary).toHaveLength(1);
  const bcast = g1.binary[0];
  if (!bcast) throw new Error("no broadcast frame");
  expect(peerOf(bcast)).toBe(0); // guests always see the host as peer 0

  relay.routeBinary(host.port, "r", "host", 0, envelope(p2, [2])); // targeted to g2
  expect(g2.binary).toHaveLength(2);
  expect(g1.binary).toHaveLength(1); // g1 untouched
});

test("a guest leaving notifies the host; a host leaving closes guests with room-closed", () => {
  const relay = new CollabRelay();
  const host = fakePort("h");
  const guest = fakePort("g");
  relay.join(host.port, "r", "host");
  const p = requirePeer(relay.join(guest.port, "r", "guest"));
  relay.leave(guest.port, "r", "guest", p);
  expect(host.text.at(-1)).toBe(JSON.stringify({ t: "peer-left", peer: p }));

  const g2 = fakePort("g2");
  relay.join(g2.port, "r", "guest");
  relay.leave(host.port, "r", "host", 0);
  expect(g2.text).toContain(JSON.stringify({ t: "room-closed" }));
  expect(g2.closed?.code).toBe(4001);
  expect(relay.roomCount).toBe(0);
});

test("host leave closes every guest and resets peer numbering", () => {
  const relay = new CollabRelay();
  const host = fakePort("h");
  const guest = fakePort("g");
  relay.join(host.port, "room", "host");
  expect(relay.join(guest.port, "room", "guest")).toBe(1);

  relay.leave(host.port, "room", "host", 0);
  expect(guest.closed?.code).toBe(4001);

  const nextHost = fakePort("h2");
  const nextGuest = fakePort("g2");
  relay.join(nextHost.port, "room", "host");
  expect(relay.join(nextGuest.port, "room", "guest")).toBe(1);
});
