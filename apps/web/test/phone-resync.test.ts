import { afterEach, expect, test } from "bun:test";
import {
  type ByteSink,
  SealedChannel,
  type SessionKeys,
  clientSessionKeys,
  newIdentity,
  serverSessionKeys,
} from "@omp-remote/crypto";
import {
  type MsgFrame,
  type Scheduler,
  type SealedFrame,
  ServerControl,
  type SessionMeta,
} from "@omp-remote/protocol";
import type { WebSocket as BunWebSocket } from "bun";
import { AggregatorServer } from "../../aggregator/src/server";
import { dialAgent } from "../../aggregator/test/helpers/agent-socket";
import { tempMachineStore } from "../../aggregator/test/helpers/machines";
import { type ClientSocket, PhoneClient } from "../src/core/client";
import { AppStore } from "../src/core/store";
import type { MessageEntry } from "../src/core/transcript";

const machines = await tempMachineStore();
/** machine-a's `/agent` token. */
const REGTOK = await machines.issue("machine-a", 0);

const enc = new TextEncoder();
const dec = new TextDecoder();

// Everything a test spins up, torn down in reverse.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups.length = 0;
});

const MACHINE = "machine-a";

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

/** Resolve once `pred` holds — immediately, or on the next store emission. */
function whenStore(store: AppStore, pred: () => boolean): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (pred()) {
    resolve();
    return promise;
  }
  const unsub = store.subscribe(() => {
    if (pred()) {
      unsub();
      resolve();
    }
  });
  return promise;
}

/** The client's reconnect timer, run only when the test fires it. */
class ManualScheduler implements Scheduler {
  readonly #timers = new Set<() => void>();
  get pending(): number {
    return this.#timers.size;
  }
  setTimer(fn: () => void): () => void {
    this.#timers.add(fn);
    return () => {
      this.#timers.delete(fn);
    };
  }
  /** Keepalive is off in this test, so no interval ever runs. */
  setInterval(): () => void {
    return () => {};
  }
  fire(): void {
    const due = [...this.#timers];
    this.#timers.clear();
    for (const fn of due) fn();
  }
}

/** A real `/client` socket that can stop reading, as a phone on a stalled
 *  link does, and reports the code it closed with. */
interface PhoneSocket extends ClientSocket {
  pause(): void;
  resume(): void;
  readonly closed: Promise<number>;
}

function phoneSocket(url: string): PhoneSocket {
  const ws = new WebSocket(url);
  // Bun's WebSocket can stop reading; lib.dom's type, loaded workspace-wide,
  // does not declare `pause`/`resume`.
  const reading = ws as unknown as Pick<BunWebSocket, "pause" | "resume">;
  const closed = Promise.withResolvers<number>();
  ws.addEventListener("close", (e) => closed.resolve(e.code));
  return {
    send: (raw) => ws.send(raw),
    onMessage: (cb) =>
      ws.addEventListener("message", (e) => cb(dec.decode(toU8(e.data)))),
    onOpen: (cb) => ws.addEventListener("open", () => cb()),
    onClose: (cb) => ws.addEventListener("close", (e) => cb(e.code)),
    close: () => ws.close(),
    pause: () => {
      if (!reading.pause()) throw new Error("the phone socket cannot pause");
    },
    resume: () => {
      if (!reading.resume()) throw new Error("the phone socket cannot resume");
    },
    closed: closed.promise,
  };
}

/**
 * The host-agent end of the route, driven by hand over a real `/agent` socket:
 * it registers the machine and says hello as the uplink does, acks each phone
 * hello with the pairing keys (a responder channel with its own epoch, like a
 * host-agent process), answers every phone `sync` with `backfill()` — what a
 * resynced phone must end up showing — and queues every other frame it opens.
 */
class HostDouble {
  readonly #ws: WebSocket;
  readonly #channel: SealedChannel;
  #syncs = 0;
  readonly #commands: SealedFrame[] = [];
  #waiting: ((frame: SealedFrame) => void) | undefined;

  private constructor(
    ws: WebSocket,
    keys: SessionKeys,
    backfill: () => readonly SealedFrame[],
  ) {
    this.#ws = ws;
    const sink: ByteSink = {
      send: (bytes) => ws.send(bytes),
      onBytes: (cb) => ws.addEventListener("message", (e) => cb(toU8(e.data))),
    };
    this.#channel = new SealedChannel(keys, sink, MACHINE, {
      role: "responder",
    });
    this.#channel.onFrame((frame) => {
      if (frame.t !== "sync") {
        const waiting = this.#waiting;
        this.#waiting = undefined;
        if (waiting) waiting(frame);
        else this.#commands.push(frame);
        return;
      }
      this.#syncs += 1;
      for (const f of backfill()) this.#channel.sendFrame(f);
    });
  }

  static async dial(
    base: string,
    keys: SessionKeys,
    backfill: () => readonly SealedFrame[],
  ): Promise<HostDouble> {
    const ws = dialAgent(base, REGTOK);
    await wsOpen(ws);
    const host = new HostDouble(ws, keys, backfill);
    ws.send(JSON.stringify({ type: "register", machineId: MACHINE }));
    host.#channel.hello();
    await host.roundTrip();
    return host;
  }

  /** How many `sync`s reached the host. */
  get syncs(): number {
    return this.#syncs;
  }

  /** Stream a live frame to every attached phone. */
  send(frame: SealedFrame): void {
    this.#channel.sendFrame(frame);
  }

  /** The next frame other than `sync` the host opens (or already opened). */
  nextCommand(): Promise<SealedFrame> {
    const queued = this.#commands.shift();
    if (queued) return Promise.resolve(queued);
    const { promise, resolve } = Promise.withResolvers<SealedFrame>();
    this.#waiting = resolve;
    return promise;
  }

  /**
   * Ping and await the pong. The relay handles one socket's lines in order, so
   * once this resolves it has forwarded (or refused) every line sent before.
   */
  roundTrip(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const onMessage = (e: MessageEvent): void => {
      let json: unknown;
      try {
        json = JSON.parse(dec.decode(toU8(e.data)));
      } catch {
        return;
      }
      const parsed = ServerControl.safeParse(json);
      if (!parsed.success || parsed.data.type !== "pong") return;
      this.#ws.removeEventListener("message", onMessage);
      resolve();
    };
    this.#ws.addEventListener("message", onMessage);
    this.#ws.send(JSON.stringify({ type: "ping" }));
    return promise;
  }

  close(): void {
    this.#ws.close();
  }
}

const ALPHA: SessionMeta = {
  id: "sess-alpha",
  cwd: "/work/alpha",
  project: "alpha",
  model: "opus",
  title: "Alpha",
  pid: 11,
  startedAt: 100,
};
const BETA: SessionMeta = {
  id: "sess-beta",
  cwd: "/work/beta",
  project: "beta",
  model: "opus",
  title: "Beta",
  pid: 12,
  startedAt: 200,
};

const PROMPT: MsgFrame = {
  t: "msg",
  sessionId: ALPHA.id,
  phase: "end",
  msgId: "prompt",
  role: "user",
  text: "Check every service",
};
const REPLY = "All 42 services are healthy.";

function reply(phase: "update" | "end", text: string): SealedFrame {
  return {
    t: "msg",
    sessionId: ALPHA.id,
    phase,
    msgId: "reply",
    role: "assistant",
    text,
  };
}

function state(streaming: boolean): SealedFrame {
  return {
    t: "state",
    sessionId: ALPHA.id,
    model: "opus",
    contextPct: 5,
    streaming,
    title: "Alpha",
  };
}

/**
 * What the host streams while the phone reads nothing: 16 MiB of reply
 * snapshots, far past what the loopback kernel buffers absorb, so the relay's
 * per-socket backlog must outgrow its cap.
 */
const BURST_FRAMES = 256;
const FILLER = "x".repeat(64 * 1024);

/** Every session id the store's tree lists, sorted. */
function listed(store: AppStore): string[] {
  return store
    .tree()
    .flatMap((m) => m.projects.flatMap((p) => p.sessions.map((s) => s.id)))
    .sort();
}

test("a phone the relay closes for backpressure (1013) reconnects, resyncs, and ends with the whole list and transcript", async () => {
  // A cap tiny next to what a stalled phone falls behind by.
  const agg = new AggregatorServer({
    machines,
    port: 0,
    maxBufferedBytes: 1024,
  });
  agg.start();
  cleanups.push(() => agg.stop());
  const base = `ws://127.0.0.1:${agg.boundPort}`;

  const phoneId = await newIdentity();
  const hostId = await newIdentity();
  const phoneKeys = await clientSessionKeys(phoneId, hostId.publicKey);
  const hostKeys = await serverSessionKeys(hostId, phoneId.publicKey);

  // What the host holds, and so what a `sync` backfills.
  let held: SealedFrame[] = [
    { t: "sessions", sessions: [ALPHA] },
    PROMPT,
    state(true),
  ];
  const host = await HostDouble.dial(base, hostKeys, () => held);
  cleanups.push(() => host.close());

  const store = new AppStore();
  const scheduler = new ManualScheduler();
  const sockets: PhoneSocket[] = [];
  const client = new PhoneClient(
    () => {
      const socket = phoneSocket(`${base}/client`);
      sockets.push(socket);
      return socket;
    },
    [{ machineId: MACHINE, keys: phoneKeys }],
    store,
    { keepaliveMs: 0, scheduler },
  );
  client.start();
  cleanups.push(() => client.stop());

  const replyEntry = (): MessageEntry | undefined => {
    for (const e of store.transcriptFor(ALPHA.id)?.entries ?? [])
      if (e.kind === "message" && e.msgId === "reply") return e;
    return undefined;
  };
  const turnDone = (): boolean =>
    replyEntry()?.text === REPLY &&
    replyEntry()?.streaming === false &&
    store.transcriptFor(ALPHA.id)?.footer?.streaming === false;

  // The first connection's sync backfills what the host holds.
  await whenStore(
    store,
    () => store.transcriptFor(ALPHA.id)?.footer?.streaming === true,
  );
  expect(host.syncs).toBe(1);
  const first = sockets[0];
  if (first === undefined) throw new Error("the client never dialled");

  // The phone stops reading while the host streams a long reply, announces a
  // new session, and ends the turn.
  first.pause();
  for (let i = 0; i < BURST_FRAMES; i++)
    host.send(reply("update", `${i} ${FILLER}`));
  host.send({ t: "sessions", sessions: [ALPHA, BETA] });
  host.send(reply("end", REPLY));
  host.send(state(false));
  await host.roundTrip();
  held = [
    { t: "sessions", sessions: [ALPHA, BETA] },
    PROMPT,
    reply("end", REPLY),
    state(false),
  ];

  // Reading again, the phone gets what the relay queued before it gave up,
  // then the close: 1013, not a silent gap in the stream.
  first.resume();
  expect(await first.closed).toBe(1013);
  expect(listed(store)).toEqual([ALPHA.id]);
  expect(turnDone()).toBe(false);

  // The client scheduled a reconnect; the new socket re-attaches and resyncs.
  expect(scheduler.pending).toBe(1);
  scheduler.fire();
  expect(sockets).toHaveLength(2);
  await whenStore(store, turnDone);
  expect(host.syncs).toBe(2);
  expect(client.relayState).toBe("connected");
  expect(listed(store)).toEqual([ALPHA.id, BETA.id]);
  expect(
    store
      .transcriptFor(ALPHA.id)
      ?.entries.map((e) =>
        e.kind === "message" ? `${e.role}: ${e.text}` : e.kind,
      ),
  ).toEqual([`user: ${PROMPT.text}`, `assistant: ${REPLY}`]);
  // Sealing and relaying the 16 MiB burst takes ~0.4 s on the Windows desktop
  // but ~11 s on a loaded Linux host, so the 5 s default would fail it there.
}, 60_000);

test("after the host-agent restarts, the phone binds to the new process, resyncs, and its next prompt reaches it", async () => {
  const agg = new AggregatorServer({ machines, port: 0 });
  agg.start();
  cleanups.push(() => agg.stop());
  const base = `ws://127.0.0.1:${agg.boundPort}`;

  const phoneId = await newIdentity();
  const hostId = await newIdentity();
  const phoneKeys = await clientSessionKeys(phoneId, hostId.publicKey);
  const hostKeys = await serverSessionKeys(hostId, phoneId.publicKey);

  const dead = await HostDouble.dial(base, hostKeys, () => [
    { t: "sessions", sessions: [ALPHA] },
  ]);
  cleanups.push(() => dead.close());
  const store = new AppStore();
  const client = new PhoneClient(
    () => phoneSocket(`${base}/client`),
    [{ machineId: MACHINE, keys: phoneKeys }],
    store,
    { keepaliveMs: 0, scheduler: new ManualScheduler() },
  );
  client.start();
  cleanups.push(() => client.stop());
  await whenStore(store, () => listed(store).length === 1);
  expect(dead.syncs).toBe(1);

  // The host-agent process dies and a new one registers the route: the same
  // pairing keys, a fresh channel epoch. The phone's socket stays up.
  dead.close();
  const fresh = await HostDouble.dial(base, hostKeys, () => [
    { t: "sessions", sessions: [ALPHA, BETA] },
  ]);
  cleanups.push(() => fresh.close());

  // Its hello makes the phone say hello again; the ack binds the phone to the
  // new process and pulls exactly one sync, whose backfill lands.
  await whenStore(store, () => listed(store).length === 2);
  expect(fresh.syncs).toBe(1);
  expect(listed(store)).toEqual([ALPHA.id, BETA.id]);

  // A prompt sent afterwards reaches the new process.
  const prompt: SealedFrame = {
    t: "prompt",
    sessionId: ALPHA.id,
    text: "Any errors since the restart?",
    mode: "steer",
  };
  client.channelFor(MACHINE)?.sendFrame(prompt);
  expect(await fresh.nextCommand()).toEqual(prompt);
});
