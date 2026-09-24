import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Frame,
  type SessionMeta,
  devClientProtocols,
} from "@omp-remote/protocol";
import {
  IpcAuthError,
  type IpcConn,
  connectIpc,
  connectIpcLegacy,
  loadOrCreateSecret,
} from "@omp-remote/protocol/ipc";
import type { AgentDiagnostic } from "../src/diagnostics";
import { type AgentConfig, AgentService } from "../src/service";
import {
  TEST_DEV_SECRET,
  devClientSocket,
  testDevClient,
} from "./helpers/dev-client";

type HelloFrame = Extract<Frame, { t: "hello" }>;

let svc: AgentService | undefined;
const conns: IpcConn[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const conn of conns.splice(0)) conn.close();
  await svc?.stop();
  svc = undefined;
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function ipcAddr(): string {
  const id = Math.random().toString(36).slice(2);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-auth-${id}`
    : join(tmpdir(), `omp-remote-auth-${id}.sock`);
}

function session(id: string): SessionMeta {
  return {
    id,
    cwd: "/x/p",
    project: "p",
    model: "m",
    title: "T",
    pid: 3,
    startedAt: 0,
  };
}

/** Start a service whose diagnostics land in the returned array. */
async function startService(
  config: Omit<AgentConfig, "ipcPath" | "diagnostic">,
): Promise<{ service: AgentService; path: string; events: AgentDiagnostic[] }> {
  const path = ipcAddr();
  const events: AgentDiagnostic[] = [];
  const service = new AgentService({
    ...config,
    ipcPath: path,
    diagnostic: (event) => events.push(event),
  });
  svc = service;
  await service.start();
  return { service, path, events };
}

type Outcome = "accepted" | "rejected";

/** Resolve "accepted" once `sessionId` is listed, "rejected" if `conn` closes. */
async function helloOutcome(
  service: AgentService,
  conn: IpcConn,
  hello: HelloFrame,
): Promise<Outcome> {
  const outcome = Promise.withResolvers<Outcome>();
  const sessionId = hello.session.id;
  const unsubscribe = service.subscribe((msg) => {
    if (msg.t === "sessions" && msg.sessions.some((s) => s.id === sessionId))
      outcome.resolve("accepted");
  });
  conns.push(conn);
  conn.onClose(() => outcome.resolve("rejected"));
  conn.send(hello);
  const result = await outcome.promise;
  unsubscribe();
  return result;
}

/** A bridge loaded before the IPC handshake: `token` travels in a plain feed
 *  hello, and the bridge stays connected. */
async function hello(
  service: AgentService,
  path: string,
  token: string | undefined,
  sessionId: string,
): Promise<Outcome> {
  const frame: HelloFrame =
    token === undefined
      ? { t: "hello", session: session(sessionId) }
      : { t: "hello", token, session: session(sessionId) };
  return helloOutcome(service, await connectIpcLegacy(path), frame);
}

/** A current bridge: proves `token` in the handshake, then a token-less hello. */
async function bridgeHello(
  service: AgentService,
  path: string,
  token: string,
  sessionId: string,
): Promise<Outcome> {
  let conn: IpcConn;
  try {
    conn = await connectIpc(path, token);
  } catch (err) {
    if (err instanceof IpcAuthError) return "rejected";
    throw err;
  }
  return helloOutcome(service, conn, {
    t: "hello",
    session: session(sessionId),
  });
}

/** Follow a dev-client connection attempt until it closes; an attempt that
 *  opens is closed at once so a wrongly admitted client fails fast. */
function attempt(
  ws: WebSocket,
): Promise<{ opened: boolean; messages: string[] }> {
  const closed = Promise.withResolvers<{
    opened: boolean;
    messages: string[];
  }>();
  let opened = false;
  const messages: string[] = [];
  ws.addEventListener("open", () => {
    opened = true;
    ws.close();
  });
  ws.addEventListener("message", (e) => messages.push(String(e.data)));
  ws.addEventListener("close", () => closed.resolve({ opened, messages }));
  return closed.promise;
}

/** Send a genuine WebSocket upgrade over raw TCP (so any header, including
 *  `Origin`, can be set) and resolve the response head. */
function upgradeHead(
  port: number,
  headers: Record<string, string>,
): Promise<string> {
  const head = Promise.withResolvers<string>();
  const socket = createConnection({ host: "127.0.0.1", port });
  let received = "";
  socket.setEncoding("latin1");
  socket.on("data", (chunk: string) => {
    received += chunk;
    const end = received.indexOf("\r\n\r\n");
    if (end < 0) return;
    head.resolve(received.slice(0, end));
    socket.destroy();
  });
  socket.on("error", head.reject);
  socket.on("close", () => head.reject(new Error("closed before a response")));
  socket.on("connect", () => {
    const lines = [
      "GET / HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ];
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
  return head.promise;
}

test("the dev client refuses a missing or wrong secret before any replay", async () => {
  const { service, path, events } = await startService({
    token: "tok",
    devClient: testDevClient,
  });
  // A listed session guarantees an admitted client would get replay bytes.
  expect(await hello(service, path, "tok", "s1")).toBe("accepted");
  const port = service.boundPort;

  const missing = await attempt(new WebSocket(`ws://127.0.0.1:${port}`));
  expect(missing).toEqual({ opened: false, messages: [] });
  // Same length as the real secret, so the constant-time compare runs.
  const guess = `${TEST_DEV_SECRET.slice(0, -1)}X`;
  const wrong = await attempt(devClientSocket(port, guess));
  expect(wrong).toEqual({ opened: false, messages: [] });
  expect(events.some((e) => e.event === "client_connected")).toBe(false);
});

test("the dev client refuses a foreign Origin even with the right secret", async () => {
  const { service, events } = await startService({
    token: "tok",
    devClient: { ...testDevClient, allowedOrigins: ["http://127.0.0.1:4318"] },
  });

  const head = await upgradeHead(service.boundPort, {
    Origin: "http://attacker.example",
    "Sec-WebSocket-Protocol": devClientProtocols(TEST_DEV_SECRET).join(", "),
  });
  expect(head).toStartWith("HTTP/1.1 403");
  expect(events.some((e) => e.event === "client_connected")).toBe(false);
});

test("the dev client admits the secret with an allowed or absent Origin", async () => {
  const origin = "http://127.0.0.1:4318";
  const { service, path } = await startService({
    token: "tok",
    devClient: { ...testDevClient, allowedOrigins: [origin] },
  });
  expect(await hello(service, path, "tok", "s1")).toBe("accepted");

  // A browser page on an allowed origin. The agent selects the plain protocol
  // and never echoes the secret-bearing one, even when it is offered first.
  const head = await upgradeHead(service.boundPort, {
    Origin: origin,
    "Sec-WebSocket-Protocol": devClientProtocols(TEST_DEV_SECRET)
      .reverse()
      .join(", "),
  });
  expect(head).toStartWith("HTTP/1.1 101");
  expect(head).toMatch(/^sec-websocket-protocol: omp-remote-dev$/im);
  expect(head).not.toContain(TEST_DEV_SECRET);

  // A local tool sends no Origin; it gets the replayed session list.
  const ws = devClientSocket(service.boundPort);
  const replayed = Promise.withResolvers<string>();
  ws.addEventListener("message", (e) => replayed.resolve(String(e.data)), {
    once: true,
  });
  expect(JSON.parse(await replayed.promise)).toMatchObject({
    t: "sessions",
    sessions: [{ id: "s1" }],
  });
  expect(ws.protocol).toBe("omp-remote-dev");
  ws.close();
});

test("without a dev client config the agent listens on no TCP port", async () => {
  // Learn a port the dev client binds, then free it.
  const probe = new AgentService({
    token: "tok",
    ipcPath: ipcAddr(),
    devClient: testDevClient,
  });
  await probe.start();
  const port = probe.boundPort;
  await probe.stop();

  const { service, path } = await startService({ token: "tok" });
  expect(() => service.boundPort).toThrow();
  expect(await attempt(devClientSocket(port))).toEqual({
    opened: false,
    messages: [],
  });
  // IPC still serves bridges.
  expect(await hello(service, path, "tok", "s1")).toBe("accepted");
});

test("IPC accepts the per-install token and rejects the old shared constant and forged ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-remote-auth-"));
  dirs.push(dir);
  const token = await loadOrCreateSecret(join(dir, "ipc-token"));
  const { service, path, events } = await startService({ token });

  expect(await hello(service, path, token, "current")).toBe("accepted");
  // Bridges from before per-install tokens sent this constant.
  expect(await hello(service, path, "dev-token", "legacy")).toBe("rejected");
  expect(await hello(service, path, "forged-token", "forged")).toBe("rejected");
  expect(events.filter((e) => e.event === "ipc_session_rejected")).toHaveLength(
    2,
  );
});

test("a handshake bridge is admitted without its token on the wire; a wrong token is refused", async () => {
  const { service, path, events } = await startService({ token: "tok" });
  expect(await bridgeHello(service, path, "tok", "current")).toBe("accepted");
  expect(await bridgeHello(service, path, "wrong", "forged")).toBe("rejected");
  expect(events).toContainEqual({
    event: "ipc_session_rejected",
    code: "authentication-failed",
  });
});

test("a plain hello without a token is not mistaken for a handshake bridge", async () => {
  const { service, path } = await startService({ token: "tok" });
  expect(await hello(service, path, undefined, "tokenless")).toBe("rejected");
});
