import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ByteSink,
  SealedChannel,
  type SessionKeys,
  clientSessionKeys,
  newIdentity,
  serverSessionKeys,
} from "@omp-remote/crypto";
import {
  type Frame,
  type SealedFrame,
  type ServerControl,
  ServerControl as ServerControlSchema,
  type SessionMeta,
  UplinkFrame,
} from "@omp-remote/protocol";
import { connectIpc } from "@omp-remote/protocol/ipc";
import { AggregatorServer } from "../../../apps/aggregator/src/server";
import { tempMachineStore } from "../../../apps/aggregator/test/helpers/machines";
import { AttachmentUploader } from "../../../apps/web/src/core/resource-upload";
import { ResourceAssembler } from "../../bridge/src/resource-assembler";
import { SessionBridge } from "../../bridge/src/session-bridge";
import { AgentService } from "../src/service";
import { Uplink } from "../src/uplink";

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

const meta: SessionMeta = {
  id: "s1",
  cwd: "/x/p",
  project: "p",
  model: "m",
  title: "T",
  pid: 3,
  startedAt: 0,
};

function ipcAddr(): string {
  const rnd = Math.random().toString(36).slice(2);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-uplink-${rnd}`
    : join(tmpdir(), `omp-remote-uplink-${rnd}.sock`);
}

function toU8(data: unknown): Uint8Array {
  if (typeof data === "string") return enc.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array();
}

function control(data: unknown): ServerControl | undefined {
  let json: unknown;
  try {
    json = JSON.parse(dec.decode(toU8(data)).trim());
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

/** Poll `list` until the machine is present (or absent, if `present` is false). */
function pollMachine(
  ws: WebSocket,
  machineId: string,
  present: boolean,
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const onMsg = (e: MessageEvent) => {
    const msg = control(e.data);
    if (msg?.type !== "machines") return;
    if (msg.machineIds.includes(machineId) === present) {
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

/** A pull-based inbox over an IPC session's inbound frames. */
function makeInbox(onFrame: (cb: (f: Frame) => void) => void) {
  const queued: Frame[] = [];
  const waiters: Array<(f: Frame) => void> = [];
  onFrame((f) => {
    const w = waiters.shift();
    if (w) w(f);
    else queued.push(f);
  });
  return function next(): Promise<Frame> {
    const q = queued.shift();
    if (q) return Promise.resolve(q);
    const { promise, resolve } = Promise.withResolvers<Frame>();
    waiters.push(resolve);
    return promise;
  };
}

/** Resolve with the first `sessions` frame that lists `id`. */
function awaitSessionsWith(
  ch: SealedChannel,
  id: string,
): Promise<SealedFrame> {
  const { promise, resolve } = Promise.withResolvers<SealedFrame>();
  ch.onFrame((f) => {
    if (f.t === "sessions" && f.sessions.some((s) => s.id === id)) resolve(f);
  });
  return promise;
}

/**
 * A phone channel on `ws`, bound to the uplink: its hello reaches the agent and
 * resolves once the agent's ack verifies it. From then on the phone opens what
 * the agent broadcasts, and its commands open at the agent.
 */
async function boundPhone(
  keys: SessionKeys,
  ws: WebSocket,
  machineId: string,
): Promise<SealedChannel> {
  const phone = new SealedChannel(keys, wsSink(ws), machineId, {
    role: "initiator",
  });
  const bound = Promise.withResolvers<void>();
  phone.onReady(() => bound.resolve());
  phone.hello();
  await bound.promise;
  return phone;
}

test("backoff ceiling is exponential and bounded by maxMs", async () => {
  // Real pairing keys: deriving them also readies libsodium, which the
  // uplink's channel draws its epoch from at construction.
  const phoneId = await newIdentity();
  const machineIdentity = await newIdentity();
  const uplink = new Uplink({
    url: "ws://127.0.0.1:1",
    machineId: "m",
    token: "t",
    keys: await serverSessionKeys(machineIdentity, phoneId.publicKey),
    feed: {
      subscribe: () => () => {},
      replay: () => [{ t: "sessions", sessions: [] }],
      deliverDownlink: () => {},
    },
    backoff: { baseMs: 100, maxMs: 800, factor: 2 },
  });
  expect(uplink.backoffCeil(0)).toBe(100);
  expect(uplink.backoffCeil(1)).toBe(200);
  expect(uplink.backoffCeil(2)).toBe(400);
  expect(uplink.backoffCeil(3)).toBe(800);
  expect(uplink.backoffCeil(4)).toBe(800); // capped
  expect(uplink.backoffCeil(50)).toBe(800); // still capped, never overflows
});

test("phone lists the machine's session and a prompt reaches the local session", async () => {
  // The machine is listed only if the real uplink socket presented its
  // machine token at upgrade.
  const agg = new AggregatorServer({
    machines,
    port: 0,
  });
  agg.start();
  cleanups.push(() => agg.stop());
  const base = `ws://127.0.0.1:${agg.boundPort}`;
  const machineId = "machine-a";

  const phoneId = await newIdentity();
  const machineIdentity = await newIdentity();
  const phoneKeys = await clientSessionKeys(phoneId, machineIdentity.publicKey);
  const agentKeys = await serverSessionKeys(machineIdentity, phoneId.publicKey);

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

  // Phone attaches BEFORE the session exists, then observes it register.
  const phoneWs = new WebSocket(`${base}/client`);
  await wsOpen(phoneWs);
  cleanups.push(() => phoneWs.close());
  phoneWs.send(JSON.stringify({ type: "attach", machineId }));
  await pollMachine(phoneWs, machineId, true); // waits for the uplink to register

  // Capture every sealed line the aggregator relays to the phone: it must be an
  // opaque sealed envelope — never the session metadata plaintext.
  const relayedToPhone: string[] = [];
  phoneWs.addEventListener("message", (e) => {
    const line = dec.decode(toU8((e as MessageEvent).data)).trim();
    if (line.includes('"route"')) relayedToPhone.push(line);
  });

  // The agent acks the phone's hello, so its later broadcasts open phone-side.
  const phone = await boundPhone(phoneKeys, phoneWs, machineId);
  const sawSession = awaitSessionsWith(phone, "s1");

  // A bridge session registers over loopback IPC.
  const session = await connectIpc(ipcPath, "iptok");
  cleanups.push(() => session.close());
  session.send({ t: "hello", token: "iptok", session: meta });

  const sessions = await sawSession;
  expect(sessions.t === "sessions" && sessions.sessions[0]?.id).toBe("s1");

  // Blind proof: what the aggregator forwarded (the ack, the snapshot) is
  // opaque — the sensitive session cwd never appears in the wire, and each line
  // is a sealed envelope keyed by the clear machineId, not a parseable frame.
  expect(relayedToPhone.length).toBeGreaterThan(0);
  for (const line of relayedToPhone) {
    expect(line).not.toContain("/x/p");
    const wire = JSON.parse(line);
    expect(wire.route).toBe(machineId);
    expect(wire.t).toBeUndefined();
    expect(typeof wire.ct).toBe("string");
  }

  const inbox = makeInbox((cb) => session.onFrame(cb));
  const prompt: SealedFrame = {
    t: "prompt",
    sessionId: "s1",
    text: "do the thing",
    mode: "steer",
  };
  phone.sendFrame(prompt);
  expect(await inbox()).toEqual(prompt);
});

test("a sealed spawn from the phone reaches the agent's spawn handler", async () => {
  const agg = new AggregatorServer({ machines, port: 0 });
  agg.start();
  cleanups.push(() => agg.stop());
  const base = `ws://127.0.0.1:${agg.boundPort}`;
  const machineId = "machine-a";

  const phoneId = await newIdentity();
  const machineIdentity = await newIdentity();
  const phoneKeys = await clientSessionKeys(phoneId, machineIdentity.publicKey);
  const agentKeys = await serverSessionKeys(machineIdentity, phoneId.publicKey);

  const spawned = Promise.withResolvers<{
    cwd: string;
    model?: string;
    approvalMode?: string;
    spawnId?: string;
  }>();
  const svc = new AgentService({
    token: "iptok",
    ipcPath: ipcAddr(),
    spawn: (opts) => {
      spawned.resolve({
        cwd: opts.cwd,
        model: opts.model,
        approvalMode: opts.approvalMode,
        spawnId: opts.spawnId,
      });
      return { pid: 7, kill: () => {} };
    },
  });
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

  const phoneWs = new WebSocket(`${base}/client`);
  await wsOpen(phoneWs);
  cleanups.push(() => phoneWs.close());
  phoneWs.send(JSON.stringify({ type: "attach", machineId }));
  await pollMachine(phoneWs, machineId, true);
  const phone = await boundPhone(phoneKeys, phoneWs, machineId);

  phone.sendFrame({
    t: "spawn",
    machineId,
    cwd: "/x/new-proj",
    model: "opus",
    approvalMode: "yolo",
    spawnId: "spawn-nonce-1",
  });
  expect(await spawned.promise).toEqual({
    cwd: "/x/new-proj",
    model: "opus",
    approvalMode: "yolo",
    spawnId: "spawn-nonce-1",
  });
});

test("a late phone pulls the current snapshot with a sealed sync frame", async () => {
  const agg = new AggregatorServer({ machines, port: 0 });
  agg.start();
  cleanups.push(() => agg.stop());
  const base = `ws://127.0.0.1:${agg.boundPort}`;
  const machineId = "machine-a";

  const phoneId = await newIdentity();
  const machineIdentity = await newIdentity();
  const phoneKeys = await clientSessionKeys(phoneId, machineIdentity.publicKey);
  const agentKeys = await serverSessionKeys(machineIdentity, phoneId.publicKey);

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

  // Reach a STEADY machine: the session registers before any phone attaches, so
  // its snapshot broadcast reaches no client and the registry then stops changing.
  const session = await connectIpc(ipcPath, "iptok");
  cleanups.push(() => session.close());
  session.send({ t: "hello", token: "iptok", session: meta });

  const probeWs = new WebSocket(`${base}/client`);
  await wsOpen(probeWs);
  await pollMachine(probeWs, machineId, true); // uplink registered + session live
  probeWs.close();

  // A fresh phone attaches to the steady machine — no registry change follows, so
  // it gets no snapshot until it asks. A sealed `sync` pulls the current list.
  const phoneWs = new WebSocket(`${base}/client`);
  await wsOpen(phoneWs);
  cleanups.push(() => phoneWs.close());
  phoneWs.send(JSON.stringify({ type: "attach", machineId }));
  await pollMachine(phoneWs, machineId, true);
  // Bound by the agent's ack, which carries no snapshot: the sync pulls it.
  const phone = await boundPhone(phoneKeys, phoneWs, machineId);

  const sawSession = awaitSessionsWith(phone, "s1");
  phone.sendFrame({ t: "sync" });
  const sessions = await sawSession;
  expect(sessions.t === "sessions" && sessions.sessions[0]?.id).toBe("s1");
});

test("after the aggregator socket drops the uplink reconnects and re-registers", async () => {
  const agg1 = new AggregatorServer({ machines, port: 0 });
  agg1.start();
  const port = agg1.boundPort;
  const base = `ws://127.0.0.1:${port}`;
  const machineId = "machine-a";

  const phoneId = await newIdentity();
  const machineIdentity = await newIdentity();
  const phoneKeys = await clientSessionKeys(phoneId, machineIdentity.publicKey);
  const agentKeys = await serverSessionKeys(machineIdentity, phoneId.publicKey);

  const ipcPath = ipcAddr();
  const svc = new AgentService({ token: "iptok", ipcPath });
  await svc.start();
  cleanups.push(() => svc.stop());

  const session = await connectIpc(ipcPath, "iptok");
  cleanups.push(() => session.close());
  session.send({ t: "hello", token: "iptok", session: meta });
  const inbox = makeInbox((cb) => session.onFrame(cb));

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

  // Round 1: prove the link works.
  const phoneWs1 = new WebSocket(`${base}/client`);
  await wsOpen(phoneWs1);
  // The aggregator forwards a phone's sealed lines only on a route it attached.
  phoneWs1.send(JSON.stringify({ type: "attach", machineId }));
  await pollMachine(phoneWs1, machineId, true);
  const phone1 = await boundPhone(phoneKeys, phoneWs1, machineId);
  phone1.sendFrame({
    t: "prompt",
    sessionId: "s1",
    text: "one",
    mode: "steer",
  });
  expect(await inbox()).toEqual({
    t: "prompt",
    sessionId: "s1",
    text: "one",
    mode: "steer",
  });
  phoneWs1.close();

  // Kill the aggregator socket, then restart it on the SAME port.
  agg1.stop();
  const agg2 = new AggregatorServer({ machines, port });
  agg2.start();
  cleanups.push(() => agg2.stop());

  // Round 2: a fresh phone can only list the machine again once the uplink has
  // reconnected AND re-registered; a prompt still routing proves the sealed
  // channel was rebuilt end to end.
  const phoneWs2 = new WebSocket(`${base}/client`);
  await wsOpen(phoneWs2);
  cleanups.push(() => phoneWs2.close());
  phoneWs2.send(JSON.stringify({ type: "attach", machineId }));
  await pollMachine(phoneWs2, machineId, true);
  const phone2 = await boundPhone(phoneKeys, phoneWs2, machineId);
  phone2.sendFrame({
    t: "prompt",
    sessionId: "s1",
    text: "two",
    mode: "steer",
  });
  expect(await inbox()).toEqual({
    t: "prompt",
    sessionId: "s1",
    text: "two",
    mode: "steer",
  });
});

test("stop() tears down the registration and does not reconnect", async () => {
  const agg = new AggregatorServer({ machines, port: 0 });
  agg.start();
  cleanups.push(() => agg.stop());
  const base = `ws://127.0.0.1:${agg.boundPort}`;
  const machineId = "machine-a";

  const phoneId = await newIdentity();
  const machineIdentity = await newIdentity();
  const agentKeys = await serverSessionKeys(machineIdentity, phoneId.publicKey);

  const svc = new AgentService({
    token: "iptok",
    ipcPath: ipcAddr(),
  });
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

  const phoneWs = new WebSocket(`${base}/client`);
  await wsOpen(phoneWs);
  cleanups.push(() => phoneWs.close());
  await pollMachine(phoneWs, machineId, true);

  uplink.stop();
  // The route loses its agent; a fresh poll shows the machine gone and stays gone
  // (a reconnect would re-register it).
  await pollMachine(phoneWs, machineId, false);
});

test("an image upload completes end to end over the sealed uplink", async () => {
  const agg = new AggregatorServer({ machines, port: 0 });
  agg.start();
  cleanups.push(() => agg.stop());
  const base = `ws://127.0.0.1:${agg.boundPort}`;
  const machineId = "machine-a";

  const phoneId = await newIdentity();
  const machineIdentity = await newIdentity();
  const phoneKeys = await clientSessionKeys(phoneId, machineIdentity.publicKey);
  const agentKeys = await serverSessionKeys(machineIdentity, phoneId.publicKey);

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

  // The real bridge-side assembler, wired the way the omp extension wires it.
  const bridge = new SessionBridge({
    token: "iptok",
    path: ipcPath,
    meta,
    connect: connectIpc,
  });
  const assembler = new ResourceAssembler({
    onProgress: (transferId, received) =>
      bridge.emitResourceProgress(transferId, received),
    onReady: (transferId, resourceId) =>
      bridge.emitResourceReady(transferId, resourceId),
    onError: (transferId, code) => bridge.emitResourceError(transferId, code),
  });
  bridge.onResourceInit((frame) => assembler.init(frame));
  bridge.onResourceChunk((frame) => assembler.chunk(frame));
  bridge.onResourceAbort((transferId) => assembler.abort(transferId));

  const phoneWs = new WebSocket(`${base}/client`);
  await wsOpen(phoneWs);
  cleanups.push(() => phoneWs.close());
  phoneWs.send(JSON.stringify({ type: "attach", machineId }));
  await pollMachine(phoneWs, machineId, true);
  // Bound before the session registers, so its snapshot broadcast opens here.
  const phone = await boundPhone(phoneKeys, phoneWs, machineId);
  const sawSession = awaitSessionsWith(phone, "s1");
  await bridge.start();
  cleanups.push(() => bridge.stop());
  await sawSession;

  // The PWA's own uploader drives the transfer over the sealed channel.
  const uploader = new AttachmentUploader((_machine, frame) => {
    phone.sendFrame(frame);
    return true;
  });
  phone.onFrame((f) => {
    const parsed = UplinkFrame.safeParse(f);
    if (parsed.success) uploader.handleFrame(parsed.data);
  });
  // Three chunks, so ordering and reassembly are exercised too.
  const bytes = new Uint8Array(120 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251;
  const file = new File([bytes], "photo.png", { type: "image/png" });

  const resourceId = await uploader.upload(machineId, "s1", file, () => {});

  const resolved = assembler.resolve([resourceId]);
  expect(resolved.ok && resolved.resources).toEqual([
    { mimeType: "image/png", data: Buffer.from(bytes).toString("base64") },
  ]);
});
