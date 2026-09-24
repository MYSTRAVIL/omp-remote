import { afterEach, expect, test } from "bun:test";
import {
  type ByteSink,
  SealedChannel,
  clientSessionKeys,
  newIdentity,
  serverSessionKeys,
} from "@omp-remote/crypto";
import {
  type SealedFrame,
  type ServerControl,
  ServerControl as ServerControlSchema,
} from "@omp-remote/protocol";
import { type AggregatorConfig, AggregatorServer } from "../src/server";
import { dialAgent } from "./helpers/agent-socket";
import { tempMachineStore } from "./helpers/machines";

let server: AggregatorServer | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
});

const enc = new TextEncoder();
const dec = new TextDecoder();

function toU8(data: unknown): Uint8Array {
  if (typeof data === "string") return enc.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array();
}

function text(data: unknown): string {
  return dec.decode(toU8(data)).trim();
}

/** Parse a message as an aggregator control reply, or `undefined` if it isn't one. */
function control(data: unknown): ServerControl | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text(data));
  } catch {
    return undefined;
  }
  const parsed = ServerControlSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

function wsOpen(ws: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  ws.addEventListener("open", () => resolve(), { once: true });
  return promise;
}

/** Whether a WS connection attempt opened or was refused before opening. */
function wsOutcome(ws: WebSocket): Promise<"open" | "rejected"> {
  const { promise, resolve } = Promise.withResolvers<"open" | "rejected">();
  ws.addEventListener("open", () => {
    resolve("open");
    ws.close();
  });
  ws.addEventListener("error", () => resolve("rejected"));
  ws.addEventListener("close", () => resolve("rejected"));
  return promise;
}

/** Resolve once a `machines` control reply arrives listing `machineId`. */
function awaitMachine(ws: WebSocket, machineId: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const onMsg = (e: MessageEvent) => {
    const msg = control(e.data);
    if (msg?.type === "machines" && msg.machineIds.includes(machineId)) {
      ws.removeEventListener("message", onMsg);
      resolve();
    }
  };
  ws.addEventListener("message", onMsg);
  return promise;
}

/** Resolve with the machineIds of the next `machines` reply. */
function nextMachines(ws: WebSocket): Promise<string[]> {
  const { promise, resolve } = Promise.withResolvers<string[]>();
  const onMsg = (e: MessageEvent) => {
    const msg = control(e.data);
    if (msg?.type === "machines") {
      ws.removeEventListener("message", onMsg);
      resolve(msg.machineIds);
    }
  };
  ws.addEventListener("message", onMsg);
  return promise;
}

/** Resolve with the next sealed (routed) line `ws` receives. */
function nextSealed(ws: WebSocket): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const onMsg = (e: MessageEvent) => {
    const line = text(e.data);
    if (!line.includes('"route"')) return;
    ws.removeEventListener("message", onMsg);
    resolve(line);
  };
  ws.addEventListener("message", onMsg);
  return promise;
}

/**
 * Ping and await the pong. The server handles one socket's lines in order and
 * replies in order, so once this resolves every line `ws` sent before has been
 * handled, and anything the server sent `ws` before the pong has arrived.
 */
function roundTrip(ws: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const onMsg = (e: MessageEvent) => {
    if (control(e.data)?.type !== "pong") return;
    ws.removeEventListener("message", onMsg);
    resolve();
  };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ type: "ping" }));
  return promise;
}

/** Record every line `ws` receives from now on. */
function recorder(ws: WebSocket): string[] {
  const lines: string[] = [];
  ws.addEventListener("message", (e) => lines.push(text(e.data)));
  return lines;
}

/** A `ByteSink` over a live WebSocket for driving a `SealedChannel`. */
function wsSink(ws: WebSocket): ByteSink {
  return {
    send(bytes) {
      ws.send(bytes);
    },
    onBytes(cb) {
      ws.addEventListener("message", (e) => cb(toU8((e as MessageEvent).data)));
    },
  };
}

const MACHINE = "machine-a";
const machines = await tempMachineStore();
/** `MACHINE`'s token, and one bound to another machine. */
const TOK = await machines.issue(MACHINE, 0);
const OTHER_TOK = await machines.issue("machine-b", 0);
const registerLine = () =>
  JSON.stringify({ type: "register", machineId: MACHINE });
const envelope = (ct: string) => JSON.stringify({ route: MACHINE, n: "n", ct });

function start(cfg: Partial<AggregatorConfig> = {}): {
  base: string;
  http: string;
} {
  server = new AggregatorServer({ machines, port: 0, ...cfg });
  server.start();
  return {
    base: `ws://127.0.0.1:${server.boundPort}`,
    http: `http://127.0.0.1:${server.boundPort}`,
  };
}

/** A header-authenticated agent registered for MACHINE, plus a phone attached to it. */
async function routedPair(
  base: string,
): Promise<{ agent: WebSocket; phone: WebSocket }> {
  const agent = dialAgent(base, TOK);
  await wsOpen(agent);
  agent.send(registerLine());
  await roundTrip(agent);
  const phone = new WebSocket(`${base}/client`);
  await wsOpen(phone);
  const listed = awaitMachine(phone, MACHINE);
  phone.send(JSON.stringify({ type: "attach", machineId: MACHINE }));
  await listed;
  return { agent, phone };
}

test("a sealed frame round-trips phone→agent and back; the aggregator stays blind", async () => {
  const { base } = start();

  // Session keys: the agent is the "server" side, the phone the "client" side.
  const phoneId = await newIdentity();
  const agentId = await newIdentity();
  const phoneKeys = await clientSessionKeys(phoneId, agentId.publicKey);
  const agentKeys = await serverSessionKeys(agentId, phoneId.publicKey);

  // The agent authenticates with its machine's token at upgrade, registers,
  // and the phone attaches.
  const { agent: agentWs, phone: phoneWs } = await routedPair(base);

  // Capture every sealed line the aggregator forwards to each side.
  const relayed: string[] = [];
  const capture = (e: MessageEvent) => {
    const line = text(e.data);
    if (line.includes('"route"')) relayed.push(line);
  };
  agentWs.addEventListener("message", capture);
  phoneWs.addEventListener("message", capture);

  const phone = new SealedChannel(phoneKeys, wsSink(phoneWs), MACHINE, {
    role: "initiator",
  });
  const agent = new SealedChannel(agentKeys, wsSink(agentWs), MACHINE, {
    role: "responder",
  });

  // The phone's hello crosses to the agent and the agent's ack comes back.
  const bound = Promise.withResolvers<void>();
  phone.onReady(() => bound.resolve());
  phone.hello();
  await bound.promise;

  // phone → agent
  const gotAtAgent = Promise.withResolvers<SealedFrame>();
  agent.onFrame((f) => gotAtAgent.resolve(f));
  const up: SealedFrame = {
    t: "prompt",
    sessionId: "s1",
    text: "top-secret-prompt",
    mode: "steer",
  };
  phone.sendFrame(up);
  expect(await gotAtAgent.promise).toEqual(up);

  // agent → phone
  const gotAtPhone = Promise.withResolvers<SealedFrame>();
  phone.onFrame((f) => gotAtPhone.resolve(f));
  const down: SealedFrame = {
    t: "msg",
    sessionId: "s1",
    phase: "update",
    msgId: "m1",
    role: "assistant",
    text: "top-secret-reply",
  };
  agent.sendFrame(down);
  expect(await gotAtPhone.promise).toEqual(down);

  // Blind proof: every sealed line the aggregator relayed (hello, ack and both
  // frames) is an opaque envelope — never the plaintext, never a parseable frame.
  expect(relayed.length).toBeGreaterThan(0);
  for (const line of relayed) {
    expect(line).not.toContain("top-secret");
    const wire = JSON.parse(line);
    expect(wire.route).toBe(MACHINE);
    expect(wire.t).toBeUndefined(); // a sealed envelope, not a frame
    expect(typeof wire.ct).toBe("string");
  }

  agentWs.close();
  phoneWs.close();
});

test("an /agent upgrade without a bearer is refused", async () => {
  const { base, http } = start();
  const res = await fetch(`${http}/agent`);
  expect(res.status).toBe(401);
  await res.text();
  expect(await wsOutcome(new WebSocket(`${base}/agent`))).toBe("rejected");
});

test("a wrong or unknown bearer is refused at upgrade", async () => {
  const { base, http } = start();
  for (const authorization of [
    "Bearer wrong",
    "Bearer ",
    "Basic dG9r",
    "tok",
  ]) {
    const res = await fetch(`${http}/agent`, { headers: { authorization } });
    expect(res.status).toBe(401);
    await res.text();
  }
  expect(await wsOutcome(dialAgent(base, "wrong"))).toBe("rejected");
  expect(await wsOutcome(dialAgent(base, TOK))).toBe("open");
});
test("a socket whose token is bound to another machine cannot register this one", async () => {
  const { base } = start();

  const badAgent = dialAgent(base, OTHER_TOK);
  await wsOpen(badAgent);
  const closed = Promise.withResolvers<void>();
  const gotError = Promise.withResolvers<string>();
  badAgent.addEventListener("close", () => closed.resolve(), { once: true });
  badAgent.addEventListener("message", (e) => {
    const msg = control(e.data);
    if (msg?.type === "error") gotError.resolve(msg.reason);
  });
  badAgent.send(registerLine());
  expect(await gotError.promise).toBe("unauthorized");
  await closed.promise;

  // A fresh client sees no machines — the other machine's token never claimed the route.
  const client = new WebSocket(`${base}/client`);
  await wsOpen(client);
  const machines = nextMachines(client);
  client.send(JSON.stringify({ type: "list" }));
  expect(await machines).toEqual([]);
  client.close();
});

/** Resolve once `ws` has closed. */
function wsClosed(ws: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (ws.readyState === WebSocket.CLOSED) resolve();
  ws.addEventListener("close", () => resolve(), { once: true });
  return promise;
}

test("an agent socket can neither list nor attach, and never receives a route's traffic", async () => {
  const { base } = start();
  const { agent, phone } = await routedPair(base);

  // An authenticated /agent socket tries to discover the machine and join its
  // route; it hears nothing but pongs.
  const snoop = dialAgent(base, TOK);
  await wsOpen(snoop);
  const heard = recorder(snoop);
  snoop.send(JSON.stringify({ type: "list" }));
  snoop.send(JSON.stringify({ type: "attach", machineId: MACHINE }));
  await roundTrip(snoop);

  // The route's agent broadcasts; the attached phone receives it...
  const down = envelope("for-the-phone");
  const atPhone = nextSealed(phone);
  agent.send(down);
  expect(await atPhone).toBe(down);
  // ...and once the snoop's next round trip lands, all it ever heard is
  // pongs: no machines reply, no sealed traffic.
  await roundTrip(snoop);
  for (const line of heard) expect(control(line)?.type).toBe("pong");
});

test("an unregistered agent socket's envelope is not delivered", async () => {
  const { base } = start();
  const { agent, phone } = await routedPair(base);
  const phoneHeard = recorder(phone);

  const authed = dialAgent(base, TOK);
  await wsOpen(authed);
  authed.send(envelope("injected"));
  await roundTrip(authed);

  // The next sealed line the agent sees is the attached phone's, not an
  // injection handled earlier.
  const legit = envelope("from-phone");
  const atAgent = nextSealed(agent);
  phone.send(legit);
  expect(await atAgent).toBe(legit);
  // Nor was an injection relayed to the phone as agent output.
  await roundTrip(phone);
  expect(phoneHeard.some((line) => line.includes("injected"))).toBe(false);
});

test("a client that has not attached cannot inject an envelope into a route", async () => {
  const { base } = start();
  const { agent, phone } = await routedPair(base);

  const stranger = new WebSocket(`${base}/client`);
  await wsOpen(stranger);
  stranger.send(envelope("injected"));
  await roundTrip(stranger);

  const legit = envelope("from-attached-phone");
  const atAgent = nextSealed(agent);
  phone.send(legit);
  expect(await atAgent).toBe(legit);
});

test("a client attaching to an unknown machine gets the list without it; its envelope there is answered with the list, not a crash", async () => {
  const { base } = start();
  const agent = dialAgent(base, TOK);
  await wsOpen(agent);
  agent.send(registerLine());
  await roundTrip(agent);

  const client = new WebSocket(`${base}/client`);
  await wsOpen(client);
  const firstList = nextMachines(client);
  client.send(JSON.stringify({ type: "attach", machineId: "ghost" }));
  expect(await firstList).toEqual([MACHINE]);

  // Sealed traffic to a machine with no agent is dropped without a crash, and
  // the client is told which machines are live instead.
  const answer = nextMachines(client);
  client.send(JSON.stringify({ route: "ghost", n: "n", ct: "c" }));
  expect(await answer).toEqual([MACHINE]);
  client.close();
  agent.close();
});

test("an attached phone hears its machine's agent socket close and a new one register; the agent hears no list", async () => {
  const { base } = start();
  const { agent, phone } = await routedPair(base);

  const offline = nextMachines(phone);
  agent.close();
  expect(await offline).toEqual([]);

  const back = dialAgent(base, TOK);
  await wsOpen(back);
  const heard = recorder(back);
  const online = nextMachines(phone);
  back.send(registerLine());
  expect(await online).toEqual([MACHINE]);
  // Everything the relay sent the new agent before this pong has arrived.
  await roundTrip(back);
  for (const line of heard) expect(control(line)?.type).toBe("pong");
  phone.close();
  back.close();
});

test("non-ws paths return 404", async () => {
  const { http } = start();
  const res = await fetch(`${http}/nope`);
  expect(res.status).toBe(404);
  await res.text();
});
