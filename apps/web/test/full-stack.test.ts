import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SealedChannel,
  clientSessionKeys,
  newIdentity,
  serverSessionKeys,
} from "@omp-remote/crypto";
import {
  type Frame,
  RoutedEnvelope,
  ServerControl,
  type SessionMeta,
} from "@omp-remote/protocol";
import { connectIpc } from "@omp-remote/protocol/ipc";
import { AgentService } from "../../../packages/agent/src/service";
import { Uplink } from "../../../packages/agent/src/uplink";
import { AggregatorServer } from "../../aggregator/src/server";
import { tempMachineStore } from "../../aggregator/test/helpers/machines";
import { type ClientSocket, PhoneClient } from "../src/core/client";
import { AppStore } from "../src/core/store";

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

function toU8(data: unknown): Uint8Array {
  if (typeof data === "string") return enc.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array();
}

function ipcAddr(): string {
  const rnd = Math.random().toString(36).slice(2);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-fullstack-${rnd}`
    : join(tmpdir(), `omp-remote-fullstack-${rnd}.sock`);
}

function wsOpen(ws: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  ws.addEventListener("open", () => resolve(), { once: true });
  return promise;
}

/** Poll `list` on a raw probe socket until the machine has registered. */
function pollMachine(ws: WebSocket, machineId: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const onMsg = (e: MessageEvent) => {
    let json: unknown;
    try {
      json = JSON.parse(dec.decode(toU8(e.data)).trim());
    } catch {
      return;
    }
    const parsed = ServerControl.safeParse(json);
    if (!parsed.success || parsed.data.type !== "machines") return;
    if (parsed.data.machineIds.includes(machineId)) {
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

/** A raw wire line the phone exchanged with the aggregator, tagged by direction. */
interface WireLine {
  dir: "out" | "in";
  raw: string;
}

/**
 * A `ClientSocket` over a real `/client` WebSocket that records every raw line in
 * BOTH directions — exactly the bytes the content-blind aggregator handled for
 * this phone. The blind-relay assertion inspects `captured`.
 */
function spyClientSocket(url: string, captured: WireLine[]): ClientSocket {
  const ws = new WebSocket(url);
  return {
    send(raw) {
      captured.push({ dir: "out", raw });
      ws.send(raw);
    },
    onMessage(cb) {
      ws.addEventListener("message", (e) => {
        const raw = dec.decode(toU8((e as MessageEvent).data));
        captured.push({ dir: "in", raw });
        cb(raw);
      });
    },
    onOpen(cb) {
      ws.addEventListener("open", () => cb());
    },
    onClose(cb) {
      ws.addEventListener("close", (e) => cb(e.code));
    },
    close() {
      ws.close();
    },
  };
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

/**
 * The whole stack in one process: a bridge-double (over the real loopback IPC)
 * registers a session with the host-agent, whose `Uplink` seals its feed out
 * through the content-blind aggregator to the PWA client core (`PhoneClient` +
 * `AppStore`). Proves list + prompt + a streamed reply all traverse the sealed
 * channel and blind relay, and that the relay never saw a byte of plaintext.
 */
test("bridge → agent → aggregator → PWA lists, prompts, and streams a reply through the blind relay", async () => {
  // Distinctive secrets that must NEVER appear on the clear wire.
  const secretCwd = "/secret/quant-research";
  const secretProject = "quant-research";
  const secretPrompt = "SECRET_PROMPT_run_the_backtest";
  const secretReply = "SECRET_REPLY_backtest_complete_pnl_42";
  const secretTitle = "backtest-alpha";
  const sessionId = "sess-7b2e91";

  const session: SessionMeta = {
    id: sessionId,
    cwd: secretCwd,
    project: secretProject,
    model: "opus",
    title: secretTitle,
    pid: 11,
    startedAt: 100,
  };
  const machineId = "machine-a";

  // 1) Aggregator (content-blind WSS relay).
  const agg = new AggregatorServer({ machines, port: 0 });
  agg.start();
  cleanups.push(() => agg.stop());
  const base = `ws://127.0.0.1:${agg.boundPort}`;

  // 2) Per-connection sealed-channel keys derived on both ends via crypto.
  const phoneId = await newIdentity();
  const machineIdentity = await newIdentity();
  const phoneKeys = await clientSessionKeys(phoneId, machineIdentity.publicKey);
  const agentKeys = await serverSessionKeys(machineIdentity, phoneId.publicKey);

  // 3) Host-agent service + outbound uplink to the aggregator.
  const ipcPath = ipcAddr();
  const svc = new AgentService({ token: "iptok", ipcPath });
  await svc.start();
  cleanups.push(() => svc.stop());
  const uplink = new Uplink({
    url: `${base}/agent`,
    machineId,
    token: REGTOK,
    keys: agentKeys,
    feed: svc,
    backoff: { baseMs: 5, maxMs: 50, factor: 2 },
  });
  uplink.start();
  cleanups.push(() => uplink.stop());

  // Wait for the uplink to register before wiring the phone, so a route exists.
  const probe = new WebSocket(`${base}/client`);
  await wsOpen(probe);
  await pollMachine(probe, machineId);
  probe.close();

  // 4) Bridge-double: a real loopback-IPC client that registers a session and,
  //    on a relayed prompt, streams back a turn (state → msg start/update/end →
  //    state) exactly like the OMP bridge feeds the agent.
  const bridge = await connectIpc(ipcPath, "iptok");
  cleanups.push(() => bridge.close());
  const helloFrame: Frame = { t: "hello", token: "iptok", session };
  bridge.send(helloFrame);
  bridge.onFrame((f) => {
    if (f.t !== "prompt" || f.sessionId !== sessionId) return;
    const stream: Frame[] = [
      {
        t: "state",
        sessionId,
        model: session.model,
        contextPct: 5,
        streaming: true,
        title: secretTitle,
      },
      {
        t: "msg",
        sessionId,
        phase: "start",
        msgId: "m1",
        role: "assistant",
        text: "",
      },
      {
        t: "msg",
        sessionId,
        phase: "update",
        msgId: "m1",
        role: "assistant",
        text: "SECRET_REPLY_backtest",
      },
      {
        t: "msg",
        sessionId,
        phase: "end",
        msgId: "m1",
        role: "assistant",
        text: secretReply,
      },
      {
        t: "state",
        sessionId,
        model: session.model,
        contextPct: 6,
        streaming: false,
        title: secretTitle,
      },
    ];
    for (const frame of stream) bridge.send(frame);
  });

  // 5) PWA client core: one sealed channel per paired machine over the /client WS.
  const captured: WireLine[] = [];
  const store = new AppStore();
  const client = new PhoneClient(
    () => spyClientSocket(`${base}/client`, captured),
    [{ machineId, keys: phoneKeys }],
    store,
    { keepaliveMs: 0 },
  );
  client.start();
  cleanups.push(() => client.stop());

  // LIST: the machine → project → session tree assembles from the sealed snapshot.
  await whenStore(store, () => {
    const machine = store.tree().find((m) => m.machineId === machineId);
    return (
      machine?.projects.some((p) =>
        p.sessions.some((s) => s.id === sessionId),
      ) ?? false
    );
  });
  const machineNode = store.tree().find((m) => m.machineId === machineId);
  expect(machineNode).toBeDefined();
  const projectNode = machineNode?.projects.find(
    (p) => p.project === secretProject,
  );
  expect(projectNode?.sessions.map((s) => s.id)).toEqual([sessionId]);
  expect(projectNode?.sessions[0]?.cwd).toBe(secretCwd);

  // PROMPT: the phone seals a control frame over its channel; it must reach the
  // bridge-double through the relay + uplink + agent downlink routing.
  const channel = client.channelFor(machineId);
  expect(channel).toBeInstanceOf(SealedChannel);
  channel?.sendFrame({
    t: "prompt",
    sessionId,
    text: secretPrompt,
    mode: "steer",
  });

  // STREAMED REPLY: the transcript accumulates and finalizes from the relayed feed.
  await whenStore(store, () => {
    const t = store.transcriptFor(sessionId);
    const finished =
      t?.entries.some(
        (e) => e.kind === "message" && e.text === secretReply && !e.streaming,
      ) ?? false;
    // The terminal state frame (streaming:false) is the last frame of the turn.
    return finished && t?.footer?.streaming === false;
  });
  const transcript = store.transcriptFor(sessionId);
  const message = transcript?.entries.find((e) => e.kind === "message");
  expect(message?.kind === "message" && message.text).toBe(secretReply);
  expect(message?.kind === "message" && message.streaming).toBe(false);
  expect(transcript?.footer?.model).toBe("opus");
  expect(transcript?.footer?.streaming).toBe(false);

  // BLIND RELAY: content-blind proof. The list, prompt and reply all crossed the
  // wire, yet no secret plaintext ever appears; every content line is an opaque
  // {route, n, ct} envelope keyed only by the clear machineId, never a frame.
  expect(captured.length).toBeGreaterThan(0);
  const sealedLines = captured.filter((w) => w.raw.includes('"route"'));
  // Snapshot (in), prompt + sync (out) and the streamed reply (in) are all sealed.
  expect(sealedLines.filter((w) => w.dir === "in").length).toBeGreaterThan(0);
  expect(sealedLines.filter((w) => w.dir === "out").length).toBeGreaterThan(0);
  for (const { raw } of captured) {
    expect(raw).not.toContain(secretCwd);
    expect(raw).not.toContain(secretProject);
    expect(raw).not.toContain(secretPrompt);
    expect(raw).not.toContain(secretReply);
    expect(raw).not.toContain(secretTitle);
    expect(raw).not.toContain(sessionId);
  }
  for (const { raw } of sealedLines) {
    const wire = RoutedEnvelope.parse(JSON.parse(raw));
    expect(wire.route).toBe(machineId);
    // Opaque envelope: it carries ciphertext, never a readable frame discriminant.
    expect("t" in wire).toBe(false);
    expect(typeof wire.ct).toBe("string");
  }
});
