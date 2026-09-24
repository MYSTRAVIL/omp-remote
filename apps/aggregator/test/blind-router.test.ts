import { expect, test } from "bun:test";
import { ErrorMsg, MachinesMsg } from "@omp-remote/protocol";
import {
  BlindRouter,
  MAX_ATTACHES_PER_SUBJECT,
  MAX_ROUTES,
  type RouterPeer,
  type RouterPort,
} from "../src/blind-router";

class FakePort implements RouterPort {
  readonly id: string;
  readonly sent: string[] = [];
  closed = false;
  constructor(id: string) {
    this.id = id;
  }
  send(raw: string): void {
    this.sent.push(raw);
  }
  close(): void {
    this.closed = true;
  }
  last(): unknown {
    const raw = this.sent.at(-1);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}

/** A phone socket. */
const CLIENT: RouterPeer = { endpoint: "client" };
/** An `/agent` socket whose token is bound to `machineId`. */
function agentAs(machineId: string): RouterPeer {
  return { endpoint: "agent", machineId };
}
/** An `/agent` socket, for lines where its binding plays no part. */
const AGENT = agentAs("tower");
/** An `/agent` socket bound to a machine other than the route in play. */
const OTHER_AGENT = agentAs("intruder");

function router() {
  return new BlindRouter();
}
function register(
  r: BlindRouter,
  p: RouterPort,
  machineId: string,
  peer: RouterPeer = agentAs(machineId),
) {
  r.handleLine(p, JSON.stringify({ type: "register", machineId }), peer);
}
function attach(
  r: BlindRouter,
  p: RouterPort,
  machineId: string,
  peer: RouterPeer = CLIENT,
) {
  r.handleLine(p, JSON.stringify({ type: "attach", machineId }), peer);
}
function list(r: BlindRouter, p: RouterPort, peer: RouterPeer = CLIENT) {
  r.handleLine(p, JSON.stringify({ type: "list" }), peer);
}
function sealedLine(route: string, marker: string): string {
  // Shape mirrors @omp-remote/crypto's WireEnvelope; ct is opaque to the router.
  return JSON.stringify({ route, n: "nonce", ct: `cipher-${marker}` });
}
/** Every machine list `port` has been sent, in order. */
function machineLists(port: FakePort): string[][] {
  const lists: string[][] = [];
  for (const raw of port.sent) {
    const msg = MachinesMsg.safeParse(JSON.parse(raw));
    if (msg.success) lists.push(msg.data.machineIds);
  }
  return lists;
}

test("list reflects only machines with a live agent", () => {
  const r = router();
  const client = new FakePort("c1");
  list(r, client);
  expect(client.last()).toEqual({ type: "machines", machineIds: [] });

  const agentA = new FakePort("a");
  const agentB = new FakePort("b");
  register(r, agentA, "tower");
  register(r, agentB, "molt");
  list(r, client);
  expect(client.last()).toEqual({
    type: "machines",
    machineIds: ["molt", "tower"],
  });
});

test("an agent registers only the machineId its token is bound to", () => {
  const r = router();
  const phone = new FakePort("phone");
  attach(r, phone, "m2");
  const impostor = new FakePort("impostor");
  register(r, impostor, "m2", agentAs("m1"));
  expect(impostor.last()).toEqual({ type: "error", reason: "unauthorized" });
  expect(impostor.closed).toBe(true);
  expect(r.machineIds()).toEqual([]);
  // It never joined m2's route: nothing it sends reaches m2's phone.
  const forged = sealedLine("m2", "forged");
  r.handleLine(impostor, forged, agentAs("m1"));
  expect(phone.sent).not.toContain(forged);

  const m1 = new FakePort("m1");
  register(r, m1, "m1");
  expect(m1.closed).toBe(false);
  expect(r.machineIds()).toEqual(["m1"]);
});

test("a client can never claim a route: its register is ignored, not answered", () => {
  const r = router();
  const phone = new FakePort("phone");
  register(r, phone, "tower", CLIENT);
  expect(phone.sent).toEqual([]);
  expect(phone.closed).toBe(false);
  expect(r.machineIds()).toEqual([]);
});

test("attach to an unknown machine yields an empty list, not a crash", () => {
  const r = router();
  const client = new FakePort("c");
  expect(() => attach(r, client, "ghost")).not.toThrow();
  expect(client.last()).toEqual({ type: "machines", machineIds: [] });
  // A data line to a machine with no agent is silently dropped, not thrown.
  expect(() =>
    r.handleLine(client, sealedLine("ghost", "x"), CLIENT),
  ).not.toThrow();
});

test("sealed lines forward verbatim between agent and clients, excluding the sender", () => {
  const r = router();
  const agent = new FakePort("agent");
  const phone1 = new FakePort("p1");
  const phone2 = new FakePort("p2");
  register(r, agent, "tower");
  attach(r, phone1, "tower");
  attach(r, phone2, "tower");

  const up = sealedLine("tower", "from-client");
  r.handleLine(phone1, up, CLIENT);
  // Agent receives it; the sending phone does not; the other phone does not
  // (client→agent direction only reaches the agent).
  expect(agent.sent).toContain(up);
  expect(phone1.sent).not.toContain(up);
  expect(phone2.sent).not.toContain(up);

  const down = sealedLine("tower", "from-agent");
  r.handleLine(agent, down, AGENT);
  // Both phones receive an agent broadcast; the agent does not echo to itself.
  expect(phone1.sent).toContain(down);
  expect(phone2.sent).toContain(down);
  expect(agent.sent).not.toContain(down);
});

test("routes are isolated: machine A traffic never reaches machine B clients", () => {
  const r = router();
  const agentA = new FakePort("aA");
  const agentB = new FakePort("aB");
  const clientB = new FakePort("cB");
  register(r, agentA, "A");
  register(r, agentB, "B");
  attach(r, clientB, "B");

  const line = sealedLine("A", "secret-A");
  r.handleLine(agentA, line, AGENT);
  expect(clientB.sent).not.toContain(line);
  expect(agentB.sent).not.toContain(line);
});

test("a registered agent cannot inject into another machine's route", () => {
  const r = router();
  const agentA = new FakePort("aA");
  const agentB = new FakePort("aB");
  const clientB = new FakePort("cB");
  register(r, agentA, "A");
  register(r, agentB, "B");
  attach(r, clientB, "B");

  // Agent A addresses route B: it is not B's agent, so B's phone must not see
  // it as agent output, and B's agent must not see it as phone input.
  const forged = sealedLine("B", "forged-by-A");
  r.handleLine(agentA, forged, AGENT);
  expect(clientB.sent).not.toContain(forged);
  expect(agentB.sent).not.toContain(forged);
});

test("an agent socket can neither list nor attach, so it never receives a route's traffic", () => {
  const r = router();
  const agent = new FakePort("agent");
  const phone = new FakePort("phone");
  register(r, agent, "tower");
  attach(r, phone, "tower");

  const snoops = [
    { port: new FakePort("authed"), peer: AGENT },
    { port: new FakePort("other"), peer: OTHER_AGENT },
  ];
  for (const { port, peer } of snoops) {
    list(r, port, peer);
    attach(r, port, "tower", peer);
    expect(port.sent).toEqual([]); // no machines reply, no error either
  }

  const down = sealedLine("tower", "for-phones-only");
  r.handleLine(agent, down, AGENT);
  expect(phone.sent).toContain(down);
  for (const { port } of snoops) expect(port.sent).toEqual([]);
});

test("an unregistered agent socket's envelope is not delivered", () => {
  const r = router();
  const agent = new FakePort("agent");
  const phone = new FakePort("phone");
  register(r, agent, "tower");
  attach(r, phone, "tower");

  const intruders = [
    { port: new FakePort("authed"), peer: AGENT },
    { port: new FakePort("other"), peer: OTHER_AGENT },
  ];
  for (const { port, peer } of intruders) {
    const injected = sealedLine("tower", `injected-by-${port.id}`);
    r.handleLine(port, injected, peer);
    expect(agent.sent).not.toContain(injected);
    expect(phone.sent).not.toContain(injected);
  }
});

test("a client that has not attached cannot inject an envelope into a route", () => {
  const r = router();
  const agent = new FakePort("agent");
  const attached = new FakePort("attached");
  const stranger = new FakePort("stranger");
  register(r, agent, "tower");
  attach(r, attached, "tower");

  const injected = sealedLine("tower", "from-stranger");
  r.handleLine(stranger, injected, CLIENT);
  expect(agent.sent).not.toContain(injected);

  const legit = sealedLine("tower", "from-attached");
  r.handleLine(attached, legit, CLIENT);
  expect(agent.sent).toEqual([legit]);
});

test("the router reads only route/type — it never parses the sealed payload", () => {
  const r = router();
  const agent = new FakePort("agent");
  const phone = new FakePort("phone");
  register(r, agent, "tower");
  attach(r, phone, "tower");

  // A payload whose ct is deliberately NOT valid JSON: a content-reading relay
  // would choke; a blind one forwards it verbatim.
  const raw = `{"route":"tower","n":"n","ct":"@@@not-json@@@"}`;
  expect(() => r.handleLine(phone, raw, CLIENT)).not.toThrow();
  expect(agent.sent).toEqual([raw]);
});

test("disconnect clears the agent slot and prunes the route", () => {
  const r = router();
  const agent = new FakePort("agent");
  register(r, agent, "tower");
  expect(r.machineIds()).toEqual(["tower"]);

  r.disconnect(agent);
  expect(r.machineIds()).toEqual([]);

  // A client that later attaches sees no machines and gets no stale delivery.
  const phone = new FakePort("phone");
  attach(r, phone, "tower");
  expect(phone.last()).toEqual({ type: "machines", machineIds: [] });
});

test("agent disconnect stops delivery to it; a reconnect re-registers", () => {
  const r = router();
  const agent1 = new FakePort("agent1");
  const phone = new FakePort("phone");
  register(r, agent1, "tower");
  attach(r, phone, "tower");

  r.disconnect(agent1);
  const orphan = sealedLine("tower", "orphan");
  r.handleLine(phone, orphan, CLIENT);
  expect(agent1.sent).not.toContain(orphan);

  const agent2 = new FakePort("agent2");
  register(r, agent2, "tower");
  const live = sealedLine("tower", "live");
  r.handleLine(phone, live, CLIENT);
  expect(agent2.sent).toContain(live);
});

test("a stale agent disconnecting after a reconnect does not clear the new agent", () => {
  const r = router();
  const agent1 = new FakePort("agent1");
  const agent2 = new FakePort("agent2");
  register(r, agent1, "tower");
  register(r, agent2, "tower"); // reconnect replaces the slot
  r.disconnect(agent1); // late close of the old socket
  expect(r.machineIds()).toEqual(["tower"]);

  const phone = new FakePort("phone");
  attach(r, phone, "tower");
  const line = sealedLine("tower", "x");
  r.handleLine(phone, line, CLIENT);
  expect(agent2.sent).toContain(line);
});

test("malformed and partial control lines never throw", () => {
  const r = router();
  for (const peer of [CLIENT, AGENT, OTHER_AGENT]) {
    const p = new FakePort("p");
    for (const line of [
      "not json",
      JSON.stringify({ type: "register" }),
      JSON.stringify({ type: "bogus" }),
      JSON.stringify({ foo: "bar" }),
    ])
      expect(() => r.handleLine(p, line, peer)).not.toThrow();
    expect(p.sent).toEqual([]); // nothing actionable → no reply
  }
});

test("a ping is answered with a pong on either endpoint (content-blind keepalive)", () => {
  const r = router();
  for (const peer of [CLIENT, AGENT]) {
    const p = new FakePort("p");
    r.handleLine(p, JSON.stringify({ type: "ping" }), peer);
    expect(p.last()).toEqual({ type: "pong" });
  }
});

test("re-registering a machineId closes the stale agent and it can no longer forward", () => {
  const r = router();
  const agent1 = new FakePort("agent1");
  const agent2 = new FakePort("agent2");
  register(r, agent1, "tower");
  register(r, agent2, "tower"); // new generation supersedes agent1
  // The stale socket is closed so a lingering old uplink stops injecting frames.
  expect(agent1.closed).toBe(true);
  expect(agent2.closed).toBe(false);

  const phone = new FakePort("phone");
  attach(r, phone, "tower");
  // The new agent's broadcast reaches the phone...
  const fromNew = sealedLine("tower", "new");
  r.handleLine(agent2, fromNew, AGENT);
  expect(phone.sent).toContain(fromNew);
  // ...but the stale agent can no longer forward to the phone, nor into the
  // new agent as if it were a phone.
  phone.sent.length = 0;
  const fromStale = sealedLine("tower", "stale");
  r.handleLine(agent1, fromStale, AGENT);
  expect(phone.sent).toEqual([]);
  expect(agent2.sent).not.toContain(fromStale);
  expect(r.machineIds()).toEqual(["tower"]);
});

test("phones attached to a machine hear its agent register and drop; phones on other routes hear nothing", () => {
  const r = router();
  const phone = new FakePort("phone");
  const elsewhere = new FakePort("elsewhere");
  attach(r, phone, "tower");
  attach(r, elsewhere, "molt");

  const agent = new FakePort("agent");
  register(r, agent, "tower");
  r.disconnect(agent);
  // A new agent generation supersedes another; the stale socket's late close
  // leaves the machine online, so it tells nobody anything.
  const agent1 = new FakePort("agent1");
  const agent2 = new FakePort("agent2");
  register(r, agent1, "tower");
  register(r, agent2, "tower");
  r.disconnect(agent1);

  expect(machineLists(phone)).toEqual([
    [], // its attach
    ["tower"], // the agent registered
    [], // ...and dropped
    ["tower"], // agent1 registered
    ["tower"], // agent2 superseded it
  ]);
  expect(machineLists(elsewhere)).toEqual([[]]);
});

test("an attached phone's envelope to a machine with no live agent is answered with the machine list, not forwarded", () => {
  const r = router();
  const molt = new FakePort("molt-agent");
  register(r, molt, "molt");
  const phone = new FakePort("phone");
  attach(r, phone, "tower");
  phone.sent.length = 0;

  r.handleLine(phone, sealedLine("tower", "prompt"), CLIENT);
  expect(phone.sent).toEqual([
    JSON.stringify({ type: "machines", machineIds: ["molt"] }),
  ]);
  expect(molt.sent).toEqual([]);

  // With the machine's agent back, the envelope reaches it and nothing returns.
  const tower = new FakePort("tower-agent");
  register(r, tower, "tower");
  phone.sent.length = 0;
  const line = sealedLine("tower", "prompt-again");
  r.handleLine(phone, line, CLIENT);
  expect(tower.sent).toEqual([line]);
  expect(phone.sent).toEqual([]);
});

test("an agent socket never hears a machine list: not on registers or drops, when superseded, nor for an envelope on an agent-less route", () => {
  const r = router();
  const phone = new FakePort("phone");
  attach(r, phone, "tower");
  const molt = new FakePort("molt-agent");
  const tower = new FakePort("tower-agent");
  const headerless = new FakePort("headerless");
  register(r, molt, "molt");
  register(r, tower, "tower");
  register(r, headerless, "tower"); // supersedes `tower`
  r.disconnect(tower);
  r.disconnect(headerless);
  // Tower's route is now agent-less; an agent's envelope there is dropped.
  r.handleLine(molt, sealedLine("tower", "from-molt"), AGENT);

  for (const agent of [molt, tower, headerless])
    expect({ agent: agent.id, lists: machineLists(agent) }).toEqual({
      agent: agent.id,
      lists: [],
    });
  // The phone heard every change to its machine; molt was online throughout.
  expect(machineLists(phone)).toEqual([
    [], // its attach
    ["molt", "tower"], // tower's agent registered
    ["molt", "tower"], // the header-less one superseded it
    ["molt"], // ...and dropped
  ]);
});

test("a phone attaches to at most MAX_ATTACHES_PER_SUBJECT machines; one more is refused and joins nothing", () => {
  const r = router();
  const phone = new FakePort("phone");
  for (let i = 0; i < MAX_ATTACHES_PER_SUBJECT; i++) attach(r, phone, `m${i}`);
  expect(machineLists(phone)).toHaveLength(MAX_ATTACHES_PER_SUBJECT);
  expect(r.routeCount).toBe(MAX_ATTACHES_PER_SUBJECT);

  attach(r, phone, "one-too-many");
  expect(ErrorMsg.safeParse(phone.last()).success).toBe(true);
  expect(phone.closed).toBe(false);
  expect(r.routeCount).toBe(MAX_ATTACHES_PER_SUBJECT);

  // Not on the route: the phone never hears its machine come online, and its
  // envelopes never reach that machine's agent.
  const heard = phone.sent.length;
  const agent = new FakePort("agent");
  register(r, agent, "one-too-many");
  r.handleLine(phone, sealedLine("one-too-many", "x"), CLIENT);
  expect(phone.sent).toHaveLength(heard);
  expect(agent.sent).toEqual([]);

  // Re-attaching a route it holds is no new attach; another phone, without
  // a signed-in subject, has its own allowance.
  attach(r, phone, "m0");
  expect(MachinesMsg.safeParse(phone.last()).success).toBe(true);
  const other = new FakePort("other");
  attach(r, other, "one-too-many");
  expect(other.last()).toEqual({
    type: "machines",
    machineIds: ["one-too-many"],
  });
});

test("one signed-in subject's attaches count across all its sockets; another subject, and a closed socket's share, are its own", () => {
  const r = router();
  const alice: RouterPeer = { endpoint: "client", subject: "alice" };
  const bob: RouterPeer = { endpoint: "client", subject: "bob" };
  const tab1 = new FakePort("alice-1");
  const tab2 = new FakePort("alice-2");
  const half = MAX_ATTACHES_PER_SUBJECT / 2;
  for (let i = 0; i < half; i++) attach(r, tab1, `a${i}`, alice);
  // The second socket may join the first one's routes, and those count too.
  for (let i = 0; i < half; i++) attach(r, tab2, `a${i}`, alice);
  expect(MachinesMsg.safeParse(tab2.last()).success).toBe(true);

  attach(r, tab2, "one-too-many", alice);
  expect(ErrorMsg.safeParse(tab2.last()).success).toBe(true);
  expect(tab2.closed).toBe(false);
  attach(r, new FakePort("alice-3"), "one-too-many", alice);
  expect(r.routeCount).toBe(half);
  // Re-attaching a held route is no new attach.
  attach(r, tab1, "a0", alice);
  expect(MachinesMsg.safeParse(tab1.last()).success).toBe(true);

  // Another subject is untouched.
  const bobTab = new FakePort("bob-1");
  attach(r, bobTab, "one-too-many", bob);
  expect(bobTab.last()).toEqual({ type: "machines", machineIds: [] });

  // A closed socket gives its attaches back to its subject.
  r.disconnect(tab1);
  const tab4 = new FakePort("alice-4");
  attach(r, tab4, "fresh", alice);
  expect(tab4.last()).toEqual({ type: "machines", machineIds: [] });
});

test("attaches stop creating routes at MAX_ROUTES, yet join existing routes, and an agent always registers", () => {
  const r = router();
  const tower = new FakePort("tower-agent");
  register(r, tower, "tower");
  // Phones fill the table with routes to machines no agent serves.
  let room = MAX_ROUTES - r.routeCount;
  for (let p = 0; room > 0; p++) {
    const filler = new FakePort(`filler-${p}`);
    for (let i = 0; i < MAX_ATTACHES_PER_SUBJECT && room > 0; i++) {
      attach(r, filler, `ghost-${p}-${i}`);
      room--;
    }
  }
  expect(r.routeCount).toBe(MAX_ROUTES);

  const phone = new FakePort("phone");
  attach(r, phone, "one-more-ghost");
  expect(ErrorMsg.safeParse(phone.last()).success).toBe(true);
  expect(r.routeCount).toBe(MAX_ROUTES);

  // Joining the registered machine's route takes no room and works end to end.
  attach(r, phone, "tower");
  expect(phone.last()).toEqual({ type: "machines", machineIds: ["tower"] });
  const up = sealedLine("tower", "from-phone");
  r.handleLine(phone, up, CLIENT);
  expect(tower.sent).toEqual([up]);

  // An agent is never capped, and no route gave way for it.
  const laptop = new FakePort("laptop-agent");
  register(r, laptop, "laptop");
  expect(laptop.closed).toBe(false);
  expect(r.machineIds()).toEqual(["laptop", "tower"]);
  expect(r.routeCount).toBe(MAX_ROUTES + 1);
});

test("a route is dropped once neither an agent nor a phone holds it; an agent's route outlives its phones", () => {
  const r = router();
  const agent = new FakePort("agent");
  const phone = new FakePort("phone");
  const other = new FakePort("other");
  register(r, agent, "tower");
  attach(r, phone, "tower");
  attach(r, phone, "ghost");
  attach(r, other, "ghost");
  expect(r.routeCount).toBe(2);

  r.disconnect(phone);
  expect(r.routeCount).toBe(2); // "ghost" still has `other`
  r.disconnect(other);
  expect(r.routeCount).toBe(1); // "tower" is kept by its agent
  expect(r.machineIds()).toEqual(["tower"]);

  r.disconnect(agent);
  expect(r.routeCount).toBe(0);
});
