import { expect, test } from "bun:test";
import { type SealedFrame, SealedWireEnvelope } from "@omp-remote/protocol";
import {
  BlindRelay,
  type ByteSink,
  SealedChannel,
  type SealedChannelOptions,
  type SealedRejectReason,
  type SessionKeys,
  clientSessionKeys,
  newIdentity,
  serverSessionKeys,
} from "../src/index";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ROUTE = "r1";

async function pairKeys(): Promise<{ phone: SessionKeys; agent: SessionKeys }> {
  const phoneId = await newIdentity();
  const agentId = await newIdentity();
  return {
    phone: await clientSessionKeys(phoneId, agentId.publicKey),
    agent: await serverSessionKeys(agentId, phoneId.publicKey),
  };
}

/** A distinguishable frame. The channel carries any `SealedFrame` either way. */
function frame(sessionId: string): SealedFrame {
  return { t: "interrupt", sessionId };
}

/**
 * A hand-driven `ByteSink`: it keeps every line its channel writes until the
 * test takes them, and feeds lines in as the relay would. The test decides what
 * arrives, in what order, and what gets replayed.
 */
class HandSink implements ByteSink {
  #out: string[] = [];
  #deliver: ((b: Uint8Array) => void) | undefined;
  send(bytes: Uint8Array): void {
    this.#out.push(dec.decode(bytes));
  }
  onBytes(cb: (b: Uint8Array) => void): void {
    this.#deliver = cb;
  }
  /** Every line written since the last take. */
  take(): string[] {
    return this.#out.splice(0);
  }
  feed(lines: readonly string[]): void {
    for (const line of lines) this.#deliver?.(enc.encode(line));
  }
}

/** A channel on a hand-driven sink, with what it delivered, dropped and verified. */
interface End {
  ch: SealedChannel;
  wire: HandSink;
  frames: SealedFrame[];
  rejects: SealedRejectReason[];
  ready: string[];
}

function end(
  keys: SessionKeys,
  options: Omit<SealedChannelOptions, "onReject">,
): End {
  const wire = new HandSink();
  const rejects: SealedRejectReason[] = [];
  const ch = new SealedChannel(keys, wire, ROUTE, {
    ...options,
    onReject: (reason) => rejects.push(reason),
  });
  const frames: SealedFrame[] = [];
  const ready: string[] = [];
  ch.onFrame((f) => frames.push(f));
  ch.onReady((epoch) => ready.push(epoch));
  return { ch, wire, frames, rejects, ready };
}

/** Relay every line `from` wrote to each of `to`; returns the lines for replay. */
function pump(from: End, ...to: End[]): string[] {
  const lines = from.wire.take();
  for (const peer of to) peer.wire.feed(lines);
  return lines;
}

/** One hello → ack round between an initiator and its responder. */
function handshake(phone: End, agent: End): void {
  phone.ch.hello();
  pump(phone, agent);
  pump(agent, phone);
}

/** The clear header of a relayed line: all the relay can read. */
function header(line: string | undefined): SealedWireEnvelope {
  if (line === undefined) throw new Error("no line relayed");
  return SealedWireEnvelope.parse(JSON.parse(line));
}

function kinds(lines: readonly string[]): string[] {
  return lines.map((line) => header(line).k);
}

test("a frame sealed by one end decodes at the other; relay stays blind", async () => {
  const keys = await pairKeys();
  const relay = new BlindRelay();
  const client = new SealedChannel(keys.phone, relay.endpoint(ROUTE), ROUTE, {
    role: "initiator",
  });
  const server = new SealedChannel(keys.agent, relay.endpoint(ROUTE), ROUTE, {
    role: "responder",
  });

  const { promise, resolve } = Promise.withResolvers<SealedFrame>();
  server.onFrame(resolve);
  const prompt: SealedFrame = {
    t: "prompt",
    sessionId: "s1",
    text: "top-secret-prompt",
    mode: "steer",
  };
  client.hello();
  client.sendFrame(prompt);

  expect(await promise).toEqual(prompt);

  // The relay observed bytes, but none reveal the plaintext or parse as a frame.
  expect(relay.observed.length).toBeGreaterThan(0);
  for (const bytes of relay.observed) {
    const text = dec.decode(bytes);
    expect(text).not.toContain("top-secret-prompt");
    const wire = JSON.parse(text.trim());
    expect(wire.t).toBeUndefined(); // a sealed v2 envelope, not a frame
    expect(SealedWireEnvelope.safeParse(wire).success).toBe(true);
  }
});

test("an initiator's frames wait for the ack to its hello, then flush in order before onReady", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const agent = end(keys.agent, { role: "responder" });
  phone.ch.onReady(() => phone.ch.sendFrame({ t: "sync" }));

  // No agent epoch is verified yet: the frames wait, nothing is written.
  phone.ch.sendFrame(frame("p1"));
  phone.ch.sendFrame(frame("p2"));
  expect(phone.wire.take()).toEqual([]);

  phone.ch.hello();
  pump(phone, agent);
  const ack = pump(agent, phone);
  expect(kinds(ack)).toEqual(["a"]);
  expect(phone.ready).toEqual([header(ack[0]).e]);
  pump(phone, agent);
  expect(agent.frames).toEqual([frame("p1"), frame("p2"), { t: "sync" }]);

  // Bound: both directions deliver.
  phone.ch.sendFrame(frame("p3"));
  pump(phone, agent);
  agent.ch.sendFrame(frame("a1"));
  pump(agent, phone);
  expect(agent.frames.at(-1)).toEqual(frame("p3"));
  expect(phone.frames).toEqual([frame("a1")]);
  expect([...phone.rejects, ...agent.rejects]).toEqual([]);
});

test("frames held past maxPending drop oldest first", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator", maxPending: 2 });
  const agent = end(keys.agent, { role: "responder" });
  phone.ch.sendFrame(frame("p1"));
  phone.ch.sendFrame(frame("p2"));
  phone.ch.sendFrame(frame("p3"));
  handshake(phone, agent);
  pump(phone, agent);
  expect(agent.frames).toEqual([frame("p2"), frame("p3")]);
});

test("a relay that flips a byte causes the frame to be dropped", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const agent = end(keys.agent, { role: "responder" });
  handshake(phone, agent);

  phone.ch.sendFrame({ t: "interrupt", sessionId: "s1" });
  const sent = phone.wire.take();
  const wire = header(sent[0]);
  // Tampering relay: mangle the ciphertext field of the forwarded envelope.
  const ct = `${wire.ct.slice(0, -2)}${wire.ct.endsWith("A") ? "B" : "A"}`;
  agent.wire.feed([JSON.stringify({ ...wire, ct })]);
  expect(agent.frames).toEqual([]);
  expect(agent.rejects).toEqual(["auth-failed"]);

  // The untouched envelope still opens: only the mangled one was refused.
  agent.wire.feed(sent);
  expect(agent.frames).toEqual([{ t: "interrupt", sessionId: "s1" }]);
});

test("editing any clear header field makes the line fail authentication", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const agent = end(keys.agent, { role: "responder" });
  handshake(phone, agent);
  phone.ch.sendFrame(frame("p1"));
  const sent = phone.wire.take();
  const wire = header(sent[0]);

  // Unauthenticated, each edit would land otherwise: a later counter delivers,
  // an unknown sender or stale binding is refused for that, a hello is acked.
  const other = "A".repeat(22);
  const edits: Partial<SealedWireEnvelope>[] = [
    { c: wire.c + 1 },
    { e: other },
    { a: other },
    { k: "h" },
  ];
  for (const edit of edits)
    agent.wire.feed([JSON.stringify({ ...wire, ...edit })]);
  expect(agent.rejects).toEqual([
    "auth-failed",
    "auth-failed",
    "auth-failed",
    "auth-failed",
  ]);
  expect(agent.frames).toEqual([]);
  expect(agent.wire.take()).toEqual([]);

  agent.wire.feed(sent);
  expect(agent.frames).toEqual([frame("p1")]);
});

test("a phone frame replayed to the same agent is dropped", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const agent = end(keys.agent, { role: "responder" });
  handshake(phone, agent);
  phone.ch.sendFrame(frame("p1"));
  const recorded = pump(phone, agent);

  agent.wire.feed(recorded);
  expect(agent.frames).toEqual([frame("p1")]);
  expect(agent.rejects).toEqual(["replayed"]);
});

test("a phone frame recorded against one agent instance is refused by the next, which nudges once", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const first = end(keys.agent, { role: "responder" });
  handshake(phone, first);
  phone.ch.sendFrame(frame("p1"));
  const recorded = pump(phone, first);

  // The agent restarted: same keys, a new epoch the recording is not bound to.
  const next = end(keys.agent, { role: "responder" });
  next.wire.feed(recorded);
  next.wire.feed(recorded);
  expect(next.frames).toEqual([]);
  expect(next.rejects).toEqual(["stale-epoch", "stale-epoch"]);
  // One hello for that phone instance, not one per stale line.
  expect(kinds(next.wire.take())).toEqual(["h"]);
});

test("an agent frame replayed to the same phone is dropped", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const agent = end(keys.agent, { role: "responder" });
  handshake(phone, agent);
  agent.ch.sendFrame(frame("a1"));
  const recorded = pump(agent, phone);

  phone.wire.feed(recorded);
  expect(phone.frames).toEqual([frame("a1")]);
  expect(phone.rejects).toEqual(["replayed"]);
});

test("a recorded agent stream never reaches a fresh phone instance", async () => {
  const keys = await pairKeys();
  const agent = end(keys.agent, { role: "responder" });
  const earlier = end(keys.phone, { role: "initiator" });
  earlier.ch.hello();
  pump(earlier, agent);
  agent.ch.sendFrame(frame("a1"));
  agent.ch.sendFrame(frame("a2"));
  const recorded = pump(agent, earlier); // its ack, then a1 and a2
  expect(earlier.frames).toEqual([frame("a1"), frame("a2")]);

  // A reloaded page: same keys, a fresh epoch. The recorded ack is bound to the
  // earlier epoch, so nothing in the recording verifies the agent's.
  const fresh = end(keys.phone, { role: "initiator" });
  fresh.wire.feed(recorded);
  expect(fresh.ready).toEqual([]);
  expect(fresh.frames).toEqual([]);

  // Its own handshake verifies the same live epoch, past the recorded counters.
  pump(fresh, agent); // the hello the unverified stream prompted
  pump(agent, fresh);
  expect(fresh.ready).toEqual(earlier.ready);
  fresh.wire.feed(recorded);
  agent.ch.sendFrame(frame("a3"));
  pump(agent, fresh);
  expect(fresh.frames).toEqual([frame("a3")]);
  expect(fresh.rejects).toEqual([
    "unknown-peer",
    "unknown-peer",
    "replayed",
    "replayed",
  ]);
});

test("an old agent's ack and stream replayed after the phone re-handshakes are never delivered", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const first = end(keys.agent, { role: "responder" });
  phone.ch.hello();
  pump(phone, first);
  first.ch.sendFrame(frame("a1"));
  first.ch.sendFrame(frame("a2"));
  const recorded = pump(first, phone); // its ack, then a1 and a2
  first.ch.close();

  // The agent restarts; the new instance's uplink hello makes the phone re-handshake.
  const next = end(keys.agent, { role: "responder" });
  next.ch.hello();
  pump(next, phone);
  pump(phone, next);
  pump(next, phone);
  expect(phone.ready).toHaveLength(2);

  // The relay replays the first agent's ack and stream. The ack answers an
  // older hello, so the phone stays bound to the live agent, and the old
  // stream's epoch stays unverified.
  phone.wire.feed(recorded);
  expect(phone.ready).toHaveLength(2);
  expect(phone.frames).toEqual([frame("a1"), frame("a2")]);
  expect(phone.rejects).toEqual(["replayed", "unknown-peer", "unknown-peer"]);

  // Still bound to the live agent: commands reach it, its frames reach the phone.
  phone.ch.sendFrame(frame("p1"));
  pump(phone, next);
  next.ch.sendFrame(frame("b1"));
  pump(next, phone);
  expect(next.frames).toEqual([frame("p1")]);
  expect(phone.frames).toEqual([frame("a1"), frame("a2"), frame("b1")]);
});

test("a replayed phone hello neither re-acks nor resets the agent's counter for it", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const agent = end(keys.agent, { role: "responder" });
  phone.ch.hello();
  const hello = pump(phone, agent);
  pump(agent, phone);
  phone.ch.sendFrame(frame("p1"));
  const data = pump(phone, agent);

  agent.wire.feed(hello);
  expect(agent.wire.take()).toEqual([]);
  // Had the hello reset the counter to its own, the frame recorded after it
  // would pass again.
  agent.wire.feed(data);
  expect(agent.frames).toEqual([frame("p1")]);
  expect(agent.rejects).toEqual(["replayed", "replayed"]);
});

test("an ack the relay holds back until after later frames re-opens none of them", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const agent = end(keys.agent, { role: "responder" });
  handshake(phone, agent);
  agent.ch.sendFrame(frame("d1"));
  pump(agent, phone);

  // The phone says hello again (its socket reopened). The relay holds the ack
  // back and forwards the agent's later frames first.
  phone.ch.hello();
  pump(phone, agent);
  const ack = agent.wire.take();
  expect(kinds(ack)).toEqual(["a"]);
  agent.ch.sendFrame(frame("d2"));
  agent.ch.sendFrame(frame("d3"));
  const later = pump(agent, phone);

  // Then the held ack, and the later frames again. Had the late ack reset the
  // phone's counter for the verified epoch to its own, they would open twice.
  phone.wire.feed(ack);
  phone.wire.feed(later);
  expect(phone.frames).toEqual([frame("d1"), frame("d2"), frame("d3")]);
  expect(phone.rejects).toEqual(["replayed", "replayed", "replayed"]);
  expect(phone.ready).toHaveLength(1);
});

test("two tabs sharing the phone keys each bind through their own ack, and both work", async () => {
  const keys = await pairKeys();
  const relay = new BlindRelay();
  const agent = new SealedChannel(keys.agent, relay.endpoint(ROUTE), ROUTE, {
    role: "responder",
  });
  const tabA = new SealedChannel(keys.phone, relay.endpoint(ROUTE), ROUTE, {
    role: "initiator",
  });
  const tabB = new SealedChannel(keys.phone, relay.endpoint(ROUTE), ROUTE, {
    role: "initiator",
  });
  const atAgent: SealedFrame[] = [];
  const atA: SealedFrame[] = [];
  const atB: SealedFrame[] = [];
  const readyA: string[] = [];
  const readyB: string[] = [];
  agent.onFrame((f) => atAgent.push(f));
  tabA.onFrame((f) => atA.push(f));
  tabB.onFrame((f) => atB.push(f));
  tabA.onReady((epoch) => readyA.push(epoch));
  tabB.onReady((epoch) => readyB.push(epoch));

  // Tab B's frame waits for B's own ack: A's ack reaches B too, but is not it.
  tabB.sendFrame(frame("b1"));
  tabA.hello();
  expect(readyA).toHaveLength(1);
  expect(readyB).toEqual([]);
  expect(atAgent).toEqual([]);

  tabB.hello();
  expect(readyA).toHaveLength(1);
  expect(readyB).toEqual(readyA);
  expect(atAgent).toEqual([frame("b1")]);

  tabA.sendFrame(frame("a1"));
  agent.sendFrame(frame("s1"));
  expect(atAgent).toEqual([frame("b1"), frame("a1")]);
  expect(atA).toEqual([frame("s1")]);
  expect(atB).toEqual([frame("s1")]);
});

test("after the agent restarts the phone re-hellos once, is acked again, and frames flow", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const first = end(keys.agent, { role: "responder" });
  handshake(phone, first);
  first.ch.close();

  // The new agent's uplink hello and a broadcast both reach the phone before
  // the phone's hello reaches the agent. The broadcast is from an epoch the
  // phone has not verified yet, so it is dropped.
  const next = end(keys.agent, { role: "responder" });
  next.ch.hello();
  next.ch.sendFrame(frame("unverified"));
  pump(next, phone);
  const rehello = phone.wire.take();
  expect(kinds(rehello)).toEqual(["h"]);

  next.wire.feed(rehello);
  pump(next, phone);
  expect(phone.ready).toHaveLength(2);
  expect(phone.ready[1]).not.toBe(phone.ready[0]);

  phone.ch.sendFrame(frame("p1"));
  pump(phone, next);
  next.ch.sendFrame(frame("n1"));
  pump(next, phone);
  expect(next.frames).toEqual([frame("p1")]);
  expect(phone.frames).toEqual([frame("n1")]);

  // A later uplink reconnect announces the verified epoch again: nothing to do.
  next.ch.hello();
  pump(next, phone);
  expect(phone.wire.take()).toEqual([]);
});

test("a phone whose hello to a restarted agent is lost answers the agent's next announcement, and its next prompt lands once", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const first = end(keys.agent, { role: "responder" });
  handshake(phone, first);
  first.ch.close();

  // The new instance announces itself and the phone answers, but the relay
  // loses that hello (say the agent's uplink dropped for a moment).
  const next = end(keys.agent, { role: "responder" });
  next.ch.hello();
  pump(next, phone);
  expect(kinds(phone.wire.take())).toEqual(["h"]);

  // Its uplink reconnects and announces the same epoch again: the phone retries.
  next.ch.hello();
  pump(next, phone);
  expect(kinds(pump(phone, next))).toEqual(["h"]);
  pump(next, phone);
  expect(phone.ready).toHaveLength(2);
  expect(phone.ready[1]).not.toBe(phone.ready[0]);

  // Bound to the live agent: the next prompt lands, and replays of it do not.
  const prompt: SealedFrame = {
    t: "prompt",
    sessionId: "s1",
    text: "ship it",
    mode: "steer",
  };
  phone.ch.sendFrame(prompt);
  const recorded = pump(phone, next);
  next.wire.feed(recorded);
  next.wire.feed(recorded);
  expect(next.frames).toEqual([prompt]);
  expect(next.rejects).toEqual(["replayed", "replayed"]);
});

test("a phone whose ack from a restarted agent is lost is nudged again by its next stale command, and re-binds", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const first = end(keys.agent, { role: "responder" });
  handshake(phone, first);
  first.ch.close();

  // The new instance's announcement never reaches the phone, so its command is
  // still sealed to the dead epoch: refused, and the agent nudges the phone.
  const next = end(keys.agent, { role: "responder" });
  next.ch.hello();
  next.wire.take();
  phone.ch.sendFrame(frame("p1"));
  pump(phone, next);
  pump(next, phone);
  // The phone answers and the agent acks, but the relay loses the ack.
  pump(phone, next);
  expect(kinds(next.wire.take())).toEqual(["a"]);

  // Still bound to the dead epoch, its next command is refused too. The agent
  // nudges again, the phone retries, and this time the ack arrives.
  phone.ch.sendFrame(frame("p2"));
  pump(phone, next);
  expect(kinds(pump(next, phone))).toEqual(["h"]);
  pump(phone, next);
  pump(next, phone);
  expect(phone.ready).toHaveLength(2);
  phone.ch.sendFrame(frame("p3"));
  pump(phone, next);
  expect(next.frames).toEqual([frame("p3")]);
  expect(next.rejects).toEqual(["stale-epoch", "stale-epoch"]);
});

test("a dead agent's hello the relay replays costs the phone one re-handshake, however often it is replayed", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const dead = end(keys.agent, { role: "responder" });
  handshake(phone, dead);
  // The relay records the agent announcing itself and a frame of its stream.
  dead.ch.hello();
  dead.ch.sendFrame(frame("d1"));
  const recorded = pump(dead, phone);
  dead.ch.close();

  // The agent restarts, and the phone binds to the new instance.
  const live = end(keys.agent, { role: "responder" });
  live.ch.hello();
  pump(live, phone);
  pump(phone, live);
  pump(live, phone);
  expect(phone.ready).toHaveLength(2);

  // The phone cannot tell the dead epoch from yet another restart, so the
  // first replay draws a hello. The live agent's ack keeps it bound there.
  phone.wire.feed(recorded);
  expect(kinds(pump(phone, live))).toEqual(["h"]);
  pump(live, phone);
  expect(phone.ready).toHaveLength(3);
  expect(phone.ready[2]).toBe(phone.ready[1]);

  // Replayed again and again, the recording draws nothing more.
  for (let i = 0; i < 5; i++) {
    phone.wire.feed(recorded);
    expect(pump(phone, live)).toEqual([]);
    pump(live, phone);
  }
  expect(phone.ready).toHaveLength(3);
  expect(phone.frames).toEqual([frame("d1")]);
});

test("past maxPeers the agent rotates its epoch: old bindings are refused and live phones re-handshake", async () => {
  const keys = await pairKeys();
  const agent = end(keys.agent, { role: "responder", maxPeers: 2 });
  const closedTab = end(keys.phone, { role: "initiator" });
  const live = end(keys.phone, { role: "initiator" });
  handshake(closedTab, agent);
  closedTab.ch.close();
  handshake(live, agent);
  live.ch.sendFrame(frame("before"));
  pump(live, agent);

  // A third phone instance exceeds maxPeers: the agent rotates, broadcasting a
  // hello for its new epoch, then acks the newcomer.
  const fresh = end(keys.phone, { role: "initiator" });
  fresh.ch.hello();
  pump(fresh, agent);
  // The live tab has not heard of the rotation: its frame is bound to the old epoch.
  live.ch.sendFrame(frame("stale"));
  pump(live, agent);
  expect(agent.frames).toEqual([frame("before")]);
  expect(agent.rejects).toEqual(["stale-epoch"]);

  // Rotation hello, the newcomer's ack, the nudge for the stale frame.
  expect(kinds(pump(agent, live, fresh))).toEqual(["h", "a", "h"]);
  // The live tab answers the rotation hello and then the nudge as well: the
  // nudge is a newer announcement, and to the tab a first hello that crossed
  // it looks the same as one that was lost. Both acks bind it to the new epoch.
  expect(kinds(pump(live, agent))).toEqual(["h", "h"]);
  pump(fresh, agent);
  pump(agent, live, fresh);

  expect(live.ready).toHaveLength(3);
  const [oldEpoch, newEpoch] = live.ready;
  expect(newEpoch).not.toBe(oldEpoch);
  expect(live.ready[2]).toBe(newEpoch);
  expect(fresh.ready.at(-1)).toBe(newEpoch);
  live.ch.sendFrame(frame("after"));
  pump(live, agent);
  expect(agent.frames).toEqual([frame("before"), frame("after")]);
});

test("a closed channel stops emitting inbound frames and refuses to send", async () => {
  const keys = await pairKeys();
  const relay = new BlindRelay();
  const client = new SealedChannel(keys.phone, relay.endpoint(ROUTE), ROUTE, {
    role: "initiator",
  });
  const server = new SealedChannel(keys.agent, relay.endpoint(ROUTE), ROUTE, {
    role: "responder",
  });
  client.hello(); // bound, so the client's frame really goes out

  let delivered = 0;
  server.onFrame(() => {
    delivered++;
  });

  server.close();
  const sent = relay.observed.length;
  client.hello();
  client.sendFrame({ t: "interrupt", sessionId: "s1" });
  // Both went out, but the closed server neither acked the hello nor decoded
  // the frame.
  expect(relay.observed.length).toBe(sent + 2);
  expect(delivered).toBe(0);

  const before = relay.observed.length;
  server.sendFrame({ t: "interrupt", sessionId: "s1" });
  server.hello();
  expect(relay.observed.length).toBe(before); // closed sender writes nothing

  server.close(); // idempotent
});

test("a closed initiator neither flushes its held frames nor answers, even when the ack arrives", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const agent = end(keys.agent, { role: "responder" });
  phone.ch.sendFrame(frame("p1"));
  phone.ch.hello();
  pump(phone, agent);
  phone.ch.close();

  pump(agent, phone); // the ack lands after close
  // A live phone would say hello to a new agent epoch.
  const restarted = end(keys.agent, { role: "responder" });
  restarted.ch.hello();
  pump(restarted, phone);
  expect(phone.ready).toEqual([]);
  expect(phone.wire.take()).toEqual([]);
});

test("lines that are not v2 envelopes are dropped as malformed", async () => {
  const keys = await pairKeys();
  const phone = end(keys.phone, { role: "initiator" });
  const agent = end(keys.agent, { role: "responder" });
  handshake(phone, agent);
  phone.ch.sendFrame(frame("p1"));
  const { route, n, ct } = header(phone.wire.take()[0]);

  // A v1 envelope (no epoch, counter or binding) and clear aggregator control.
  agent.wire.feed([JSON.stringify({ route, n, ct }), '{"type":"pong"}']);
  expect(agent.frames).toEqual([]);
  expect(agent.rejects).toEqual(["malformed", "malformed"]);
});
