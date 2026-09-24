import { afterEach, expect, test } from "bun:test";
import {
  SealedChannel,
  clientSessionKeys,
  newIdentity,
  notifyKey,
  serverSessionKeys,
} from "@omp-remote/crypto";
import {
  AttentionMsg,
  type ClientMessage,
  type DownlinkFrame,
  NotifyEnvelope,
  type SealedFrame,
  SealedWireEnvelope,
  type SessionMeta,
  openNotice,
} from "@omp-remote/protocol";
import type { Server, ServerWebSocket } from "bun";
import { type SessionFeed, Uplink } from "../src/uplink";

const enc = new TextEncoder();
const dec = new TextDecoder();

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** The session the feed lists; its id and title must never cross in the clear. */
const listed: SessionMeta = {
  id: "session-7f3a-private",
  cwd: "/work/shop",
  project: "web-shop",
  model: "m",
  title: "Fix the checkout bug",
  pid: 1,
  startedAt: 0,
};

/** A feed whose emitted frames the test drives directly. */
class FakeFeed implements SessionFeed {
  #sink: ((msg: ClientMessage) => void) | undefined;
  readonly downlinks: DownlinkFrame[] = [];
  snapshot(): ClientMessage {
    return { t: "sessions", sessions: [listed] };
  }
  replay(): ClientMessage[] {
    return [this.snapshot()];
  }
  subscribe(sink: (msg: ClientMessage) => void): () => void {
    this.#sink = sink;
    sink(this.snapshot());
    return () => {
      this.#sink = undefined;
    };
  }
  deliverDownlink(frame: DownlinkFrame): void {
    this.downlinks.push(frame);
  }
  emit(msg: ClientMessage): void {
    this.#sink?.(msg);
  }
}

/** The kind in a line's clear sealed header (`h`/`d`/`a`); `undefined` if not sealed. */
function kindOf(raw: string): SealedWireEnvelope["k"] | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const env = SealedWireEnvelope.safeParse(json);
  return env.success ? env.data.k : undefined;
}

/** A minimal WS server that records every line an agent sends it and can answer that agent. */
function recordingServer(): {
  server: Server<undefined>;
  received: string[];
  waitFor: (pred: (r: string) => boolean) => Promise<void>;
  /** The agent's socket, server side: a line sent on it reaches the uplink. */
  agent: Promise<ServerWebSocket<undefined>>;
} {
  const received: string[] = [];
  const waiters: Array<{ pred: (r: string) => boolean; resolve: () => void }> =
    [];
  const agent = Promise.withResolvers<ServerWebSocket<undefined>>();
  const push = (raw: string): void => {
    received.push(raw);
    for (const w of [...waiters])
      if (w.pred(raw)) {
        w.resolve();
        waiters.splice(waiters.indexOf(w), 1);
      }
  };
  const server = Bun.serve({
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req)) return undefined;
      return new Response("no", { status: 426 });
    },
    websocket: {
      open(ws) {
        agent.resolve(ws);
      },
      message(_ws, raw) {
        push(typeof raw === "string" ? raw : raw.toString("utf8"));
      },
    },
  });
  cleanups.push(() => server.stop(true));
  const waitFor = (pred: (r: string) => boolean): Promise<void> => {
    if (received.some(pred)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ pred, resolve });
    return promise;
  };
  return { server, received, waitFor, agent: agent.promise };
}

/** Whether a line is the agent asking the aggregator for a push. */
function isPushRequest(raw: string): boolean {
  try {
    return AttentionMsg.safeParse(JSON.parse(raw)).success;
  } catch {
    return false;
  }
}

test("a session needing the user reaches the phone sealed, and the aggregator only as a push it cannot open", async () => {
  const { server, received, waitFor, agent } = recordingServer();
  const phoneId = await newIdentity();
  const agentId = await newIdentity();
  const keys = await serverSessionKeys(agentId, phoneId.publicKey);
  const feed = new FakeFeed();
  const uplink = new Uplink({
    url: `ws://127.0.0.1:${server.port}/agent`,
    machineId: "m1",
    token: "tok",
    keys,
    feed,
    // Derived as the agent's entry point does; presence unknown, so the push
    // goes out at once.
    notifyKey: await notifyKey(keys.tx),
    hostIdleMs: () => null,
  });
  cleanups.push(() => uplink.stop());
  uplink.start();

  // Wait until the agent registered + sent its initial sealed snapshot.
  await waitFor((r) => r.includes('"register"'));
  await waitFor((r) => r.includes('"route"'));

  // The paired phone shakes hands through this server, which plays the relay:
  // its hello goes to the agent, and the agent's ack is handed back to it.
  const agentWs = await agent;
  const phoneKeys = await clientSessionKeys(phoneId, agentId.publicKey);
  let toPhone: ((b: Uint8Array) => void) | undefined;
  const phone = new SealedChannel(
    phoneKeys,
    {
      send: (b) => agentWs.send(dec.decode(b)),
      onBytes: (cb) => {
        toPhone = cb;
      },
    },
    "m1",
    { role: "initiator" },
  );
  const opened: SealedFrame[] = [];
  phone.onFrame((f) => opened.push(f));
  const relayToPhone = (lines: readonly string[]): void => {
    for (const line of lines) toPhone?.(enc.encode(line));
  };
  phone.hello();
  await waitFor((r) => kindOf(r) === "a");
  relayToPhone(received.filter((r) => kindOf(r) === "a"));
  const beforeAttention = received.length;

  // A plain msg frame asks for no push; a session needing the user does.
  const working: ClientMessage = {
    t: "msg",
    sessionId: listed.id,
    phase: "update",
    msgId: "m",
    role: "assistant",
    text: "The private refund fix is ready.",
  };
  const attention: ClientMessage = {
    t: "attention",
    sessionId: listed.id,
    reason: "idle",
  };
  feed.emit(working);
  feed.emit(attention);
  await waitFor(isPushRequest);

  // One push request, whose only payload is the sealed notice: no session
  // id, title or text crosses the aggregator in the clear.
  const pushes = received.filter(isPushRequest);
  expect(pushes).toHaveLength(1);
  const [line = ""] = pushes;
  const push = AttentionMsg.parse(JSON.parse(line));
  expect(Object.keys(JSON.parse(line)).sort()).toEqual(["notice", "type"]);
  for (const secret of [listed.id, "checkout", "refund"])
    expect(line).not.toContain(secret);
  const envelope = NotifyEnvelope.parse(JSON.parse(push.notice ?? ""));
  expect(Object.keys(envelope).sort()).toEqual(["ct", "m", "n", "v"]);
  // The paired phone opens it with the key it derives from its own `rx`.
  expect(await openNotice(await notifyKey(phoneKeys.rx), envelope)).toEqual({
    kind: "attention",
    sessionId: listed.id,
    reason: "idle",
    title: "Fix the checkout bug",
    project: "web-shop",
    detail: "The private refund fix is ready.",
  });

  // Both frames also went out SEALED to the phone. The aggregator only ever
  // sees opaque envelopes: the route, the sender's epoch and counter, and
  // sealed bytes.
  const sealed = received
    .slice(beforeAttention)
    .filter((r) => r.includes('"route"'));
  expect(sealed.length).toBeGreaterThan(0);
  for (const line of sealed) {
    const wire: unknown = JSON.parse(line);
    // No plaintext session-metadata field: adding a clear field (e.g. a leaked
    // sessionId) breaks this exact-key assertion.
    expect(
      typeof wire === "object" && wire !== null ? Object.keys(wire).sort() : [],
    ).toEqual(["c", "ct", "e", "k", "n", "route"]);
    expect(SealedWireEnvelope.parse(wire).route).toBe("m1");
  }
  // The paired phone authenticates and opens every one under its own receive
  // key. The sealed payloads carry EXACTLY the msg and the attention. A missing
  // or wrong payload fails here.
  relayToPhone(sealed);
  expect(opened).toEqual([working, attention]);
});
