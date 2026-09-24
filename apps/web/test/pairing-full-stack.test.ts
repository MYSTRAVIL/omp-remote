import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SealedChannel,
  clientSessionKeys,
  hostCommitment,
  newIdentity,
  newPairingCode,
  pairingSas,
  phoneCommitment,
  serverSessionKeys,
  verifyPeerMac,
} from "@omp-remote/crypto";
import {
  type Frame,
  PairClaimResponse,
  PairHostResponse,
  PairResultResponse,
  RoutedEnvelope,
  ServerControl,
  type SessionMeta,
} from "@omp-remote/protocol";
import { connectIpc } from "@omp-remote/protocol/ipc";
import { AgentService } from "../../../packages/agent/src/service";
import { Uplink } from "../../../packages/agent/src/uplink";
import { PairingBroker } from "../../aggregator/src/pairing";
import { AggregatorServer } from "../../aggregator/src/server";
import { tempMachineStore } from "../../aggregator/test/helpers/machines";
import { type ClientSocket, PhoneClient } from "../src/core/client";
import { AppStore } from "../src/core/store";

const enc = new TextEncoder();
const dec = new TextDecoder();

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
    ? `\\\\.\\pipe\\omp-remote-pairfs-${rnd}`
    : join(tmpdir(), `omp-remote-pairfs-${rnd}.sock`);
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

interface WireLine {
  dir: "in" | "out";
  raw: string;
}

/** A `/client` socket that records every raw line both ways for the blind-relay proof. */
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

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The whole stack driven by REAL pairing: the host and phone exchange their
 * device public keys THROUGH the aggregator's brokered `/pair/*` ceremony (code
 * generated on the host, MAC-bound to it), each verifies the peer's MAC, and the
 * per-session keys are derived from the keys the broker relayed — NOT from a
 * test-only shortcut. Those paired keys then carry the list + prompt + streamed
 * reply through the content-blind relay, and the relay still sees no plaintext.
 */
test("pairing via the broker yields keys that drive list/prompt/reply through the blind relay", async () => {
  const secretCwd = "/secret/quant-research";
  const secretProject = "quant-research";
  const secretPrompt = "SECRET_PROMPT_run_the_backtest";
  const secretReply = "SECRET_REPLY_backtest_complete_pnl_42";
  const secretTitle = "backtest-alpha";
  const sessionId = "sess-7b2e91";
  const machineId = "machine-a";

  const session: SessionMeta = {
    id: sessionId,
    cwd: secretCwd,
    project: secretProject,
    model: "opus",
    title: secretTitle,
    pid: 11,
    startedAt: 100,
  };

  // 1) Content-blind aggregator with the pairing broker mounted. No machine
  //    holds a token yet: the pairing below issues machine-a's.
  const machines = await tempMachineStore();
  const agg = new AggregatorServer({
    machines,
    port: 0,
    pairing: new PairingBroker(),
  });
  agg.start();
  cleanups.push(() => agg.stop());
  const httpBase = `http://127.0.0.1:${agg.boundPort}`;
  const wsBase = `ws://127.0.0.1:${agg.boundPort}`;

  // 2) Long-term device identities (host + phone). These never cross the wire;
  //    only their PUBLIC keys do, MAC-bound to the out-of-band pairing code.
  const host = await newIdentity();
  const phone = await newIdentity();

  // 3) THE PAIRING CEREMONY over the broker's HTTP routes.
  const code = await newPairingCode();
  const hostSide = await hostCommitment(code, machineId, host.publicKey);
  // No bearer: the host has no token until the phone claims.
  const hostRes = await postJson(`${httpBase}/pair/host`, {
    machineId,
    rendezvousId: hostSide.rendezvousId,
    hostPub: host.publicKey,
    hostMac: hostSide.mac,
  });
  expect(hostRes.status).toBe(200);
  expect(
    PairHostResponse.parse(await hostRes.json()).expiresAt,
  ).toBeGreaterThan(0);

  // Phone derives the SAME rendezvous from the typed code, claims, and verifies
  // the host's MAC over the host key the broker handed it.
  const phoneSide = await phoneCommitment(code, phone.publicKey);
  expect(phoneSide.rendezvousId).toBe(hostSide.rendezvousId);
  const claimRes = await postJson(`${httpBase}/pair/claim`, {
    rendezvousId: phoneSide.rendezvousId,
    phonePub: phone.publicKey,
    phoneMac: phoneSide.mac,
  });
  expect(claimRes.status).toBe(200);
  const claim = PairClaimResponse.parse(await claimRes.json());
  expect(claim.machineId).toBe(machineId);
  expect(
    await verifyPeerMac(
      code,
      "host",
      claim.hostPub,
      claim.hostMac,
      claim.machineId,
    ),
  ).toBe(true);
  // F1 regression: a relay that relabels the machineId (but forwards the real
  // host key + MAC) is rejected — machineId is now bound into the host MAC.
  expect(
    await verifyPeerMac(
      code,
      "host",
      claim.hostPub,
      claim.hostMac,
      "evil-machine",
    ),
  ).toBe(false);

  // Host polls the result and verifies the phone's MAC over the phone key.
  const resultRes = await postJson(`${httpBase}/pair/result`, {
    rendezvousId: hostSide.rendezvousId,
  });
  expect(resultRes.status).toBe(200);
  const result = PairResultResponse.parse(await resultRes.json());
  if (result.status !== "claimed")
    throw new Error("expected the pairing to be claimed");
  expect(
    await verifyPeerMac(code, "phone", result.phonePub, result.phoneMac),
  ).toBe(true);

  // The SAS both sides compute from the code + both public keys must agree.
  const hostSas = await pairingSas(
    code,
    machineId,
    host.publicKey,
    result.phonePub,
  );
  const phoneSas = await pairingSas(
    code,
    claim.machineId,
    claim.hostPub,
    phone.publicKey,
  );
  expect(hostSas).toBe(phoneSas);

  // 4) Per-session keys derived from the keys the BROKER relayed (the pairing
  //    output), not from directly-shared identities.
  const phoneKeys = await clientSessionKeys(phone, claim.hostPub);
  const agentKeys = await serverSessionKeys(host, result.phonePub);

  // 5) Host-agent service + outbound uplink keyed by the paired agent keys.
  const ipcPath = ipcAddr();
  const svc = new AgentService({ token: "iptok", ipcPath });
  await svc.start();
  cleanups.push(() => svc.stop());
  // The uplink dials with the token the pairing issued for this machine.
  const uplink = new Uplink({
    url: `${wsBase}/agent`,
    machineId,
    token: result.agentToken,
    keys: agentKeys,
    feed: svc,
    backoff: { baseMs: 5, maxMs: 50, factor: 2 },
  });
  uplink.start();
  cleanups.push(() => uplink.stop());

  const probe = new WebSocket(`${wsBase}/client`);
  await wsOpen(probe);
  await pollMachine(probe, machineId);
  probe.close();

  // 6) Bridge-double: registers a session and streams a turn on a relayed prompt.
  const bridge = await connectIpc(ipcPath, "iptok");
  cleanups.push(() => bridge.close());
  bridge.send({ t: "hello", token: "iptok", session } satisfies Frame);
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

  // 7) PWA client core keyed by the paired phone keys.
  const captured: WireLine[] = [];
  const store = new AppStore();
  const client = new PhoneClient(
    () => spyClientSocket(`${wsBase}/client`, captured),
    [{ machineId, keys: phoneKeys }],
    store,
    { keepaliveMs: 0 },
  );
  client.start();
  cleanups.push(() => client.stop());

  // LIST via the sealed snapshot.
  await whenStore(store, () => {
    const machine = store.tree().find((m) => m.machineId === machineId);
    return (
      machine?.projects.some((p) =>
        p.sessions.some((s) => s.id === sessionId),
      ) ?? false
    );
  });
  const projectNode = store
    .tree()
    .find((m) => m.machineId === machineId)
    ?.projects.find((p) => p.project === secretProject);
  expect(projectNode?.sessions.map((s) => s.id)).toEqual([sessionId]);
  expect(projectNode?.sessions[0]?.cwd).toBe(secretCwd);

  // PROMPT sealed under the paired keys, reaching the bridge-double.
  const channel = client.channelFor(machineId);
  expect(channel).toBeInstanceOf(SealedChannel);
  channel?.sendFrame({
    t: "prompt",
    sessionId,
    text: secretPrompt,
    mode: "steer",
  });

  // STREAMED REPLY finalizes from the relayed feed.
  await whenStore(store, () => {
    const t = store.transcriptFor(sessionId);
    const finished =
      t?.entries.some(
        (e) => e.kind === "message" && e.text === secretReply && !e.streaming,
      ) ?? false;
    return finished && t?.footer?.streaming === false;
  });
  const transcript = store.transcriptFor(sessionId);
  const message = transcript?.entries.find((e) => e.kind === "message");
  expect(message?.kind === "message" && message.text).toBe(secretReply);
  expect(transcript?.footer?.model).toBe("opus");

  // BLIND RELAY: no session plaintext ever crosses the wire under the paired keys.
  expect(captured.length).toBeGreaterThan(0);
  const sealedLines = captured.filter((w) => w.raw.includes('"route"'));
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
    expect("t" in wire).toBe(false);
    expect(typeof wire.ct).toBe("string");
  }
});
