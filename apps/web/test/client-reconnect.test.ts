import { expect, test } from "bun:test";
import {
  type SessionKeys,
  clientSessionKeys,
  newIdentity,
  serverSessionKeys,
} from "@omp-remote/crypto";
import type { Scheduler, SealedFrame, SessionMeta } from "@omp-remote/protocol";
import {
  type ClientSocket,
  PhoneClient,
  type PhoneClientOptions,
  type RelayState,
  type SignOutReason,
} from "../src/core/client";
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

/** A scheduler double whose timers/intervals are fired manually. */
class FakeScheduler implements Scheduler {
  timers: (() => void)[] = [];
  intervals: (() => void)[] = [];
  setTimer(fn: () => void): () => void {
    this.timers.push(fn);
    return () => {
      this.timers = this.timers.filter((f) => f !== fn);
    };
  }
  setInterval(fn: () => void): () => void {
    this.intervals.push(fn);
    return () => {
      this.intervals = this.intervals.filter((f) => f !== fn);
    };
  }
  fireTimers(): void {
    const pending = this.timers;
    this.timers = [];
    for (const fn of pending) fn();
  }
  tick(): void {
    for (const fn of [...this.intervals]) fn();
  }
}

/** A ClientSocket double with manual open/close/message and observable sends. */
class FakeSocket implements ClientSocket {
  readonly sent: string[] = [];
  /** Whether the client closed this socket itself. */
  closedByClient = false;
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
    this.closedByClient = true;
    this.#onClose?.(1000);
  }
  fireOpen(): void {
    this.#onOpen?.();
  }
  /** The connection drops; 1006 is the browser's code for an abnormal close. */
  fireClose(code = 1006): void {
    this.#onClose?.(code);
  }
  deliver(raw: string): void {
    this.#onMessage?.(raw);
  }
  attaches(): string[] {
    const out: string[] = [];
    for (const raw of this.sent) {
      const j: unknown = JSON.parse(
        raw.startsWith("{") && raw.includes('"type"') ? raw : "null",
      );
      if (
        typeof j === "object" &&
        j !== null &&
        "type" in j &&
        j.type === "attach" &&
        "machineId" in j
      )
        out.push(String(j.machineId));
    }
    return out;
  }
  pingCount(): number {
    let n = 0;
    for (const raw of this.sent) {
      if (!raw.includes('"ping"')) continue;
      const j: unknown = JSON.parse(raw);
      if (
        typeof j === "object" &&
        j !== null &&
        "type" in j &&
        j.type === "ping"
      )
        n += 1;
    }
    return n;
  }
}

async function pair(): Promise<{ phone: SessionKeys; agent: SessionKeys }> {
  const phoneId = await newIdentity();
  const agentId = await newIdentity();
  return {
    phone: await clientSessionKeys(phoneId, agentId.publicKey),
    agent: await serverSessionKeys(agentId, phoneId.publicKey),
  };
}

test("after the socket drops the client reconnects, re-attaches and re-syncs", async () => {
  const { phone, agent } = await pair();
  const store = new AppStore();
  const sched = new FakeScheduler();
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  let i = 0;
  const client = new PhoneClient(
    () => {
      const s = sockets[i];
      if (!s) throw new Error("no socket");
      i += 1;
      return s;
    },
    [{ machineId: "m1", keys: phone }],
    store,
    { scheduler: sched, keepaliveMs: 0 },
  );
  client.start();
  first.fireOpen();
  expect(first.attaches()).toEqual(["m1"]);
  // The agent acks the hello: the channel is bound to it, and syncs.
  const m1 = new FakeAgent(agent, "m1");
  m1.connect(first);
  m1.relay();
  expect(m1.frames).toEqual([{ t: "sync" }]);

  // Drop the socket: a reconnect is scheduled but no new socket yet.
  first.fireClose();
  expect(i).toBe(1);

  // Fire the reconnect timer → a fresh socket is dialled and, on open,
  // re-attaches and says hello again; the agent's ack pulls a fresh sync.
  sched.fireTimers();
  expect(i).toBe(2);
  second.fireOpen();
  expect(second.attaches()).toEqual(["m1"]);
  m1.connect(second);
  m1.relay();
  expect(m1.frames).toEqual([{ t: "sync" }, { t: "sync" }]);

  // A snapshot over the RECONNECTED socket lands in the tree — proving the
  // persistent channel still decodes on the new transport.
  second.deliver(m1.seal({ t: "sessions", sessions: [meta] }));
  expect(store.tree()[0]?.projects[0]?.sessions[0]?.id).toBe("s1");
});

test("a control frame sent while disconnected is flushed on reconnect after the attach", async () => {
  const { phone, agent } = await pair();
  const store = new AppStore();
  const sched = new FakeScheduler();
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  let i = 0;
  const client = new PhoneClient(
    () => {
      const s = sockets[i];
      if (!s) throw new Error("no socket");
      i += 1;
      return s;
    },
    [{ machineId: "m1", keys: phone }],
    store,
    { scheduler: sched, keepaliveMs: 0 },
  );
  client.start();
  first.fireOpen();
  // The agent acks the hello, so the channel seals straight to it from now on.
  const m1 = new FakeAgent(agent, "m1");
  m1.connect(first);
  m1.relay();
  first.fireClose(); // now disconnected

  // The user sends a prompt while offline; it seals into the outbound queue.
  const prompt: SealedFrame = {
    t: "prompt",
    sessionId: "s1",
    text: "hi",
    mode: "steer",
  };
  client.channelFor("m1")?.sendFrame(prompt);
  expect(second.sent.length).toBe(0); // nothing sent yet

  sched.fireTimers();
  second.fireOpen(); // attach, then flush the buffered prompt, then hello

  // The aggregator drops envelopes for a route this socket has not attached, so
  // the buffered prompt must follow the route's attach, as every sealed line does.
  const attachAt = second.sent.findIndex((l) => l.includes('"attach"'));
  const firstSealedAt = second.sent.findIndex((l) => l.includes('"route"'));
  expect(attachAt).toBeGreaterThanOrEqual(0);
  expect(firstSealedAt).toBeGreaterThan(attachAt);
  // The agent opens the buffered prompt, then the sync the new hello's ack pulls.
  m1.connect(second);
  m1.relay();
  expect(m1.frames).toEqual([{ t: "sync" }, prompt, { t: "sync" }]);
});

test("outbound queue overflow drops the OLDEST buffered line", async () => {
  const { phone, agent } = await pair();
  const store = new AppStore();
  const sched = new FakeScheduler();
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  let i = 0;
  const client = new PhoneClient(
    () => {
      const s = sockets[i];
      if (!s) throw new Error("no socket");
      i += 1;
      return s;
    },
    [{ machineId: "m1", keys: phone }],
    store,
    { scheduler: sched, keepaliveMs: 0, maxQueue: 2 },
  );
  client.start();
  first.fireOpen();
  // The agent acks the hello, so what the channel sends offline is sealed into
  // the client's outbound queue.
  const m1 = new FakeAgent(agent, "m1");
  m1.connect(first);
  m1.relay();
  first.fireClose();

  const ch = client.channelFor("m1");
  ch?.sendFrame({ t: "prompt", sessionId: "s1", text: "a", mode: "steer" });
  ch?.sendFrame({ t: "prompt", sessionId: "s1", text: "b", mode: "steer" });
  ch?.sendFrame({ t: "prompt", sessionId: "s1", text: "c", mode: "steer" }); // evicts "a"

  sched.fireTimers();
  second.fireOpen();

  m1.connect(second);
  m1.relay();
  const prompts = m1.frames.flatMap((f) => (f.t === "prompt" ? [f.text] : []));
  expect(prompts).toEqual(["b", "c"]); // "a" dropped
});

test("keepalive pings while connected and stops after close and stop()", async () => {
  const { phone } = await pair();
  const store = new AppStore();
  const sched = new FakeScheduler();
  const sockets = [new FakeSocket(), new FakeSocket()];
  let i = 0;
  const client = new PhoneClient(
    () => {
      const s = sockets[i];
      if (!s) throw new Error("no socket");
      i += 1;
      return s;
    },
    [{ machineId: "m1", keys: phone }],
    store,
    { scheduler: sched, keepaliveMs: 1000 },
  );
  client.start();
  sockets[0]?.fireOpen();
  sched.tick();
  expect(sockets[0]?.pingCount()).toBe(1);

  // On close the interval is cleared — a tick emits nothing on the dead socket.
  sockets[0]?.fireClose();
  sched.tick();
  expect(sockets[0]?.pingCount()).toBe(1);

  // After a stop no reconnect timer survives to dial again.
  client.stop();
  sched.fireTimers();
  expect(i).toBe(1);
});

test("a stale socket's inbound line after reconnect is ignored", async () => {
  const { phone, agent } = await pair();
  const store = new AppStore();
  const sched = new FakeScheduler();
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  let i = 0;
  const client = new PhoneClient(
    () => {
      const s = sockets[i];
      if (!s) throw new Error("no socket");
      i += 1;
      return s;
    },
    [{ machineId: "m1", keys: phone }],
    store,
    { scheduler: sched, keepaliveMs: 0 },
  );
  client.start();
  first.fireOpen();
  // The agent acks the hello: the channel opens what this agent seals.
  const m1 = new FakeAgent(agent, "m1");
  m1.connect(first);
  m1.relay();
  first.fireClose();
  sched.fireTimers();
  second.fireOpen(); // socket #2 is the live generation

  // A snapshot arriving late on the dead socket #1 must not mutate the store.
  first.deliver(m1.seal({ t: "sessions", sessions: [meta] }));
  expect(store.tree()[0]?.projects ?? []).toEqual([]);

  // The live socket still applies a snapshot.
  second.deliver(m1.seal({ t: "sessions", sessions: [meta] }));
  expect(store.tree()[0]?.projects[0]?.sessions[0]?.id).toBe("s1");
});

test("wake() forces a fresh reconnect and resync without waiting for a close", async () => {
  const { phone, agent } = await pair();
  const store = new AppStore();
  const sched = new FakeScheduler();
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  let i = 0;
  const client = new PhoneClient(
    () => {
      const s = sockets[i];
      if (!s) throw new Error("no socket");
      i += 1;
      return s;
    },
    [{ machineId: "m1", keys: phone }],
    store,
    { scheduler: sched, keepaliveMs: 0 },
  );
  client.start();
  first.fireOpen();
  const m1 = new FakeAgent(agent, "m1");
  m1.connect(first);
  m1.relay();
  expect(i).toBe(1);

  // Half-open: the server is gone but no close ever fires. wake() must dial a
  // fresh socket immediately — not wait for a close or a backoff timer.
  client.wake();
  expect(i).toBe(2);
  second.fireOpen();
  expect(second.attaches()).toEqual(["m1"]);
  // The fresh socket says hello again, and the agent's ack pulls a resync.
  m1.connect(second);
  m1.relay();
  expect(m1.frames).toEqual([{ t: "sync" }, { t: "sync" }]);

  // A late frame on the orphaned socket #0 is ignored; the fresh socket drives.
  first.deliver(m1.seal({ t: "sessions", sessions: [meta] }));
  expect(store.tree().length).toBe(0);
  second.deliver(m1.seal({ t: "sessions", sessions: [meta] }));
  expect(store.tree()[0]?.projects[0]?.sessions[0]?.id).toBe("s1");

  // The orphaned socket's own close must not schedule a competing reconnect.
  first.fireClose();
  sched.fireTimers();
  expect(i).toBe(2);
});

test("relayState tracks the relay link through drops, retries, wake() and stop(), reporting each change once", async () => {
  const { phone } = await pair();
  const sched = new FakeScheduler();
  const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
  let i = 0;
  const reported: RelayState[] = [];
  const client = new PhoneClient(
    () => {
      const s = sockets[i];
      if (!s) throw new Error("no socket");
      i += 1;
      return s;
    },
    [{ machineId: "m1", keys: phone }],
    new AppStore(),
    {
      scheduler: sched,
      keepaliveMs: 0,
      onRelayState: (state) => reported.push(state),
    },
  );
  expect(client.relayState).toBe("offline");
  client.start();
  expect(client.relayState).toBe("connecting");
  sockets[0]?.fireOpen();
  expect(client.relayState).toBe("connected");

  // Dropped: offline until the retry dials.
  sockets[0]?.fireClose();
  expect(client.relayState).toBe("offline");
  sched.fireTimers();
  expect(client.relayState).toBe("connecting");
  sockets[1]?.fireOpen();

  // wake() redials at once; stop() leaves it down for good.
  client.wake();
  expect(client.relayState).toBe("connecting");
  sockets[2]?.fireOpen();
  client.stop();
  expect(client.relayState).toBe("offline");
  expect(reported).toEqual([
    "connecting",
    "connected",
    "offline",
    "connecting",
    "connected",
    "connecting",
    "connected",
    "offline",
  ]);
});

test("when the relay ends this sign-in (close 4401) the client stops for good and reports it once, as revoked", async () => {
  const { phone } = await pair();
  const sched = new FakeScheduler();
  const sockets = [new FakeSocket(), new FakeSocket()];
  let i = 0;
  const signedOut: SignOutReason[] = [];
  const client = new PhoneClient(
    () => {
      const s = sockets[i];
      if (!s) throw new Error("no socket");
      i += 1;
      return s;
    },
    [{ machineId: "m1", keys: phone }],
    new AppStore(),
    {
      scheduler: sched,
      keepaliveMs: 0,
      onSignedOut: (reason) => signedOut.push(reason),
    },
  );
  client.start();
  sockets[0]?.fireOpen();

  sockets[0]?.fireClose(4401);
  expect(signedOut).toEqual(["revoked"]);
  expect(client.relayState).toBe("offline");
  // The relay refuses this token from now on: neither the backoff timer nor a
  // resume from the background dials it again.
  sched.fireTimers();
  client.wake();
  expect(i).toBe(1);
  expect(signedOut).toEqual(["revoked"]);
});

test("a relay that closes every new socket at once (1013) meets a growing backoff, reset only once a link stays up", async () => {
  const { phone } = await pair();
  const delays: number[] = [];
  const sched = new FakeScheduler();
  const setTimer = sched.setTimer.bind(sched);
  sched.setTimer = (fn: () => void, ms?: number) => {
    delays.push(ms ?? -1);
    return setTimer(fn);
  };
  const sockets: FakeSocket[] = [];
  const client = new PhoneClient(
    () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    [{ machineId: "m1", keys: phone }],
    new AppStore(),
    {
      scheduler: sched,
      keepaliveMs: 30_000,
      backoff: { baseMs: 100, maxMs: 10_000, factor: 2 },
      random: () => 0,
      dialTimeoutMs: 0,
    },
  );
  client.start();
  // Three sockets in a row open and are closed for backpressure straight away.
  for (let n = 0; n < 3; n++) {
    sockets.at(-1)?.fireOpen();
    sockets.at(-1)?.fireClose(1013);
    sched.fireTimers();
  }
  expect(delays).toEqual([50, 100, 200]);
  // This one stays up for a keepalive interval: the next drop starts over.
  sockets.at(-1)?.fireOpen();
  sched.tick();
  sockets.at(-1)?.fireClose(1013);
  expect(delays.at(-1)).toBe(50);
});

type SessionStatus = "valid" | "invalid" | "unknown";

/** A client under test, with what it has reported so far. */
interface Harness {
  client: PhoneClient;
  sched: FakeScheduler;
  /** Every socket the client dialled, in order. */
  sockets: FakeSocket[];
  signedOut: SignOutReason[];
  reported: RelayState[];
}

/**
 * A client paired with one machine, dialling a fresh `FakeSocket` each time,
 * on a `FakeScheduler` with a keepalive; `opts` override the defaults.
 */
async function harness(opts: PhoneClientOptions = {}): Promise<Harness> {
  const { phone } = await pair();
  const sched = new FakeScheduler();
  const sockets: FakeSocket[] = [];
  const signedOut: SignOutReason[] = [];
  const reported: RelayState[] = [];
  const client = new PhoneClient(
    () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    [{ machineId: "m1", keys: phone }],
    new AppStore(),
    {
      scheduler: sched,
      keepaliveMs: 1000,
      dialTimeoutMs: 0,
      onSignedOut: (reason) => signedOut.push(reason),
      onRelayState: (state) => reported.push(state),
      ...opts,
    },
  );
  return { client, sched, sockets, signedOut, reported };
}

/** The relay refuses the next dial's upgrade: the socket closes, never opens. */
function refuse(h: Harness): void {
  h.sockets.at(-1)?.fireClose();
  h.sched.fireTimers();
}

test("a session token past its expiry is never dialled, at start or on a backoff retry: the client signs out as expired", async () => {
  // Expired at start (the expiry instant itself counts): nothing is dialled.
  const early = await harness({ tokenExpiresAt: 5_000, now: () => 5_000 });
  early.client.start();
  expect(early.sockets).toHaveLength(0);
  expect(early.signedOut).toEqual(["expired"]);
  expect(early.reported).toEqual([]);
  early.client.wake();
  expect(early.sockets).toHaveLength(0);

  // Expired while waiting out the backoff after a drop: the retry dials nothing.
  let clock = 1_000;
  const late = await harness({ tokenExpiresAt: 2_000, now: () => clock });
  late.client.start();
  late.sockets[0]?.fireOpen();
  late.sockets[0]?.fireClose();
  clock = 2_000;
  late.sched.fireTimers();
  expect(late.sockets).toHaveLength(1);
  expect(late.signedOut).toEqual(["expired"]);
  expect(late.client.relayState).toBe("offline");
});

test("a token that runs out while connected ends the sign-in at the next keepalive tick", async () => {
  let clock = 1_000;
  const h = await harness({ tokenExpiresAt: 2_000, now: () => clock });
  h.client.start();
  const socket = h.sockets[0];
  socket?.fireOpen();
  h.sched.tick();
  expect(socket?.pingCount()).toBe(1);
  expect(h.signedOut).toEqual([]);

  clock = 2_000;
  h.sched.tick();
  expect(h.signedOut).toEqual(["expired"]);
  expect(socket?.pingCount()).toBe(1);
  expect(socket?.closedByClient).toBe(true);
  expect(h.client.relayState).toBe("offline");
  // Every timer went with it: no keepalive, no pong deadline, no redial.
  expect(h.sched.intervals).toHaveLength(0);
  expect(h.sched.timers).toHaveLength(0);
  h.client.wake();
  expect(h.sockets).toHaveLength(1);
  expect(h.signedOut).toEqual(["expired"]);
});

test("two dials in a row that never open ask the relay about the token once; 'invalid' signs out as expired", async () => {
  const answer = Promise.withResolvers<SessionStatus>();
  let checks = 0;
  const h = await harness({
    checkSession: () => {
      checks += 1;
      return answer.promise;
    },
  });
  h.client.start();
  refuse(h);
  expect(checks).toBe(0);
  refuse(h);
  expect(checks).toBe(1);
  // The backoff keeps dialling while the answer is out, and a third refused
  // dial in the same run does not ask again.
  refuse(h);
  expect(h.sockets).toHaveLength(4);
  expect(checks).toBe(1);

  answer.resolve("invalid");
  // The client's handler was registered first, so it has run by now.
  await answer.promise;
  expect(h.signedOut).toEqual(["expired"]);
  expect(h.sockets[3]?.closedByClient).toBe(true);
  expect(h.client.relayState).toBe("offline");
  h.sched.fireTimers();
  expect(h.sockets).toHaveLength(4);
});

test("a check that answers 'unknown', or fails, leaves the client reconnecting; after a socket opens, two more refused dials ask again", async () => {
  const answers: PromiseWithResolvers<SessionStatus>[] = [];
  const h = await harness({
    checkSession: () => {
      const answer = Promise.withResolvers<SessionStatus>();
      answers.push(answer);
      return answer.promise;
    },
  });
  h.client.start();
  refuse(h);
  refuse(h);
  expect(answers).toHaveLength(1);
  answers[0]?.resolve("unknown");
  await answers[0]?.promise;
  // Still dialling, and further refusals in this run ask nothing more.
  refuse(h);
  refuse(h);
  expect(h.sockets).toHaveLength(5);
  expect(answers).toHaveLength(1);
  expect(h.signedOut).toEqual([]);

  // A socket that opens ends the run; the next run asks on its second refusal.
  h.sockets[4]?.fireOpen();
  h.sockets[4]?.fireClose();
  h.sched.fireTimers();
  refuse(h);
  expect(answers).toHaveLength(1);
  refuse(h);
  expect(answers).toHaveLength(2);
  answers[1]?.reject(new Error("network down"));
  await answers[1]?.promise.catch(() => {});
  expect(h.signedOut).toEqual([]);
  expect(h.sockets).toHaveLength(8);
  expect(h.client.relayState).toBe("connecting");
});

test("a check answering 'invalid' after its run ended is ignored: a socket opened, or the client woke or stopped", async () => {
  const endings: Record<string, (h: Harness) => void> = {
    "a socket opened": (h) => h.sockets.at(-1)?.fireOpen(),
    "the client woke": (h) => h.client.wake(),
    "the client stopped": (h) => h.client.stop(),
  };
  for (const [ending, end] of Object.entries(endings)) {
    const answer = Promise.withResolvers<SessionStatus>();
    const h = await harness({ checkSession: () => answer.promise });
    h.client.start();
    refuse(h);
    refuse(h);
    end(h);
    const live = h.client.relayState;
    answer.resolve("invalid");
    await answer.promise;
    expect({ ending, signedOut: h.signedOut }).toEqual({
      ending,
      signedOut: [],
    });
    // Nothing changed: an open or fresh dial is not torn down.
    expect({ ending, relay: h.client.relayState }).toEqual({
      ending,
      relay: live,
    });
  }
});

test("a ping no line answers within the pong deadline drops the socket and redials at once", async () => {
  const h = await harness({ pongTimeoutMs: 5_000 });
  h.client.start();
  const dead = h.sockets[0];
  dead?.fireOpen();
  h.sched.tick();
  expect(dead?.pingCount()).toBe(1);
  expect(h.sched.timers).toHaveLength(1);

  // No line came back in time: the socket is half-open.
  h.sched.fireTimers();
  expect(dead?.closedByClient).toBe(true);
  expect(h.sockets).toHaveLength(2);
  expect(h.client.relayState).toBe("connecting");
  expect(h.reported).toEqual(["connecting", "connected", "connecting"]);
  // The orphaned socket's late close schedules nothing, and it is not pinged.
  dead?.fireClose();
  expect(h.sched.timers).toHaveLength(0);
  h.sched.tick();
  expect(dead?.pingCount()).toBe(1);

  // A redial that fails backs off as usual; the retry re-attaches.
  h.sockets[1]?.fireClose();
  expect(h.client.relayState).toBe("offline");
  expect(h.sched.timers).toHaveLength(1);
  h.sched.fireTimers();
  h.sockets[2]?.fireOpen();
  expect(h.sockets[2]?.attaches()).toEqual(["m1"]);
  expect(h.client.relayState).toBe("connected");
});

test("any line disarms the pong deadline; a close, wake() or stop() cancels it, and 0 turns the watchdog off", async () => {
  const h = await harness();
  h.client.start();
  const socket = h.sockets[0];
  socket?.fireOpen();
  h.sched.tick();
  expect(h.sched.timers).toHaveLength(1);
  socket?.deliver(JSON.stringify({ type: "pong" }));
  expect(h.sched.timers).toHaveLength(0);
  // Not only a pong: any line proves the socket alive, even one it ignores.
  for (const line of [
    JSON.stringify({ type: "machines", machineIds: ["m1"] }),
    "not json",
  ]) {
    h.sched.tick();
    socket?.deliver(line);
    expect(h.sched.timers).toHaveLength(0);
  }
  expect(h.sockets).toHaveLength(1);
  expect(h.client.relayState).toBe("connected");

  // A drop leaves only the reconnect timer.
  h.sched.tick();
  socket?.fireClose();
  expect(h.sched.timers).toHaveLength(1);
  h.sched.fireTimers();
  expect(h.sockets).toHaveLength(2);
  // wake() redials at once, so nothing is left pending.
  h.sockets[1]?.fireOpen();
  h.sched.tick();
  h.client.wake();
  expect(h.sched.timers).toHaveLength(0);
  // stop() leaves no timer and no interval.
  h.sockets[2]?.fireOpen();
  h.sched.tick();
  h.client.stop();
  expect(h.sched.timers).toHaveLength(0);
  expect(h.sched.intervals).toHaveLength(0);

  const off = await harness({ pongTimeoutMs: 0 });
  off.client.start();
  off.sockets[0]?.fireOpen();
  off.sched.tick();
  expect(off.sockets[0]?.pingCount()).toBe(1);
  expect(off.sched.timers).toHaveLength(0);
});

test("a dial that never opens is dropped at the dial deadline and retried on the backoff; its late close changes nothing", async () => {
  const h = await harness({ dialTimeoutMs: 8_000 });
  h.client.start();
  const hung = h.sockets[0];
  expect(h.client.relayState).toBe("connecting");
  // The dial deadline passes with the socket neither open nor closed.
  h.sched.fireTimers();
  expect(hung?.closedByClient).toBe(true);
  expect(h.client.relayState).toBe("offline");
  expect(h.sched.timers).toHaveLength(1);
  hung?.fireClose();
  expect(h.sched.timers).toHaveLength(1);
  // The retry opens in time: its deadline is dropped with nothing left pending.
  h.sched.fireTimers();
  h.sockets[1]?.fireOpen();
  expect(h.client.relayState).toBe("connected");
  expect(h.sched.timers).toHaveLength(0);
});

test("probe() keeps a link the relay pongs; a link with no pong in time, or none at all, redials at once", async () => {
  const h = await harness({ probeTimeoutMs: 3_000 });
  h.client.start();
  const socket = h.sockets[0];
  socket?.fireOpen();
  h.client.probe();
  expect(socket?.pingCount()).toBe(1);
  // A line the browser queued while the tab was frozen proves nothing.
  socket?.deliver(JSON.stringify({ type: "machines", machineIds: ["m1"] }));
  expect(h.sched.timers).toHaveLength(1);
  socket?.deliver(JSON.stringify({ type: "pong" }));
  expect(h.sched.timers).toHaveLength(0);
  expect(h.sockets).toHaveLength(1);

  // No pong this time: the socket is dropped and a new one dialled.
  h.client.probe();
  h.sched.fireTimers();
  expect(socket?.closedByClient).toBe(true);
  expect(h.sockets).toHaveLength(2);

  // Down and waiting out the backoff: probe() dials without waiting.
  h.sockets[1]?.fireClose();
  expect(h.sched.timers).toHaveLength(1);
  h.client.probe();
  expect(h.sockets).toHaveLength(3);
  expect(h.sched.timers).toHaveLength(0);
});

test("wake() starts the backoff over, so a retry after it waits the shortest delay", async () => {
  const h = await harness({
    random: () => 0,
    backoff: { baseMs: 100, maxMs: 10_000, factor: 2 },
  });
  const delays: number[] = [];
  const setTimer = h.sched.setTimer.bind(h.sched);
  h.sched.setTimer = (fn: () => void, ms?: number) => {
    delays.push(ms ?? -1);
    return setTimer(fn);
  };
  h.client.start();
  refuse(h);
  refuse(h);
  h.sockets.at(-1)?.fireClose();
  expect(delays).toEqual([50, 100, 200]);
  h.client.wake();
  h.sockets.at(-1)?.fireClose();
  expect(delays.at(-1)).toBe(50);
});
