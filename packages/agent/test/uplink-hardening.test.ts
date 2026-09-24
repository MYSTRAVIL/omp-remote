import { expect, test } from "bun:test";
import {
  SealedChannel,
  type SessionKeys,
  clientSessionKeys,
  newIdentity,
  notifyKey,
  serverSessionKeys,
} from "@omp-remote/crypto";
import {
  AttentionMsg,
  type BackoffConfig,
  type ClientMessage,
  type DownlinkCommand,
  type DownlinkFrame,
  type MsgFrame,
  NotifyEnvelope,
  type NotifyNotice,
  type Scheduler,
  type SealedFrame,
  SealedWireEnvelope,
  openNotice,
} from "@omp-remote/protocol";
import type { AgentDiagnostic } from "../src/diagnostics";
import {
  MAX_CONNECTED_BACKLOG,
  type SessionFeed,
  Uplink,
  type UplinkSocket,
  WS_OPEN,
} from "../src/uplink";

const dec = new TextDecoder();

/** A scheduler double: timers/intervals are captured and fired manually. */
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
  tickIntervals(): void {
    for (const fn of [...this.intervals]) fn();
  }
}

/** A socket double with manual open/close/message and observable sends. */
class FakeSocket implements UplinkSocket {
  readyState = 0; // CONNECTING
  /** Bytes the network has not taken yet. Settable; with `backpressure` on,
   *  every send adds its own bytes, as a slow link would. */
  bufferedAmount = 0;
  backpressure = false;
  readonly sent: (string | Uint8Array)[] = [];
  #open: (() => void) | undefined;
  #close: (() => void) | undefined;
  #msg: ((data: unknown) => void) | undefined;
  readonly #onSend = new Set<() => void>();
  send(data: string | Uint8Array): void {
    this.sent.push(data);
    if (this.backpressure)
      this.bufferedAmount +=
        typeof data === "string" ? data.length : data.byteLength;
    for (const check of [...this.#onSend]) check();
  }
  /** Resolves once `ready()` holds, checked again after every send. */
  until(ready: () => boolean): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const check = () => {
      if (!ready()) return;
      this.#onSend.delete(check);
      resolve();
    };
    this.#onSend.add(check);
    check();
    return promise;
  }
  close(): void {
    this.readyState = 3;
    this.#close?.();
  }
  onOpen(cb: () => void): void {
    this.#open = cb;
  }
  onClose(cb: () => void): void {
    this.#close = cb;
  }
  onMessage(cb: (data: unknown) => void): void {
    this.#msg = cb;
  }
  onError(): void {}
  fireOpen(): void {
    this.readyState = WS_OPEN;
    this.#open?.();
  }
  fireClose(): void {
    this.readyState = 3;
    this.#close?.();
  }
  fireMessage(data: unknown): void {
    this.#msg?.(data);
  }
  controls(): unknown[] {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s));
  }
  sealed(): Uint8Array[] {
    return this.sent.filter((s): s is Uint8Array => s instanceof Uint8Array);
  }
  pingCount(): number {
    let n = 0;
    for (const c of this.controls())
      if (
        typeof c === "object" &&
        c !== null &&
        "type" in c &&
        c.type === "ping"
      )
        n += 1;
    return n;
  }
}

/** A feed double: its subscriber can be driven, its replay set, and its
 *  downlinks recorded. */
function makeFeed() {
  let sub: ((m: ClientMessage) => void) | undefined;
  let replay: ClientMessage[] = [{ t: "sessions", sessions: [] }];
  const downlinks: DownlinkFrame[] = [];
  const feed: SessionFeed = {
    subscribe(s) {
      sub = s;
      return () => {
        sub = undefined;
      };
    },
    replay: () => replay,
    deliverDownlink(f) {
      downlinks.push(f);
    },
  };
  return {
    feed,
    emit: (m: ClientMessage) => sub?.(m),
    setReplay: (frames: ClientMessage[]) => {
      replay = frames;
    },
    downlinks,
  };
}

/**
 * The paired phone's end of the channel over a fake uplink socket: a real
 * initiator whose lines arrive at the uplink as inbound messages, each also
 * recorded as the relay saw it. Nothing the uplink writes reaches the phone
 * until `read` hands it lines, as the relay would.
 */
class FakePhone {
  /** Every frame the phone opened, in order. */
  readonly frames: SealedFrame[] = [];
  /** Every line the phone put on the wire, in order. */
  readonly wire: Uint8Array[] = [];
  readonly channel: SealedChannel;
  #sock: FakeSocket;
  #feed: ((b: Uint8Array) => void) | undefined;

  constructor(keys: SessionKeys, sock: FakeSocket) {
    this.#sock = sock;
    this.channel = new SealedChannel(
      keys,
      {
        send: (b) => {
          this.wire.push(b);
          this.#sock.fireMessage(b);
        },
        onBytes: (cb) => {
          this.#feed = cb;
        },
      },
      machineId,
      { role: "initiator" },
    );
    this.channel.onFrame((f) => this.frames.push(f));
  }

  /** Send over `sock` from now on: a reconnect's socket, or a dead one. */
  use(sock: FakeSocket): void {
    this.#sock = sock;
  }

  /** Hand the phone lines the uplink wrote, as the relay would. */
  read(lines: readonly Uint8Array[]): void {
    for (const line of lines) this.#feed?.(line);
  }

  /**
   * Say hello over the current socket and read the ack the uplink writes in
   * reply: from then on the phone opens what the uplink seals, and its own
   * frames open at the uplink.
   */
  bind(): void {
    const sock = this.#sock;
    const before = sock.sealed().length;
    this.channel.hello();
    this.read(sock.sealed().slice(before));
  }
}

async function keypair(): Promise<{
  agent: SessionKeys;
  phone: SessionKeys;
}> {
  const phoneId = await newIdentity();
  const machineIdentity = await newIdentity();
  return {
    agent: await serverSessionKeys(machineIdentity, phoneId.publicKey),
    phone: await clientSessionKeys(phoneId, machineIdentity.publicKey),
  };
}

function msg(sessionId: string, text: string): MsgFrame {
  return {
    t: "msg",
    sessionId,
    phase: "update",
    msgId: "1",
    role: "assistant",
    text,
  };
}

const machineId = "machine-a";

function uplinkWith(
  keys: SessionKeys,
  feed: SessionFeed,
  sched: FakeScheduler,
  sockets: FakeSocket[],
  opts: {
    keepaliveMs?: number;
    maxQueue?: number;
    maxBufferedBytes?: number;
    backoff?: BackoffConfig;
    diagnostic?: (event: AgentDiagnostic) => void;
    notifyKey?: Uint8Array;
  } = {},
): Uplink {
  let i = 0;
  return new Uplink({
    url: "ws://agg/agent",
    machineId,
    token: "tok",
    keys,
    feed,
    backoff: opts.backoff,
    random: () => 0.5,
    diagnostic: opts.diagnostic,
    scheduler: sched,
    keepaliveMs: opts.keepaliveMs ?? 0,
    maxQueue: opts.maxQueue,
    maxBufferedBytes: opts.maxBufferedBytes,
    notifyKey: opts.notifyKey,
    // Presence unknown: a need pushes at once.
    hostIdleMs: () => null,
    socketFactory: () => {
      const s = sockets[i];
      if (!s) throw new Error(`no fake socket for connect #${i}`);
      i += 1;
      return s;
    },
  });
}

test("keepalive sends a ping on each interval tick while open", async () => {
  const { agent } = await keypair();
  const { feed } = makeFeed();
  const sched = new FakeScheduler();
  const sock = new FakeSocket();
  const uplink = uplinkWith(agent, feed, sched, [sock], { keepaliveMs: 1000 });
  uplink.start();
  sock.fireOpen();

  sched.tickIntervals();
  sched.tickIntervals();
  expect(sock.pingCount()).toBe(2);
  uplink.stop();
});

test("stop() halts the keepalive interval", async () => {
  const { agent } = await keypair();
  const { feed } = makeFeed();
  const sched = new FakeScheduler();
  const sock = new FakeSocket();
  const uplink = uplinkWith(agent, feed, sched, [sock], { keepaliveMs: 1000 });
  uplink.start();
  sock.fireOpen();
  uplink.stop();
  sched.tickIntervals(); // any surviving interval would emit another ping
  expect(sock.pingCount()).toBe(0);
});

/** Events no replay can rebuild: the uplink holds them while the link is down. */
const attention: ClientMessage = {
  t: "attention",
  sessionId: "s1",
  reason: "approval",
};
const ended: ClientMessage = {
  t: "interactionEnd",
  sessionId: "s1",
  id: "q1",
  reason: "cancelled",
};
const failed: ClientMessage = {
  t: "controlError",
  sessionId: "s1",
  action: "compact",
  code: "control-failed",
  message: "compaction rejected",
};

test("a reconnect sends register, then the channel's hello, then the full replay, then the transient frames held while down", async () => {
  const { agent, phone } = await keypair();
  const { feed, emit, setReplay } = makeFeed();
  const sched = new FakeScheduler();
  const sock1 = new FakeSocket();
  const sock2 = new FakeSocket();
  const uplink = uplinkWith(agent, feed, sched, [sock1, sock2]);
  uplink.start();
  sock1.fireOpen();
  // A phone binds to the agent before the link drops.
  const phoneEnd = new FakePhone(phone, sock1);
  phoneEnd.bind();
  sock1.fireClose(); // link drops → reconnect scheduled

  // While down the session keeps going. Its message is state the replay
  // rebuilds; the attention, the settled interaction and the failed control
  // are events only the held queue carries.
  emit(msg("s1", "written while down"));
  emit(attention);
  emit(ended);
  emit(failed);
  const replay: ClientMessage[] = [
    { t: "sessions", sessions: [] },
    msg("s1", "written while down"),
  ];
  setReplay(replay);

  sched.fireTimers(); // reconnect timer → new socket
  sock2.fireOpen();

  // register leads, in the clear; everything after it is sealed, and the first
  // sealed line is the hello a phone bound to a dead epoch would answer.
  expect(sock2.sent[0]).toBeTypeOf("string");
  expect(sock2.controls()).toEqual([{ type: "register", machineId }]);
  const sealed = sock2.sealed();
  expect(sealed).toHaveLength(sock2.sent.length - 1);
  const [hello] = sealed;
  if (hello === undefined) throw new Error("nothing sealed");
  expect(SealedWireEnvelope.parse(JSON.parse(dec.decode(hello))).k).toBe("h");
  // The phone, still bound to this agent, takes the rest in order.
  phoneEnd.read(sealed);
  expect(phoneEnd.frames).toEqual([...replay, attention, ended, failed]);
  uplink.stop();
});

test("while down only transient frames are held; past maxQueue the oldest drops and is reported", async () => {
  const { agent, phone } = await keypair();
  const { feed, emit } = makeFeed();
  const sched = new FakeScheduler();
  const sock1 = new FakeSocket();
  const sock2 = new FakeSocket();
  const diagnostics: AgentDiagnostic[] = [];
  const uplink = uplinkWith(agent, feed, sched, [sock1, sock2], {
    maxQueue: 3,
    diagnostic: (event) => diagnostics.push(event),
  });
  uplink.start();
  sock1.fireOpen();
  const phoneEnd = new FakePhone(phone, sock1);
  phoneEnd.bind();
  sock1.fireClose();

  // Replayable frames take no slot, however many there are.
  const alerts = ["s1", "s2", "s3", "s4"].map(
    (sessionId) => ({ t: "attention", sessionId, reason: "idle" }) as const,
  );
  for (const alert of alerts) {
    emit(alert);
    for (let i = 0; i < 10; i++) emit(msg(alert.sessionId, `${i}`));
  }

  sched.fireTimers();
  sock2.fireOpen();

  phoneEnd.read(sock2.sealed());
  // The replay, then the three newest alerts: the oldest was evicted...
  expect(phoneEnd.frames).toEqual([
    { t: "sessions", sessions: [] },
    ...alerts.slice(1),
  ]);
  // ...and the loss is reported, not silent.
  expect(diagnostics).toContainEqual({
    event: "uplink_frames_dropped",
    machineId,
    dropped: 1,
  });
  uplink.stop();
});

test("a replay larger than the old 256-frame queue arrives complete and in order through the byte cap", async () => {
  const { agent, phone } = await keypair();
  const { feed, setReplay } = makeFeed();
  const sched = new FakeScheduler();
  const first = new FakeSocket();
  const sock = new FakeSocket();
  sock.backpressure = true;
  const uplink = uplinkWith(agent, feed, sched, [first, sock], {
    maxBufferedBytes: 16 * 1024,
  });
  uplink.start();
  // A phone bound over an earlier link: the reconnect's replay is for it.
  first.fireOpen();
  const phoneEnd = new FakePhone(phone, first);
  phoneEnd.bind();
  first.fireClose();
  // One session's full backfill: the list first, then 1000 retained frames.
  const replay: ClientMessage[] = [
    { t: "sessions", sessions: [] },
    ...Array.from({ length: 1000 }, (_, i) => msg("s1", `entry ${i}`)),
  ];
  setReplay(replay);
  sched.fireTimers(); // the reconnect dials `sock`
  sock.fireOpen();

  // The socket buffer filled long before the replay ended; the rest waits.
  expect(sock.sealed().length).toBeLessThan(replay.length);
  // The network drains and each retry writes the next slice; no new outbound
  // frame is needed to move it.
  let retries = 0;
  while (sched.timers.length > 0 && retries < replay.length) {
    sock.bufferedAmount = 0;
    sched.fireTimers();
    retries += 1;
  }
  expect(retries).toBeGreaterThan(1);
  expect(sched.timers).toEqual([]);

  phoneEnd.read(sock.sealed());
  expect(phoneEnd.frames).toEqual(replay);
  uplink.stop();
});

test("while connected, frames the byte cap holds back are never dropped and drain on the retry timer alone", async () => {
  const { agent, phone } = await keypair();
  const { feed, emit } = makeFeed();
  const sched = new FakeScheduler();
  const sock = new FakeSocket();
  const uplink = uplinkWith(agent, feed, sched, [sock], {
    maxBufferedBytes: 1024,
  });
  uplink.start();
  sock.fireOpen();
  const phoneEnd = new FakePhone(phone, sock);
  phoneEnd.bind();
  const opened = sock.sealed().length; // the hello and replay sent on open, the ack

  sock.bufferedAmount = 4096; // a slow network: the buffer is over the cap
  const live = Array.from({ length: 300 }, (_, i) => msg("s1", `live ${i}`));
  for (const frame of live) emit(frame);
  expect(sock.sealed()).toHaveLength(opened); // all held back
  expect(sched.timers).toHaveLength(1); // one retry armed, not one per frame

  sched.fireTimers(); // still over the cap: nothing written, the retry re-arms
  expect(sock.sealed()).toHaveLength(opened);
  expect(sched.timers).toHaveLength(1);

  sock.bufferedAmount = 0; // the network caught up
  sched.fireTimers();
  phoneEnd.read(sock.sealed().slice(opened));
  expect(phoneEnd.frames).toEqual(live); // every frame, in order
  expect(sched.timers).toEqual([]); // drained: no retry left

  // stop() cancels a pending retry.
  sock.bufferedAmount = 4096;
  emit(msg("s1", "late"));
  expect(sched.timers).toHaveLength(1);
  uplink.stop();
  expect(sched.timers).toEqual([]);
});

test("frames still held back when the socket closes are not lost: transient ones follow the reconnect's replay", async () => {
  const { agent, phone } = await keypair();
  const { feed, emit, setReplay } = makeFeed();
  const sched = new FakeScheduler();
  const sock1 = new FakeSocket();
  const sock2 = new FakeSocket();
  const uplink = uplinkWith(agent, feed, sched, [sock1, sock2], {
    maxBufferedBytes: 1024,
  });
  uplink.start();
  sock1.fireOpen();
  const phoneEnd = new FakePhone(phone, sock1);
  phoneEnd.bind();
  const opened = sock1.sealed().length;
  sock1.bufferedAmount = 4096;
  const unsent = msg("s1", "unsent");
  emit(unsent);
  emit(attention);
  emit(ended);
  sock1.fireClose();
  expect(sock1.sealed()).toHaveLength(opened); // none reached the wire

  // Only the reconnect is pending: the dead socket's flush retry is gone.
  expect(sched.timers).toHaveLength(1);
  const replay: ClientMessage[] = [{ t: "sessions", sessions: [] }, unsent];
  setReplay(replay);
  sched.fireTimers();
  sock2.fireOpen();

  phoneEnd.read(sock2.sealed());
  expect(phoneEnd.frames).toEqual([...replay, attention, ended]);
  uplink.stop();
});

test("a backlog past the safety cap closes the socket instead of dropping frames", async () => {
  const { agent, phone } = await keypair();
  const { feed, emit, setReplay } = makeFeed();
  const sched = new FakeScheduler();
  const sock1 = new FakeSocket();
  const sock2 = new FakeSocket();
  const diagnostics: AgentDiagnostic[] = [];
  const uplink = uplinkWith(agent, feed, sched, [sock1, sock2], {
    maxBufferedBytes: 1024,
    diagnostic: (event) => diagnostics.push(event),
  });
  uplink.start();
  sock1.fireOpen();
  const phoneEnd = new FakePhone(phone, sock1);
  phoneEnd.bind();
  const written = sock1.sent.length;

  // A socket that stopped draining: the backlog grows to the cap, whole.
  sock1.bufferedAmount = 4096;
  for (let i = 0; i < MAX_CONNECTED_BACKLOG; i++) emit(msg("s1", `${i}`));
  expect(sock1.readyState).toBe(WS_OPEN);
  expect(diagnostics.map((e) => e.event)).not.toContain(
    "uplink_backlog_overflow",
  );

  // One frame more: rather than trim the backlog, the uplink drops the socket.
  const last = msg("s1", "one too many");
  emit(last);
  expect(sock1.readyState).toBe(3); // CLOSED
  expect(sock1.sent).toHaveLength(written); // nothing trimmed onto the wire
  expect(diagnostics).toContainEqual({
    event: "uplink_backlog_overflow",
    machineId,
    backlog: MAX_CONNECTED_BACKLOG + 1,
  });

  // The reconnect (the only timer left) rebuilds the phone's view in full.
  expect(sched.timers).toHaveLength(1);
  const replay: ClientMessage[] = [{ t: "sessions", sessions: [] }, last];
  setReplay(replay);
  sched.fireTimers();
  sock2.fireOpen();
  expect(sock2.controls()).toEqual([{ type: "register", machineId }]);
  phoneEnd.read(sock2.sealed());
  expect(phoneEnd.frames).toEqual(replay);
  uplink.stop();
});

test("a stale socket's inbound message after reconnect is ignored", async () => {
  const { agent, phone } = await keypair();
  const { feed, downlinks } = makeFeed();
  const sched = new FakeScheduler();
  const sock1 = new FakeSocket();
  const sock2 = new FakeSocket();
  const uplink = uplinkWith(agent, feed, sched, [sock1, sock2]);
  uplink.start();
  sock1.fireOpen();
  sock1.fireClose();
  sched.fireTimers();
  sock2.fireOpen(); // sock2 is now the live generation
  const phoneEnd = new FakePhone(phone, sock2);
  phoneEnd.bind();

  // A late prompt arriving on the dead sock1 must not be routed anywhere, though
  // the channel would open it: it is bound to the live epoch, with a new counter.
  phoneEnd.use(sock1);
  phoneEnd.channel.sendFrame({
    t: "prompt",
    sessionId: "s1",
    text: "stale",
    mode: "steer",
  });
  expect(downlinks).toEqual([]); // stale-generation event dropped

  // The live socket still routes a prompt through to the feed.
  phoneEnd.use(sock2);
  phoneEnd.channel.sendFrame({
    t: "prompt",
    sessionId: "s1",
    text: "live",
    mode: "steer",
  });
  expect(downlinks).toEqual([
    { t: "prompt", sessionId: "s1", text: "live", mode: "steer" },
  ]);
  uplink.stop();
});

test("reconnect diagnostics are bounded by backoff stage and reset after recovery", async () => {
  const { agent } = await keypair();
  const { feed } = makeFeed();
  const sched = new FakeScheduler();
  const sockets = [
    new FakeSocket(),
    new FakeSocket(),
    new FakeSocket(),
    new FakeSocket(),
  ];
  const diagnostics: AgentDiagnostic[] = [];
  const uplink = uplinkWith(agent, feed, sched, sockets, {
    backoff: { baseMs: 100, maxMs: 200, factor: 2 },
    diagnostic: (event) => diagnostics.push(event),
  });

  uplink.start();
  sockets[0]?.fireClose();
  sched.fireTimers();
  sockets[1]?.fireClose();
  sched.fireTimers();
  sockets[2]?.fireClose();
  sched.fireTimers();
  sockets[3]?.fireOpen();
  sockets[3]?.fireClose();

  expect(
    diagnostics.filter((event) => event.event === "uplink_reconnect_scheduled"),
  ).toEqual([
    {
      event: "uplink_reconnect_scheduled",
      machineId,
      retryDelayMs: 75,
      code: "transport-closed",
    },
    {
      event: "uplink_reconnect_scheduled",
      machineId,
      retryDelayMs: 150,
      code: "transport-closed",
    },
    {
      event: "uplink_reconnect_scheduled",
      machineId,
      retryDelayMs: 75,
      code: "transport-closed",
    },
  ]);
  expect(JSON.stringify(diagnostics)).not.toContain("ws://agg");
  expect(JSON.stringify(diagnostics)).not.toContain("tok");
  uplink.stop();
});

test("every dial hands the socket factory the bearer token, and register carries only the machineId", async () => {
  const { agent } = await keypair();
  const { feed } = makeFeed();
  const sched = new FakeScheduler();
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  const dials: { url: string; token: string }[] = [];
  const uplink = new Uplink({
    url: "ws://agg/agent",
    machineId,
    token: "tok",
    keys: agent,
    feed,
    scheduler: sched,
    keepaliveMs: 0,
    socketFactory: (url, token) => {
      const socket = sockets[dials.length];
      if (!socket) throw new Error(`unexpected dial #${dials.length}`);
      dials.push({ url, token });
      return socket;
    },
  });
  uplink.start();
  first.fireOpen();
  first.fireClose();
  sched.fireTimers(); // reconnect → second dial
  second.fireOpen();

  // The token rides every upgrade, including after a reconnect.
  expect(dials).toEqual([
    { url: "ws://agg/agent", token: "tok" },
    { url: "ws://agg/agent", token: "tok" },
  ]);
  // The token rides the upgrade only; never a frame.
  for (const socket of sockets)
    expect(socket.controls()).toContainEqual({ type: "register", machineId });
  uplink.stop();
});

/** One sealed frame per command type; the mapped type fails to compile when a
 *  new `DownlinkFrame` command is added without a case here. */
const commands: {
  [T in DownlinkCommand["t"]]: Extract<DownlinkCommand, { t: T }>;
} = {
  prompt: { t: "prompt", sessionId: "s1", text: "go", mode: "steer" },
  interrupt: { t: "interrupt", sessionId: "s1" },
  serviceTier: { t: "serviceTier", sessionId: "s1", enabled: true },
  spawn: {
    t: "spawn",
    machineId,
    cwd: "/tmp/project",
    approvalMode: "always-ask",
    spawnId: "sp1",
  },
  interactionReply: {
    t: "interactionReply",
    sessionId: "s1",
    id: "q1",
    response: { kind: "ask", answers: ["yes"] },
  },
  setModel: { t: "setModel", sessionId: "s1", model: "@task" },
  setThinkingLevel: { t: "setThinkingLevel", sessionId: "s1", level: "high" },
  compact: { t: "compact", sessionId: "s1", instructions: "short" },
  closeSession: { t: "closeSession", sessionId: "s1" },
  resourceInit: {
    t: "resourceInit",
    sessionId: "s1",
    transferId: "x1",
    name: "photo.png",
    mimeType: "image/png",
    size: 3,
    totalChunks: 1,
    sha256: "ab",
  },
  resourceChunk: {
    t: "resourceChunk",
    sessionId: "s1",
    transferId: "x1",
    index: 0,
    data: "AAAA",
  },
  resourceAbort: { t: "resourceAbort", sessionId: "s1", transferId: "x1" },
  mediaFetch: { t: "mediaFetch", sessionId: "s1", mediaId: "s1:0" },
  notifyPolicy: { t: "notifyPolicy", awaySec: 300 },
};

/** Open an uplink on a fake socket, with the paired phone bound to it. */
async function openedUplink(
  opts: {
    diagnostic?: (event: AgentDiagnostic) => void;
    maxBufferedBytes?: number;
  } = {},
) {
  const { agent, phone } = await keypair();
  const { feed, emit, setReplay, downlinks } = makeFeed();
  const sched = new FakeScheduler();
  const sock = new FakeSocket();
  const uplink = uplinkWith(agent, feed, sched, [sock], opts);
  uplink.start();
  sock.fireOpen();
  const phoneEnd = new FakePhone(phone, sock);
  phoneEnd.bind();
  return { uplink, sock, sched, phoneEnd, emit, setReplay, downlinks };
}

test.each(Object.values(commands).map((frame) => [frame.t, frame] as const))(
  "a sealed %s from the phone reaches the service router",
  async (_t, frame) => {
    const { uplink, phoneEnd, downlinks } = await openedUplink();
    phoneEnd.channel.sendFrame(frame);
    expect(downlinks).toEqual([frame]);
    uplink.stop();
  },
);

test("a sealed sync is answered with the full replay, behind any backlog, and never reaches the router", async () => {
  const { uplink, sock, sched, phoneEnd, emit, setReplay, downlinks } =
    await openedUplink({ maxBufferedBytes: 1024 });
  const opened = sock.sealed().length;
  const replay: ClientMessage[] = [
    { t: "sessions", sessions: [] },
    ...Array.from({ length: 300 }, (_, i) => msg("s1", `entry ${i}`)),
  ];
  setReplay(replay);

  sock.bufferedAmount = 4096; // a live frame is waiting behind the byte cap
  const live = msg("s1", "live");
  emit(live);
  phoneEnd.channel.sendFrame({ t: "sync" });
  expect(downlinks).toEqual([]);
  expect(sock.sealed()).toHaveLength(opened);

  sock.bufferedAmount = 0;
  sched.fireTimers();
  phoneEnd.read(sock.sealed().slice(opened));
  expect(phoneEnd.frames).toEqual([live, ...replay]);
  uplink.stop();
});

test("an agent-to-phone frame sealed back by the phone is rejected, not routed", async () => {
  const diagnostics: AgentDiagnostic[] = [];
  const { uplink, phoneEnd, downlinks } = await openedUplink({
    diagnostic: (event) => diagnostics.push(event),
  });
  phoneEnd.channel.sendFrame(msg("s1", "echo"));
  expect(downlinks).toEqual([]);
  expect(diagnostics).toContainEqual({
    event: "client_frame_rejected",
    code: "invalid-frame",
  });
  uplink.stop();
});

test("a phone prompt the relay records and feeds in again reaches the router once: on the same link, after a reconnect, or at a restarted agent", async () => {
  const { agent, phone } = await keypair();
  const { feed, downlinks } = makeFeed();
  const sched = new FakeScheduler();
  const sock1 = new FakeSocket();
  const sock2 = new FakeSocket();
  const diagnostics: AgentDiagnostic[] = [];
  const uplink = uplinkWith(agent, feed, sched, [sock1, sock2], {
    diagnostic: (event) => diagnostics.push(event),
  });
  uplink.start();
  sock1.fireOpen();
  const phoneEnd = new FakePhone(phone, sock1);
  phoneEnd.bind();

  const secret = "approve the deploy to production";
  const prompt: DownlinkCommand = {
    t: "prompt",
    sessionId: "s1",
    text: secret,
    mode: "steer",
  };
  phoneEnd.channel.sendFrame(prompt);
  const recorded = phoneEnd.wire.at(-1);
  if (recorded === undefined) throw new Error("the phone sent nothing");
  expect(downlinks).toEqual([prompt]);

  // The relay feeds the recorded line in again on the same socket, then once
  // more after the uplink has reconnected: the same agent run refuses both.
  // The aggregator's clear control on the same socket (a pong) is no rejected
  // frame, so only the two replays are reported.
  sock1.fireMessage(recorded);
  sock1.fireMessage(JSON.stringify({ type: "pong" }));
  sock1.fireClose();
  sched.fireTimers();
  sock2.fireOpen();
  sock2.fireMessage(recorded);
  expect(downlinks).toEqual([prompt]);
  expect(
    diagnostics.filter((event) => event.event === "client_frame_rejected"),
  ).toEqual([
    { event: "client_frame_rejected", code: "replayed" },
    { event: "client_frame_rejected", code: "replayed" },
  ]);
  uplink.stop();

  // A restarted agent (the same pairing keys, a fresh epoch) refuses it too.
  const restartedFeed = makeFeed();
  const sock3 = new FakeSocket();
  const restarted = uplinkWith(agent, restartedFeed.feed, sched, [sock3], {
    diagnostic: (event) => diagnostics.push(event),
  });
  restarted.start();
  sock3.fireOpen();
  sock3.fireMessage(recorded);
  expect(restartedFeed.downlinks).toEqual([]);
  expect(diagnostics.at(-1)).toEqual({
    event: "client_frame_rejected",
    code: "stale-epoch",
  });

  // The reports carry a reason code only: never the prompt, never an epoch.
  const header = SealedWireEnvelope.parse(JSON.parse(dec.decode(recorded)));
  if (header.a === undefined)
    throw new Error("the prompt names no agent epoch");
  const logged = JSON.stringify(diagnostics);
  expect(logged).not.toContain(secret);
  expect(logged).not.toContain(header.e);
  expect(logged).not.toContain(header.a);
  restarted.stop();
});

test("a relay feeding in garbage gets one report per kind of rejection on a connection, and a count of the rest when it closes", async () => {
  const { agent, phone } = await keypair();
  const { feed, downlinks } = makeFeed();
  const sched = new FakeScheduler();
  const sock1 = new FakeSocket();
  const sock2 = new FakeSocket();
  const diagnostics: AgentDiagnostic[] = [];
  const uplink = uplinkWith(agent, feed, sched, [sock1, sock2], {
    diagnostic: (event) => diagnostics.push(event),
  });
  const rejections = () =>
    diagnostics.filter(
      (event) =>
        event.event === "client_frame_rejected" ||
        event.event === "client_frame_rejections_suppressed",
    );
  uplink.start();
  sock1.fireOpen();
  const phoneEnd = new FakePhone(phone, sock1);
  phoneEnd.bind();
  const command: DownlinkCommand = { t: "interrupt", sessionId: "s1" };
  phoneEnd.channel.sendFrame(command);
  const recorded = phoneEnd.wire.at(-1);
  if (recorded === undefined) throw new Error("the phone sent nothing");

  // Ten thousand lines that are no envelope in one message, then the recorded
  // command three more times: each kind of rejection is reported once.
  sock1.fireMessage("garbage\n".repeat(10_000));
  for (let i = 0; i < 3; i++) sock1.fireMessage(recorded);
  expect(downlinks).toEqual([command]);
  expect(rejections()).toEqual([
    { event: "client_frame_rejected", code: "malformed" },
    { event: "client_frame_rejected", code: "replayed" },
  ]);

  // The connection closes: the rest are reported as one count per kind.
  sock1.fireClose();
  expect(rejections().slice(2)).toEqual([
    {
      event: "client_frame_rejections_suppressed",
      suppressedCount: { malformed: 9_999, replayed: 2 },
    },
  ]);

  // The next connection reports its own first rejection. With nothing past it
  // suppressed, stopping adds no count.
  sched.fireTimers();
  sock2.fireOpen();
  sock2.fireMessage("garbage");
  uplink.stop();
  expect(rejections().slice(3)).toEqual([
    { event: "client_frame_rejected", code: "malformed" },
  ]);
});

/** The pushes the aggregator was asked for on `sock`, opened as the phone
 *  opens them with its notify key. */
async function pushesOn(
  sock: FakeSocket,
  phone: SessionKeys,
): Promise<NotifyNotice[]> {
  const key = await notifyKey(phone.rx);
  const notices: NotifyNotice[] = [];
  for (const control of sock.controls()) {
    const push = AttentionMsg.safeParse(control);
    if (push.success && push.data.notice !== undefined)
      notices.push(
        await openNotice(
          key,
          NotifyEnvelope.parse(JSON.parse(push.data.notice)),
        ),
      );
  }
  return notices;
}

test("a question pushes a sealed notice, and the phone's reply to it pushes the clear", async () => {
  const { agent, phone } = await keypair();
  const { feed, emit, downlinks } = makeFeed();
  const sched = new FakeScheduler();
  const sock = new FakeSocket();
  const uplink = uplinkWith(agent, feed, sched, [sock], {
    notifyKey: await notifyKey(agent.tx),
  });
  uplink.start();
  sock.fireOpen();
  const phoneEnd = new FakePhone(phone, sock);
  phoneEnd.bind();
  const pushCount = () =>
    sock.controls().filter((c) => AttentionMsg.safeParse(c).success).length;

  emit({
    t: "interaction",
    sessionId: "s1",
    id: "q1",
    payload: { kind: "ask", questions: [{ question: "Ship it?" }] },
  });
  await sock.until(() => pushCount() === 1);

  const reply: DownlinkCommand = {
    t: "interactionReply",
    sessionId: "s1",
    id: "q1",
    response: { kind: "ask", answers: ["yes"] },
  };
  phoneEnd.channel.sendFrame(reply);
  expect(downlinks).toEqual([reply]);
  await sock.until(() => pushCount() === 2);
  expect(await pushesOn(sock, phone)).toEqual([
    {
      kind: "attention",
      sessionId: "s1",
      reason: "question",
      title: "",
      project: "",
      detail: "Ship it?",
    },
    { kind: "clear", sessionId: "s1" },
  ]);
  uplink.stop();
});
