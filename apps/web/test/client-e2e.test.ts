import { afterEach, expect, test } from "bun:test";
import {
  type ByteSink,
  SealedChannel,
  type SessionKeys,
  clientSessionKeys,
  newIdentity,
  serverSessionKeys,
} from "@omp-remote/crypto";
import type { SessionMeta } from "@omp-remote/protocol";
import { AggregatorServer } from "../../aggregator/src/server";
import { tempMachineStore } from "../../aggregator/test/helpers/machines";
import { type ClientSocket, PhoneClient } from "../src/core/client";
import { AppStore } from "../src/core/store";

const machines = await tempMachineStore();
/** machine-a's `/agent` token. */
const REGTOK = await machines.issue("machine-a", 0);

const enc = new TextEncoder();
const dec = new TextDecoder();

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups.length = 0;
});

const meta: SessionMeta = {
  id: "s1",
  cwd: "/secret/quant",
  project: "quant",
  model: "m",
  title: "T",
  pid: 7,
  startedAt: 0,
};

function toU8(data: unknown): Uint8Array {
  if (typeof data === "string") return enc.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array();
}

function wsOpen(ws: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  ws.addEventListener("open", () => resolve(), { once: true });
  return promise;
}

function wsSink(ws: WebSocket): ByteSink {
  return {
    send: (bytes) => ws.send(bytes),
    onBytes: (cb) =>
      ws.addEventListener("message", (e) => cb(toU8((e as MessageEvent).data))),
  };
}

// Boundary cast: Bun's WebSocket accepts upgrade headers, but lib.dom's
// constructor type (which tsconfig.base resolves) does not declare that overload.
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

/**
 * A minimal fake host-agent: registers a machineId and says hello as the
 * uplink does, acks each phone hello, and answers `sync` with the snapshot.
 */
function fakeAgent(
  base: string,
  machineId: string,
  keys: SessionKeys,
): WebSocket {
  // Authenticates the uplink with the bearer header, as the real host-agent does.
  const ws = new BunWebSocket(`${base}/agent`, {
    headers: { Authorization: `Bearer ${REGTOK}` },
  });
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "register", machineId }));
    const channel = new SealedChannel(keys, wsSink(ws), machineId, {
      role: "responder",
    });
    channel.onFrame((f) => {
      if (f.t === "sync")
        channel.sendFrame({ t: "sessions", sessions: [meta] });
    });
    channel.hello();
  });
  return ws;
}

/** Poll `list` on a raw probe socket until the machine is present. */
function pollMachine(ws: WebSocket, machineId: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const onMsg = (e: MessageEvent) => {
    const line = dec.decode(toU8(e.data)).trim();
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (
      typeof msg === "object" &&
      msg !== null &&
      "type" in msg &&
      msg.type === "machines" &&
      "machineIds" in msg &&
      Array.isArray(msg.machineIds) &&
      msg.machineIds.includes(machineId)
    ) {
      ws.removeEventListener("message", onMsg);
      resolve();
      return;
    }
    ws.send(JSON.stringify({ type: "list" }));
  };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ type: "list" }));
  return promise;
}

test("phone attaches, syncs a snapshot through the blind relay, and builds the tree", async () => {
  const agg = new AggregatorServer({ machines, port: 0 });
  agg.start();
  cleanups.push(() => agg.stop());
  const base = `ws://127.0.0.1:${agg.boundPort}`;
  const machineId = "machine-a";

  const phoneId = await newIdentity();
  const agentId = await newIdentity();
  const phoneKeys = await clientSessionKeys(phoneId, agentId.publicKey);
  const agentKeys = await serverSessionKeys(agentId, phoneId.publicKey);

  // A steady agent: registered and holding a session before the phone attaches.
  const agentWs = fakeAgent(base, machineId, agentKeys);
  cleanups.push(() => agentWs.close());
  const probe = new WebSocket(`${base}/client`);
  await wsOpen(probe);
  await pollMachine(probe, machineId);
  probe.close();

  // The phone's real transport, with a tap capturing every relayed line for the
  // blind-relay assertion.
  const relayed: string[] = [];
  const ws = new WebSocket(`${base}/client`);
  await wsOpen(ws);
  cleanups.push(() => ws.close());
  ws.addEventListener("message", (e) => {
    const line = dec.decode(toU8((e as MessageEvent).data)).trim();
    if (line.includes('"route"')) relayed.push(line);
  });
  const socket: ClientSocket = {
    send: (raw) => ws.send(raw),
    onMessage: (cb) =>
      ws.addEventListener("message", (e) =>
        cb(dec.decode(toU8((e as MessageEvent).data))),
      ),
    onOpen: (cb) => cb(), // already open
    onClose: (cb) => ws.addEventListener("close", (e) => cb(e.code)),
    close: () => ws.close(),
  };

  const store = new AppStore();
  const sawSession = new Promise<void>((resolve) => {
    store.subscribe(() => {
      if (store.tree()[0]?.projects[0]?.sessions[0]?.id === "s1") resolve();
    });
  });

  new PhoneClient(
    () => socket,
    [{ machineId, keys: phoneKeys }],
    store,
  ).start();
  await sawSession;

  // The tree assembled from the sealed snapshot.
  const machine = store.tree().find((m) => m.machineId === machineId);
  expect(machine?.projects[0]?.project).toBe("quant");
  expect(machine?.projects[0]?.sessions[0]?.id).toBe("s1");

  // Blind proof: every line the aggregator relayed to the phone (the ack and
  // the snapshot) is an opaque sealed envelope — never the session cwd/project
  // plaintext.
  expect(relayed.length).toBeGreaterThan(0);
  for (const line of relayed) {
    expect(line).not.toContain("/secret/quant");
    const wire = JSON.parse(line);
    expect(wire.route).toBe(machineId);
    expect(wire.t).toBeUndefined();
    expect(typeof wire.ct).toBe("string");
  }
});
