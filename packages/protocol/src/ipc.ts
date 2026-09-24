import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import {
  type Server,
  type Socket,
  createConnection,
  createServer,
} from "node:net";
import { join, posix } from "node:path";
import type { z } from "zod";
import { FrameDecoder, encodeFrame } from "./codec";
import type { Frame } from "./frames";
import {
  IPC_AUTH_VERSION,
  IpcAuthChallenge,
  IpcAuthError,
  type IpcAuthFrame,
  IpcAuthInit,
  IpcAuthProof,
  IpcAuthVerdict,
  type IpcServerAuthFailureCode,
  ipcAuthMac,
  ipcAuthMacMatches,
  ipcAuthNonce,
} from "./ipc-auth";
import { stateDir } from "./ipc-secrets";

export {
  IpcAuthError,
  type IpcAuthFailureCode,
  type IpcServerAuthFailureCode,
} from "./ipc-auth";
export {
  type SecretAclFailure,
  type SecretOptions,
  checkOwnerOnly,
  devClientSecretPath,
  ipcTokenPath,
  loadOrCreateSecret,
  readSecret,
  resolveIpcToken,
  restrictToOwner,
  stateDir,
} from "./ipc-secrets";

type Env = Record<string, string | undefined>;

/**
 * The host-agent's IPC endpoint; the agent and every bridge must resolve the
 * same one. `OMP_REMOTE_IPC_PATH` overrides it (tests, several agents, a
 * self-hoster). Unix never falls back to the shared `/tmp`: the socket lives in
 * a private `omp-remote` directory under `XDG_RUNTIME_DIR`, else in the agent
 * state dir (see {@link prepareIpcEndpoint}).
 */
export function ipcPath(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.OMP_REMOTE_IPC_PATH;
  if (override) return override;
  if (platform === "win32") return "\\\\.\\pipe\\omp-remote-agent";
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime
    ? posix.join(runtime, "omp-remote", "agent.sock")
    : join(stateDir(env), "agent.sock");
}

/**
 * The endpoint the agent listens on, with its default Unix directory created
 * and forced owner-only (0700). An `OMP_REMOTE_IPC_PATH` override's directory
 * is the operator's and is left untouched.
 */
export async function prepareIpcEndpoint(
  env: Env = process.env,
): Promise<string> {
  const path = ipcPath(env);
  if (process.platform === "win32" || env.OMP_REMOTE_IPC_PATH) return path;
  const dir = posix.dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return path;
}

export interface IpcConn {
  /** True once the peer proved the IPC token in the handshake; false for a
   *  bridge that predates it (it authenticates with its `hello` token). */
  readonly authenticated: boolean;
  send(frame: Frame): void;
  onFrame(cb: (f: Frame) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/**
 * Frame I/O over a socket. `leftover` is what the handshake read past its last
 * line. Frames decoded before the first `onFrame` are held, not dropped, so a
 * caller that subscribes after an `await` still sees them.
 */
function wrap(
  socket: Socket,
  authenticated: boolean,
  leftover: string,
): IpcConn {
  const decoder = new FrameDecoder();
  const frameCbs: ((f: Frame) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  let backlog: Frame[] | undefined = [];
  const receive = (chunk: string): void => {
    let frames: Frame[];
    try {
      frames = decoder.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    if (backlog) backlog.push(...frames);
    else for (const f of frames) for (const cb of frameCbs) cb(f);
  };
  socket.on("data", receive);
  socket.on("close", () => {
    for (const cb of closeCbs) cb();
  });
  if (leftover !== "") receive(leftover);
  return {
    authenticated,
    send: (frame) => {
      socket.write(encodeFrame(frame));
    },
    onFrame: (cb) => {
      frameCbs.push(cb);
      if (!backlog) return;
      const held = backlog;
      backlog = undefined;
      for (const f of held) for (const each of frameCbs) each(f);
    },
    onClose: (cb) => {
      closeCbs.push(cb);
    },
    close: () => socket.destroy(),
  };
}

/** Longest handshake line accepted; the first line may be an old bridge's hello. */
const MAX_HANDSHAKE_LINE = 64 * 1024;

type LineResult = { line: string } | { end: "closed" | "overflow" };

/** Reads the handshake's lines, then hands the rest of the stream to `wrap`. */
class LineReader {
  readonly #socket: Socket;
  #buf = "";
  #closed = false;
  #waiter: PromiseWithResolvers<LineResult> | undefined;
  readonly #onData = (chunk: string): void => {
    this.#buf += chunk;
    this.#pump();
  };
  readonly #onClose = (): void => {
    this.#closed = true;
    this.#pump();
  };

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", this.#onData);
    socket.on("close", this.#onClose);
  }

  next(): Promise<LineResult> {
    this.#waiter = Promise.withResolvers<LineResult>();
    const { promise } = this.#waiter;
    this.#pump();
    return promise;
  }

  /** Stop reading; returns the bytes received past the last line. */
  release(): string {
    this.#socket.off("data", this.#onData);
    this.#socket.off("close", this.#onClose);
    return this.#buf;
  }

  #pump(): void {
    const waiter = this.#waiter;
    if (!waiter) return;
    const nl = this.#buf.indexOf("\n");
    let result: LineResult | undefined;
    if (nl >= 0 && nl <= MAX_HANDSHAKE_LINE) {
      result = { line: this.#buf.slice(0, nl) };
      this.#buf = this.#buf.slice(nl + 1);
    } else if (nl > MAX_HANDSHAKE_LINE || this.#buf.length > MAX_HANDSHAKE_LINE)
      result = { end: "overflow" };
    else if (this.#closed) result = { end: "closed" };
    if (!result) return;
    this.#waiter = undefined;
    waiter.resolve(result);
  }
}

function parseLine<T>(line: string, schema: z.ZodType<T>): T | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

function sendAuth(socket: Socket, frame: IpcAuthFrame): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}

/** The agent could not create its endpoint: another process already owns it. */
export class IpcEndpointInUseError extends Error {
  constructor(path: string) {
    super(`IPC endpoint already in use: ${path}`);
  }
}

export interface IpcServerOptions {
  /** The IPC token. Enables the mutual-auth handshake; without it the server
   *  only speaks plain frames, like a host-agent that predates the handshake. */
  token?: string;
  /** A bridge started the handshake but failed it. */
  onAuthFailure?: (code: IpcServerAuthFailureCode) => void;
}

export class IpcServer {
  readonly #opts: IpcServerOptions;
  #server: Server | undefined;
  #cbs: ((conn: IpcConn) => void)[] = [];

  constructor(opts: IpcServerOptions = {}) {
    this.#opts = opts;
  }

  onConnection(cb: (conn: IpcConn) => void): void {
    this.#cbs.push(cb);
  }

  /** Listen on `path`; rejects with {@link IpcEndpointInUseError} when another
   *  live process already owns it (a stale Unix socket file is replaced). */
  async listen(path: string): Promise<void> {
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("error", () => socket.destroy());
      this.#accept(socket).catch(() => socket.destroy());
    });
    try {
      await bind(server, path);
    } catch (err) {
      if (!isAddrInUse(err)) throw err;
      if (!(await isStaleUnixSocket(path)))
        throw new IpcEndpointInUseError(path);
      await unlink(path);
      await bind(server, path);
    }
    this.#server = server;
    // Owner-only on Unix. A Windows named pipe keeps its default DACL: neither
    // node:net (readableAll/writableAll only widen access) nor Bun.listen offers
    // an ACL — which is why bridges authenticate the agent in the handshake.
    if (process.platform !== "win32") await chmod(path, 0o600);
  }

  close(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (this.#server) this.#server.close(() => resolve());
    else resolve();
    return promise;
  }

  #emit(conn: IpcConn): void {
    for (const cb of this.#cbs) cb(conn);
  }

  async #accept(socket: Socket): Promise<void> {
    const token = this.#opts.token;
    if (token === undefined) {
      this.#emit(wrap(socket, false, ""));
      return;
    }
    const reader = new LineReader(socket);
    const first = await reader.next();
    if (!("line" in first)) {
      reader.release();
      socket.destroy();
      return;
    }
    const init = parseLine(first.line, IpcAuthInit);
    if (!init) {
      // A bridge that predates the handshake: its first line is a plain
      // `hello`, which frame parsing and the token check judge from here.
      this.#emit(wrap(socket, false, `${first.line}\n${reader.release()}`));
      return;
    }
    const serverNonce = ipcAuthNonce();
    sendAuth(socket, { t: "ipcAuthChallenge", serverNonce });
    const answer = await reader.next();
    const leftover = reader.release();
    if (!("line" in answer)) {
      socket.destroy();
      if (answer.end === "overflow")
        this.#opts.onAuthFailure?.("protocol-error");
      return;
    }
    const proof = parseLine(answer.line, IpcAuthProof);
    if (!proof) {
      socket.destroy();
      this.#opts.onAuthFailure?.("protocol-error");
      return;
    }
    const { clientNonce } = init;
    if (
      !ipcAuthMacMatches(proof.mac, token, "client", serverNonce, clientNonce)
    ) {
      sendAuth(socket, { t: "ipcAuthReject" });
      socket.end();
      this.#opts.onAuthFailure?.("token-mismatch");
      return;
    }
    sendAuth(socket, {
      t: "ipcAuthAccept",
      mac: ipcAuthMac(token, "server", serverNonce, clientNonce),
    });
    // A well-behaved bridge sends nothing before it has checked our proof.
    this.#emit(wrap(socket, true, leftover));
  }
}

function bind(server: Server, path: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onError = (err: Error): void => reject(err);
  server.once("error", onError);
  server.listen(path, () => {
    server.off("error", onError);
    resolve();
  });
  return promise;
}

function isAddrInUse(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

/**
 * True when `path` is a Unix socket file nothing listens on (a crashed agent's
 * leftover). A Windows pipe disappears with its owner, so it is never stale.
 */
async function isStaleUnixSocket(path: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  try {
    if (!(await lstat(path)).isSocket()) return false;
  } catch {
    return false;
  }
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const probe = createConnection(path);
  probe.once("connect", () => {
    probe.destroy();
    resolve(false);
  });
  probe.once("error", (err: NodeJS.ErrnoException) =>
    resolve(err.code === "ECONNREFUSED"),
  );
  return promise;
}

function openSocket(path: string): Promise<Socket> {
  const { promise, resolve, reject } = Promise.withResolvers<Socket>();
  const socket = createConnection(path);
  socket.once("connect", () => {
    socket.off("error", reject);
    socket.on("error", () => socket.destroy());
    resolve(socket);
  });
  socket.once("error", reject);
  socket.setEncoding("utf8");
  return promise;
}

async function expectAuth<T>(
  reader: LineReader,
  schema: z.ZodType<T>,
): Promise<T> {
  const next = await reader.next();
  if (!("line" in next))
    throw new IpcAuthError(
      next.end === "closed" ? "agent-closed" : "protocol-error",
    );
  const parsed = parseLine(next.line, schema);
  if (parsed === undefined) throw new IpcAuthError("protocol-error");
  return parsed;
}

/**
 * Connect to the host-agent and authenticate both ways without the token ever
 * crossing the wire. Rejects with {@link IpcAuthError} — having sent only
 * nonces and our own proof — when the endpoint cannot prove the token.
 */
export async function connectIpc(
  path: string,
  token: string,
): Promise<IpcConn> {
  const socket = await openSocket(path);
  const reader = new LineReader(socket);
  try {
    const clientNonce = ipcAuthNonce();
    sendAuth(socket, { t: "ipcAuthInit", v: IPC_AUTH_VERSION, clientNonce });
    const { serverNonce } = await expectAuth(reader, IpcAuthChallenge);
    sendAuth(socket, {
      t: "ipcAuthProof",
      mac: ipcAuthMac(token, "client", serverNonce, clientNonce),
    });
    const verdict = await expectAuth(reader, IpcAuthVerdict);
    if (verdict.t === "ipcAuthReject") throw new IpcAuthError("token-rejected");
    if (
      !ipcAuthMacMatches(verdict.mac, token, "server", serverNonce, clientNonce)
    )
      throw new IpcAuthError("server-unproven");
  } catch (err) {
    reader.release();
    socket.destroy();
    throw err;
  }
  return wrap(socket, true, reader.release());
}

/**
 * Connect WITHOUT the handshake, as bridges loaded before it did (their `hello`
 * carries the token in the clear). Only for exercising the agent's
 * compatibility path; a real bridge must use {@link connectIpc}.
 */
export async function connectIpcLegacy(path: string): Promise<IpcConn> {
  return wrap(await openSocket(path), false, "");
}
