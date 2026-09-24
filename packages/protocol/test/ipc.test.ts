import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { Frame } from "../src/index";
import {
  IpcAuthError,
  type IpcConn,
  IpcEndpointInUseError,
  IpcServer,
  type IpcServerAuthFailureCode,
  connectIpc,
  connectIpcLegacy,
  ipcPath,
  prepareIpcEndpoint,
} from "../src/ipc";
import { ipcAuthNonce } from "../src/ipc-auth";

const TOKEN = "per-install-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const servers: Array<IpcServer | Server> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    if (s instanceof IpcServer) await s.close();
    else {
      const closed = Promise.withResolvers<void>();
      s.close(() => closed.resolve());
      await closed.promise;
    }
  }
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function addr() {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-test-${Math.random().toString(36).slice(2)}`
    : join(
        tmpdir(),
        `omp-remote-test-${Math.random().toString(36).slice(2)}.sock`,
      );
}

const hello: Frame = {
  t: "hello",
  session: {
    id: "s",
    cwd: "/c",
    project: "c",
    model: "m",
    title: "x",
    pid: 2,
    startedAt: 1,
  },
};

async function listen(
  path: string,
  opts: ConstructorParameters<typeof IpcServer>[0] = { token: TOKEN },
): Promise<IpcServer> {
  const server = new IpcServer(opts);
  servers.push(server);
  await server.listen(path);
  return server;
}

function nextConn(server: IpcServer): Promise<IpcConn> {
  const { promise, resolve } = Promise.withResolvers<IpcConn>();
  server.onConnection(resolve);
  return promise;
}

/** A process squatting the endpoint: records every byte a client sends. */
async function squat(
  path: string,
  onLine: (line: string, socket: Socket) => void,
): Promise<{ received: () => string }> {
  let received = "";
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    let buf = "";
    socket.on("data", (chunk: string) => {
      received += chunk;
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onLine(line, socket);
      }
    });
  });
  servers.push(server);
  const ready = Promise.withResolvers<void>();
  server.listen(path, () => ready.resolve());
  await ready.promise;
  return { received: () => received };
}

async function authError(p: Promise<IpcConn>): Promise<string> {
  try {
    (await p).close();
  } catch (err) {
    if (err instanceof IpcAuthError) return err.code;
    throw err;
  }
  return "connected";
}

test("mutual auth: both sides authenticated, frames flow both ways", async () => {
  const path = addr();
  const server = await listen(path);
  const arrived = nextConn(server);
  const client = await connectIpc(path, TOKEN);
  expect(client.authenticated).toBe(true);
  const conn = await arrived;
  expect(conn.authenticated).toBe(true);

  const got = Promise.withResolvers<Frame>();
  conn.onFrame(got.resolve);
  client.send(hello);
  expect(await got.promise).toEqual(hello);

  const back = Promise.withResolvers<Frame>();
  client.onFrame(back.resolve);
  conn.send({ t: "interrupt", sessionId: "s" });
  expect(await back.promise).toEqual({ t: "interrupt", sessionId: "s" });
  client.close();
});

test("a frame sent before the peer subscribes is held, not dropped", async () => {
  const path = addr();
  const server = await listen(path);
  server.onConnection((conn) => conn.send({ t: "interrupt", sessionId: "s" }));
  const client = await connectIpc(path, TOKEN);
  const got = Promise.withResolvers<Frame>();
  client.onFrame(got.resolve);
  expect(await got.promise).toEqual({ t: "interrupt", sessionId: "s" });
  client.close();
});

test("a wrong client token is rejected and never becomes a connection", async () => {
  const path = addr();
  const failures: IpcServerAuthFailureCode[] = [];
  const failed = Promise.withResolvers<void>();
  const server = await listen(path, {
    token: TOKEN,
    onAuthFailure: (code) => {
      failures.push(code);
      failed.resolve();
    },
  });
  let connections = 0;
  server.onConnection(() => {
    connections += 1;
  });
  expect(await authError(connectIpc(path, "wrong-token"))).toBe(
    "token-rejected",
  );
  await failed.promise;
  expect(failures).toEqual(["token-mismatch"]);
  expect(connections).toBe(0);
});

test("a squatter that cannot prove the token gets no token bytes and is refused", async () => {
  const path = addr();
  const squatter = await squat(path, (line, socket) => {
    const frame = JSON.parse(line) as { t: string };
    if (frame.t === "ipcAuthInit")
      socket.write(
        `${JSON.stringify({ t: "ipcAuthChallenge", serverNonce: ipcAuthNonce() })}\n`,
      );
    // Accept with a proof it had to guess.
    if (frame.t === "ipcAuthProof")
      socket.write(
        `${JSON.stringify({ t: "ipcAuthAccept", mac: ipcAuthNonce() })}\n`,
      );
  });
  expect(await authError(connectIpc(path, TOKEN))).toBe("server-unproven");
  const received = squatter.received();
  expect(received).not.toContain(TOKEN);
  expect(received).not.toContain('"hello"');
  // Only the two handshake lines were sent: nonce, then our own proof.
  expect(
    received
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).t),
  ).toEqual(["ipcAuthInit", "ipcAuthProof"]);
});

test("a squatter that stays silent or hangs up sees only the client nonce", async () => {
  const path = addr();
  const squatter = await squat(path, (_line, socket) => socket.end());
  expect(await authError(connectIpc(path, TOKEN))).toBe("agent-closed");
  expect(squatter.received()).not.toContain(TOKEN);
});

test("an endpoint answering garbage is a protocol error", async () => {
  const path = addr();
  await squat(path, (_line, socket) => socket.write("not json\n"));
  expect(await authError(connectIpc(path, TOKEN))).toBe("protocol-error");
});

test("a host-agent that predates the handshake fails the new bridge closed", async () => {
  const path = addr();
  await listen(path, {});
  expect(await authError(connectIpc(path, TOKEN))).toBe("agent-closed");
});

test("a bridge that predates the handshake still reaches the server with its hello", async () => {
  const path = addr();
  const server = await listen(path);
  const arrived = nextConn(server);
  const client = await connectIpcLegacy(path);
  const legacyHello: Frame = { ...hello, token: TOKEN, role: "prompt-control" };
  // Sent back to back: the frame after the hello must survive the peek.
  client.send(legacyHello);
  client.send({ t: "bye", sessionId: "s" });
  const conn = await arrived;
  expect(conn.authenticated).toBe(false);
  const frames: Frame[] = [];
  const both = Promise.withResolvers<void>();
  conn.onFrame((f) => {
    frames.push(f);
    if (frames.length === 2) both.resolve();
  });
  await both.promise;
  expect(frames).toEqual([legacyHello, { t: "bye", sessionId: "s" }]);
  client.close();
});

test("listening on an endpoint another process owns fails with IpcEndpointInUseError", async () => {
  const path = addr();
  await listen(path);
  const second = new IpcServer({ token: TOKEN });
  await expect(second.listen(path)).rejects.toBeInstanceOf(
    IpcEndpointInUseError,
  );
});

test("ipcPath: override, Windows pipe, XDG runtime dir, else the state dir", () => {
  expect(ipcPath({ OMP_REMOTE_IPC_PATH: "/x/y.sock" }, "linux")).toBe(
    "/x/y.sock",
  );
  expect(ipcPath({}, "win32")).toBe("\\\\.\\pipe\\omp-remote-agent");
  expect(ipcPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toBe(
    "/run/user/1000/omp-remote/agent.sock",
  );
  const state = join("home", "me", ".omp-remote");
  expect(ipcPath({ OMP_REMOTE_STATE_DIR: state }, "linux")).toBe(
    join(state, "agent.sock"),
  );
  // Never the shared temp dir.
  expect(ipcPath({}, "linux").startsWith(tmpdir())).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "the default Unix endpoint lives in an owner-only dir, socket 0600",
  async () => {
    for (const withXdg of [true, false]) {
      const root = await mkdtemp(join(tmpdir(), "omp-ipc-"));
      dirs.push(root);
      const env = withXdg
        ? { XDG_RUNTIME_DIR: root }
        : { OMP_REMOTE_STATE_DIR: join(root, "state") };
      const path = await prepareIpcEndpoint(env);
      expect(path).toBe(
        withXdg
          ? posix.join(root, "omp-remote", "agent.sock")
          : join(root, "state", "agent.sock"),
      );
      await listen(path);
      expect((await stat(posix.dirname(path))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  },
);
