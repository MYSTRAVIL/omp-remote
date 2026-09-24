import { expect, test } from "bun:test";
import {
  type SessionKeys,
  clientSessionKeys,
  newIdentity,
  serverSessionKeys,
} from "@omp-remote/crypto";
import type { SessionMeta } from "@omp-remote/protocol";
import { type ClientSocket, PhoneClient } from "../src/core/client";
import { AppStore } from "../src/core/store";
import { FakeAgent } from "./fixtures/fake-agent";

const meta: SessionMeta = {
  id: "s1",
  cwd: "/secret/project",
  project: "project",
  model: "m",
  title: "T",
  pid: 3,
  startedAt: 0,
};

/** A ClientSocket test double: records outbound lines, injects inbound ones. */
class FakeSocket implements ClientSocket {
  readonly sent: string[] = [];
  #onMessage: ((raw: string) => void) | undefined;
  #onOpen: (() => void) | undefined;
  #onClose: ((code: number) => void) | undefined;
  send(raw: string): void {
    this.sent.push(raw);
  }
  onMessage(cb: (raw: string) => void): void {
    this.#onMessage = cb;
  }
  onOpen(cb: () => void): void {
    this.#onOpen = cb;
  }
  onClose(cb: (code: number) => void): void {
    this.#onClose = cb;
  }
  close(): void {
    this.#onClose?.(1000);
  }
  fireOpen(): void {
    this.#onOpen?.();
  }
  deliver(raw: string): void {
    this.#onMessage?.(raw);
  }
}

/** The sealed lines among what the client sent. */
function sealedLines(sock: FakeSocket): string[] {
  return sock.sent.filter((l) => l.includes('"route"'));
}

async function pair(): Promise<{ phone: SessionKeys; agent: SessionKeys }> {
  const phoneId = await newIdentity();
  const agentId = await newIdentity();
  return {
    phone: await clientSessionKeys(phoneId, agentId.publicKey),
    agent: await serverSessionKeys(agentId, phoneId.publicKey),
  };
}

test("on open the client attaches and says a sealed hello per machine; the agent's ack pulls one sealed sync", async () => {
  const { phone, agent } = await pair();
  const store = new AppStore();
  const sock = new FakeSocket();
  new PhoneClient(
    () => sock,
    [{ machineId: "m1", keys: phone }],
    store,
  ).start();
  sock.fireOpen();

  // An attach control for the machine, then one sealed line (the hello): no
  // sync goes out before the agent answers.
  expect(sock.sent).toContainEqual(
    JSON.stringify({ type: "attach", machineId: "m1" }),
  );
  expect(sealedLines(sock)).toHaveLength(1);

  // The paired agent acks the hello, and the ack pulls exactly one sealed
  // sync request, which the agent opens.
  const m1 = new FakeAgent(agent, "m1");
  m1.connect(sock);
  m1.relay();
  expect(m1.frames).toEqual([{ t: "sync" }]);

  // Both lines are opaque: the clear route, never a plaintext frame type.
  const sealed = sealedLines(sock);
  expect(sealed).toHaveLength(2);
  for (const line of sealed) {
    const wire = JSON.parse(line);
    expect(wire.route).toBe("m1");
    expect(wire.t).toBeUndefined();
    expect(typeof wire.ct).toBe("string");
  }
});

test("two acks from the same agent epoch on one socket pull one sync, not two full replays", async () => {
  const { phone, agent } = await pair();
  const store = new AppStore();
  const sock = new FakeSocket();
  new PhoneClient(
    () => sock,
    [{ machineId: "m1", keys: phone }],
    store,
  ).start();
  sock.fireOpen();

  // A live broadcast reaches the page before the agent's ack: the channel
  // does not know the agent's epoch yet, so it says a second hello.
  const m1 = new FakeAgent(agent, "m1");
  sock.deliver(m1.seal({ t: "sessions", sessions: [meta] }));
  expect(sealedLines(sock)).toHaveLength(2);

  // The agent acks both hellos; the channel accepts both, yet one sync goes out.
  m1.connect(sock);
  m1.relay();
  expect(m1.frames).toEqual([{ t: "sync" }]);
});

test("a sealed snapshot for a machine populates its tree; foreign lines drop", async () => {
  const { phone, agent } = await pair();
  const other = await pair();
  const store = new AppStore();
  const sock = new FakeSocket();
  const client = new PhoneClient(
    () => sock,
    [{ machineId: "m1", keys: phone }],
    store,
  );
  client.start();
  sock.fireOpen();
  // The paired agent acks the hello, so the channel opens what it seals.
  const m1 = new FakeAgent(agent, "m1");
  m1.connect(sock);
  m1.relay();

  // The aggregator tells the phone which machines are live.
  sock.deliver(JSON.stringify({ type: "machines", machineIds: ["m1"] }));
  expect(store.tree().map((m) => m.machineId)).toEqual(["m1"]);

  // A foreign machine's line (wrong key / wrong route) must not corrupt m1.
  const foreign = new FakeAgent(other.agent, "m1");
  sock.deliver(foreign.seal({ t: "sessions", sessions: [meta] }));
  expect(store.tree()[0]?.projects).toEqual([]);

  // The real agent's sealed snapshot lands in the tree.
  sock.deliver(m1.seal({ t: "sessions", sessions: [meta] }));
  expect(store.tree()[0]?.projects[0]?.sessions[0]?.id).toBe("s1");

  // Garbage and unknown-route lines are ignored, never thrown.
  sock.deliver("not json");
  const elsewhere = new FakeAgent(agent, "unknown");
  sock.deliver(elsewhere.seal({ t: "sessions", sessions: [meta] }));
  expect(store.tree()[0]?.projects[0]?.sessions[0]?.id).toBe("s1");
});

test("the relay's live-machine list only brings in machines paired on this phone", async () => {
  const { phone } = await pair();
  const store = new AppStore();
  const sock = new FakeSocket();
  new PhoneClient(
    () => sock,
    [{ machineId: "m1", keys: phone }],
    store,
  ).start();
  sock.fireOpen();
  // m2 is live on the relay but has no pairing here (e.g. it was just
  // forgotten on this device), so it must not come back into the tree.
  sock.deliver(JSON.stringify({ type: "machines", machineIds: ["m1", "m2"] }));
  expect(store.tree().map((m) => m.machineId)).toEqual(["m1"]);
});

test("with no paired machine, opening the socket ends the connecting state", () => {
  // Nothing is attached, so the relay never answers with a machine list; the
  // tree must still leave "Connecting…" for the pair empty state.
  const store = new AppStore();
  const sock = new FakeSocket();
  new PhoneClient(() => sock, [], store).start();
  expect(store.connecting()).toBe(true);
  sock.fireOpen();
  expect(store.connecting()).toBe(false);
  expect(store.tree()).toEqual([]);
});

test("each machine's channel, once ready, is told that machine's away time along with the sync", async () => {
  const one = await pair();
  const two = await pair();
  const chosen = new Map([["m1", 300]]);
  const sock = new FakeSocket();
  new PhoneClient(
    () => sock,
    [
      { machineId: "m1", keys: one.phone },
      { machineId: "m2", keys: two.phone },
    ],
    new AppStore(),
    { notifyAwaySec: (machineId) => chosen.get(machineId) ?? 120 },
  ).start();
  sock.fireOpen();
  const m1 = new FakeAgent(one.agent, "m1");
  const m2 = new FakeAgent(two.agent, "m2");
  m1.connect(sock);
  m2.connect(sock);
  m1.relay();
  m2.relay();
  expect(m1.frames).toEqual([
    { t: "sync" },
    { t: "notifyPolicy", awaySec: 300 },
  ]);
  expect(m2.frames).toEqual([
    { t: "sync" },
    { t: "notifyPolicy", awaySec: 120 },
  ]);
});

test("a new away time goes to its machine at once when its channel is ready, else with the next ready", async () => {
  const { phone, agent } = await pair();
  let awaySec = 120;
  const sock = new FakeSocket();
  const client = new PhoneClient(
    () => sock,
    [{ machineId: "m1", keys: phone }],
    new AppStore(),
    { notifyAwaySec: () => awaySec },
  );
  client.start();
  sock.fireOpen();

  // Chosen before the agent answered: the ready tells it, once.
  awaySec = 60;
  client.sendNotifyPolicy("m1");
  const m1 = new FakeAgent(agent, "m1");
  m1.connect(sock);
  m1.relay();
  expect(m1.frames).toEqual([
    { t: "sync" },
    { t: "notifyPolicy", awaySec: 60 },
  ]);

  // Chosen while connected: it goes at once.
  awaySec = 0;
  client.sendNotifyPolicy("m1");
  m1.relay();
  expect(m1.frames).toEqual([
    { t: "sync" },
    { t: "notifyPolicy", awaySec: 60 },
    { t: "notifyPolicy", awaySec: 0 },
  ]);
});
