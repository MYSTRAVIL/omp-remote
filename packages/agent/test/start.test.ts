import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, secretPaths } from "@omp-remote/config";
import {
  SealedChannel,
  type SessionKeys,
  clientSessionKeys,
  newIdentity,
} from "@omp-remote/crypto";
import { PairingStore } from "@omp-remote/crypto/pairing-store";
import { MachinesMsg, type SealedRefusal } from "@omp-remote/protocol";
import { IpcServer } from "@omp-remote/protocol/ipc";
import { z } from "zod";
import { MachineStore } from "../../../apps/aggregator/src/machine-store";
import { startServer } from "../../../apps/aggregator/src/main";
import { writeCheapPassword } from "../../../apps/aggregator/test/helpers/password";
import { startAgent } from "../src/main";

const enc = new TextEncoder();
const dec = new TextDecoder();

const ENV_KEYS = ["OMP_REMOTE_STATE_DIR", "OMP_REMOTE_IPC_PATH"] as const;
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

/** A fresh state dir and a private IPC endpoint, both set in the env. */
async function freshState(): Promise<{ dir: string; ipcPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "omp-remote-agent-start-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const id = Math.random().toString(36).slice(2);
  const ipcPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\omp-remote-start-${id}`
      : join(dir, "agent.sock");
  process.env.OMP_REMOTE_STATE_DIR = dir;
  process.env.OMP_REMOTE_IPC_PATH = ipcPath;
  return { dir, ipcPath };
}

test("startAgent fails with ipc-endpoint-in-use when another process owns its IPC endpoint", async () => {
  const { ipcPath } = await freshState();
  const squatter = new IpcServer();
  await squatter.listen(ipcPath);
  cleanups.push(() => squatter.close());

  const cfg = Config.parse({
    version: 1,
    machineId: "box",
    agent: { serverUrl: "http://127.0.0.1:1" },
  });
  await expect(startAgent(cfg)).rejects.toMatchObject({
    code: "ipc-endpoint-in-use",
  });
});

test("startServer and startAgent from one config: the machine comes online on the router", async () => {
  const { dir } = await freshState();
  // What `init` leaves behind: this machine's token, a paired phone, a password.
  const machines = await MachineStore.load(secretPaths.machines);
  await writeFile(
    secretPaths.agentToken,
    await machines.issue("box", Date.now()),
  );
  const phone = await newIdentity();
  const pairing = new PairingStore(secretPaths.pairing);
  await pairing.load();
  await pairing.trust({ id: "phone-1", publicKey: phone.publicKey });
  // Set a second back: a session issued in the same second as the password
  // (`iat` has second granularity) would count as issued before it.
  await writeCheapPassword(
    secretPaths.password,
    "correct horse",
    Date.now() - 1000,
  );

  const cfg = Config.parse({
    version: 1,
    machineId: "box",
    server: { listen: { host: "127.0.0.1", port: 0 }, webRoot: dir },
    agent: { serverUrl: "http://127.0.0.1:8788" },
  });
  const server = await startServer(cfg);
  cleanups.push(() => server.stop());
  const http = `http://127.0.0.1:${server.port}`;

  // The owner signs in and attaches to the machine's route.
  const login = await fetch(`${http}/auth/login/password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "correct horse" }),
  });
  const { token } = z.object({ token: z.string() }).parse(await login.json());
  const phoneSocket = new WebSocket(
    `ws://127.0.0.1:${server.port}/client?token=${encodeURIComponent(token)}`,
  );
  cleanups.push(() => phoneSocket.close());
  const online = Promise.withResolvers<void>();
  phoneSocket.addEventListener("message", (ev) => {
    const msg = MachinesMsg.safeParse(JSON.parse(String(ev.data)));
    if (msg.success && msg.data.machineIds.includes("box")) online.resolve();
  });
  const opened = Promise.withResolvers<void>();
  phoneSocket.addEventListener("open", () => opened.resolve(), { once: true });
  await opened.promise;
  phoneSocket.send(JSON.stringify({ type: "attach", machineId: "box" }));

  // The agent section points at the port the server bound.
  const agent = await startAgent(
    Config.parse({ ...cfg, agent: { ...cfg.agent, serverUrl: http } }),
  );
  cleanups.push(() => agent.stop());
  await online.promise;
});

/**
 * A phone on its own `/client` socket to the server at `base`, attached to
 * `box` once the relay lists it online, with a sealed channel keyed `keys`
 * that has said nothing yet: whether the agent acks it or refuses it.
 */
async function phoneOn(
  base: string,
  token: string,
  keys: SessionKeys,
): Promise<{
  channel: SealedChannel;
  ready: Promise<string>;
  refused: Promise<SealedRefusal>;
}> {
  const socket = new WebSocket(
    `${base.replace("http:", "ws:")}/client?token=${encodeURIComponent(token)}`,
  );
  // Closed before the server stops: a client socket still open then has
  // crashed Bun on Windows.
  cleanups.push(async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = Promise.withResolvers<void>();
    socket.addEventListener("close", () => closed.resolve(), { once: true });
    socket.close();
    await closed.promise;
  });
  const online = Promise.withResolvers<void>();
  let deliver: ((bytes: Uint8Array) => void) | undefined;
  socket.addEventListener("message", (ev) => {
    const raw = String(ev.data);
    const machines = MachinesMsg.safeParse(JSON.parse(raw));
    if (!machines.success) deliver?.(enc.encode(raw));
    else if (machines.data.machineIds.includes("box")) online.resolve();
  });
  const opened = Promise.withResolvers<void>();
  socket.addEventListener("open", () => opened.resolve(), { once: true });
  await opened.promise;
  socket.send(JSON.stringify({ type: "attach", machineId: "box" }));
  await online.promise;
  const ready = Promise.withResolvers<string>();
  const refused = Promise.withResolvers<SealedRefusal>();
  const channel = new SealedChannel(
    keys,
    {
      send: (bytes) => socket.send(dec.decode(bytes)),
      onBytes: (cb) => {
        deliver = cb;
      },
    },
    "box",
    { role: "initiator", onRefused: refused.resolve },
  );
  channel.onReady(ready.resolve);
  return { channel, ready: ready.promise, refused: refused.promise };
}

/**
 * A server and an agent for `box` whose pairing store trusts two phones,
 * `older` then `newer`, with `agent.phoneId` set to `phoneId(older, newer)`,
 * and the agent's diagnostic lines split by level. `token` signs a phone in.
 */
async function twoPhoneHost(
  phoneId: (older: string, newer: string) => string,
): Promise<{
  http: string;
  token: string;
  older: SessionKeys;
  newer: SessionKeys;
  warnings: string[];
  infos: string[];
}> {
  const { dir } = await freshState();
  const machines = await MachineStore.load(secretPaths.machines);
  await writeFile(
    secretPaths.agentToken,
    await machines.issue("box", Date.now()),
  );
  const older = await newIdentity();
  const newer = await newIdentity();
  const pairing = new PairingStore(secretPaths.pairing);
  await pairing.load();
  await pairing.trust({ id: older.publicKey, publicKey: older.publicKey });
  await pairing.trust({ id: newer.publicKey, publicKey: newer.publicKey });
  // A second back: `iat` has second granularity.
  await writeCheapPassword(
    secretPaths.password,
    "correct horse",
    Date.now() - 1000,
  );
  const cfg = Config.parse({
    version: 1,
    machineId: "box",
    server: { listen: { host: "127.0.0.1", port: 0 }, webRoot: dir },
    agent: {
      serverUrl: "http://127.0.0.1:8788",
      phoneId: phoneId(older.publicKey, newer.publicKey),
    },
  });
  const server = await startServer(cfg);
  cleanups.push(() => server.stop());
  const http = `http://127.0.0.1:${server.port}`;
  const login = await fetch(`${http}/auth/login/password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "correct horse" }),
  });
  const { token } = z.object({ token: z.string() }).parse(await login.json());

  const warnings: string[] = [];
  const infos: string[] = [];
  const warn = spyOn(console, "error").mockImplementation((line: unknown) => {
    warnings.push(String(line));
  });
  cleanups.push(() => warn.mockRestore());
  const info = spyOn(console, "log").mockImplementation((line: unknown) => {
    infos.push(String(line));
  });
  cleanups.push(() => info.mockRestore());
  const agent = await startAgent(
    Config.parse({ ...cfg, agent: { ...cfg.agent, serverUrl: http } }),
  );
  cleanups.push(() => agent.stop());
  const hostPub = pairing.self().publicKey;
  return {
    http,
    token,
    older: await clientSessionKeys(older, hostPub),
    newer: await clientSessionKeys(newer, hostPub),
    warnings,
    infos,
  };
}

const diverged = (lines: string[]): string[] =>
  lines.filter((line) => line.includes('"uplink_phone_diverged"'));

// #14: a newer pairing the phone did not keep must not take over from the
// phone the config names.
test("an agent whose config names a trusted phone paired before the newest serves the named one, notes so, and the newest is told to pair again", async () => {
  const { http, token, older, newer, warnings, infos } = await twoPhoneHost(
    (named) => named,
  );
  expect(diverged(warnings)).toEqual([]);
  expect(diverged(infos)).toEqual([
    expect.stringContaining('"code":"newer-phone-trusted"'),
  ]);

  // The named phone's hello is acked: the agent holds its keys.
  const named = await phoneOn(http, token, older);
  named.channel.hello();
  await named.ready;
  // The phone paired after it is told, through the relay, to pair again.
  const unserved = await phoneOn(http, token, newer);
  unserved.channel.hello();
  expect(await unserved.refused).toBe("auth-failed");
});

test("an agent whose config names a phone the store does not trust serves the newest paired one and warns so", async () => {
  const { http, token, newer, warnings } = await twoPhoneHost(
    () => "phone-gone",
  );
  expect(diverged(warnings)).toEqual([
    expect.stringContaining('"code":"phone-not-trusted"'),
  ]);

  // The newest phone's hello is acked: the agent holds its keys.
  const current = await phoneOn(http, token, newer);
  current.channel.hello();
  await current.ready;
});
