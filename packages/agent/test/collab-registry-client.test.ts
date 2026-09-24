import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scheduler } from "@omp-remote/protocol";
import { CollabRegistryClient } from "../src/collab/registry-client";

const INSTANCE_A = "abc3f729af7929eb";

/** A dead pid: `process.kill(pid, 0)` reports ESRCH, so the entry is reaped. */
const DEAD_PID = 2 ** 30;

function endpointFor(entryId: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-collab-${entryId}`
    : join(tmpdir(), `omp-collab-${entryId}.sock`);
}

interface FakeHost {
  endpoint: string;
  token: string;
  readonly state: { connections: number };
  waitForConnections: (n: number) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A minimal stand-in for an omp Collab host's registry endpoint: one request
 * per connection, token-checked, then `respond` decides the reply. A `respond`
 * returning `null` accepts the connection but never answers (a wedged host).
 */
async function startFakeHost(opts: {
  respond: (req: Record<string, unknown>) => object | null;
  checkToken?: boolean;
}): Promise<FakeHost> {
  const entryId = randomBytes(8).toString("hex");
  const endpoint = endpointFor(entryId);
  const token = randomBytes(16).toString("hex");
  const state = { connections: 0 };
  const sockets = new Set<Socket>();
  const waiters: { n: number; resolve: () => void }[] = [];
  const server: Server = createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter && state.connections >= waiter.n) {
        waiter.resolve();
        waiters.splice(i, 1);
      }
    }
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      let req: Record<string, unknown>;
      try {
        req = JSON.parse(buffer.slice(0, nl));
      } catch {
        socket.destroy();
        return;
      }
      if (opts.checkToken !== false && req.token !== token) {
        socket.end(
          `${JSON.stringify({ ok: false, v: 1, error: "authentication_failed" })}\n`,
        );
        return;
      }
      const res = opts.respond(req);
      if (res === null) return;
      socket.end(`${JSON.stringify(res)}\n`);
    });
    socket.on("error", () => socket.destroy());
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", (err) => listening.reject(err));
  server.listen(endpoint, () => listening.resolve());
  await listening.promise;
  return {
    endpoint,
    token,
    state,
    waitForConnections(n) {
      if (state.connections >= n) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ n, resolve });
      return promise;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      const done = Promise.withResolvers<void>();
      server.close(() => done.resolve());
      await done.promise;
    },
  };
}

function snapshotFor(
  instanceId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    instanceId,
    generation: 1,
    pid: process.pid,
    sessionId: `sess-${instanceId}`,
    sessionName: "Fix the bug",
    cwd: "/tmp/proj",
    model: { provider: "anthropic", id: "claude-opus-4-8" },
    startedAt: 100,
    participants: 1,
    relayConnected: true,
    inputRequired: false,
    access: "control",
    ...over,
  };
}

async function writeMeta(
  dir: string,
  entry: {
    instanceId: string;
    endpoint: string;
    token: string;
    pid?: number;
    version?: number;
  },
): Promise<void> {
  const meta = {
    version: entry.version ?? 1,
    instanceId: entry.instanceId,
    pid: entry.pid ?? process.pid,
    endpoint: entry.endpoint,
    createdAt: Date.now(),
    token: entry.token,
  };
  await writeFile(
    join(dir, `${randomBytes(8).toString("hex")}.json`),
    JSON.stringify(meta),
    "utf8",
  );
}

/** A Scheduler whose timers fire only when the test calls `fireTimers()`. */
function manualScheduler(): {
  scheduler: Scheduler;
  fireTimers: () => void;
} {
  const timers = new Set<() => void>();
  return {
    scheduler: {
      setTimer(fn) {
        timers.add(fn);
        return () => {
          timers.delete(fn);
        };
      },
      setInterval() {
        return () => {};
      },
    },
    fireTimers() {
      const fns = [...timers];
      timers.clear();
      for (const fn of fns) fn();
    },
  };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "collab-reg-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("lists a live entry via its snapshot", async () => {
  await withDir(async (dir) => {
    const host = await startFakeHost({
      respond: (req) =>
        req.op === "snapshot"
          ? { ok: true, v: 1, snapshot: snapshotFor(INSTANCE_A) }
          : { ok: false, v: 1, error: "invalid_operation" },
    });
    await writeMeta(dir, {
      instanceId: INSTANCE_A,
      endpoint: host.endpoint,
      token: host.token,
    });
    const client = new CollabRegistryClient({ dir });
    try {
      expect(await client.listHosts()).toEqual([
        {
          instanceId: INSTANCE_A,
          generation: 1,
          sessionId: `sess-${INSTANCE_A}`,
          cwd: "/tmp/proj",
          model: "claude-opus-4-8",
          sessionName: "Fix the bug",
          pid: process.pid,
          startedAt: 100,
        },
      ]);
    } finally {
      await host.close();
    }
  });
});

test("maps a null model and session name", async () => {
  await withDir(async (dir) => {
    const host = await startFakeHost({
      respond: () => ({
        ok: true,
        v: 1,
        snapshot: snapshotFor(INSTANCE_A, { model: null, sessionName: null }),
      }),
    });
    await writeMeta(dir, {
      instanceId: INSTANCE_A,
      endpoint: host.endpoint,
      token: host.token,
    });
    const client = new CollabRegistryClient({ dir });
    try {
      const hosts = await client.listHosts();
      expect(hosts[0]?.model).toBe("");
      expect(hosts[0]?.sessionName).toBeNull();
    } finally {
      await host.close();
    }
  });
});

test("ignores .json.tmp, malformed metadata, and dead pids", async () => {
  await withDir(async (dir) => {
    const host = await startFakeHost({
      respond: () => ({ ok: true, v: 1, snapshot: snapshotFor(INSTANCE_A) }),
    });
    await writeMeta(dir, {
      instanceId: INSTANCE_A,
      endpoint: host.endpoint,
      token: host.token,
    });
    // An in-progress write: must be skipped by the *.json filter (never probed).
    await writeFile(
      join(dir, `${randomBytes(8).toString("hex")}.json.tmp`),
      JSON.stringify({
        version: 1,
        instanceId: "1111111111111111",
        pid: process.pid,
        endpoint: host.endpoint,
        createdAt: Date.now(),
        token: host.token,
      }),
      "utf8",
    );
    // Malformed JSON: skipped, never probed.
    await writeFile(
      join(dir, `${randomBytes(8).toString("hex")}.json`),
      "{ not valid json",
      "utf8",
    );
    // Dead pid: reaped before any probe.
    await writeMeta(dir, {
      instanceId: "deadbeefdeadbeef",
      endpoint: host.endpoint,
      token: host.token,
      pid: DEAD_PID,
    });
    const client = new CollabRegistryClient({ dir });
    try {
      const hosts = await client.listHosts();
      expect(hosts.map((h) => h.instanceId)).toEqual([INSTANCE_A]);
      // Only the one live, well-formed entry was ever dialed.
      expect(host.state.connections).toBe(1);
    } finally {
      await host.close();
    }
  });
});

test("skips an entry the host rejects (wrong token / ok:false)", async () => {
  await withDir(async (dir) => {
    const host = await startFakeHost({
      respond: () => ({ ok: true, v: 1, snapshot: snapshotFor(INSTANCE_A) }),
    });
    await writeMeta(dir, {
      instanceId: INSTANCE_A,
      endpoint: host.endpoint,
      token: "0000wrong0000token",
    });
    const client = new CollabRegistryClient({ dir });
    try {
      expect(await client.listHosts()).toEqual([]);
      // The lister did connect, but the host answered ok:false and was dropped.
      expect(host.state.connections).toBe(1);
    } finally {
      await host.close();
    }
  });
});

test("cools down a wedged endpoint and re-probes only after the cooldown", async () => {
  await withDir(async (dir) => {
    // Accepts connections but never answers: the deadline must fire.
    const wedged = await startFakeHost({ respond: () => null });
    await writeMeta(dir, {
      instanceId: INSTANCE_A,
      endpoint: wedged.endpoint,
      token: wedged.token,
    });
    const { scheduler, fireTimers } = manualScheduler();
    let clock = 1_000_000;
    const client = new CollabRegistryClient({
      dir,
      cooldownMs: 60_000,
      now: () => clock,
      scheduler,
    });
    try {
      // First list: probe connects, deadline fires -> omitted + cooled down.
      const first = client.listHosts();
      await wedged.waitForConnections(1);
      fireTimers();
      expect(await first).toEqual([]);
      expect(wedged.state.connections).toBe(1);

      // Within the cooldown: skipped without a probe (no new connection).
      clock += 30_000;
      expect(await client.listHosts()).toEqual([]);
      expect(wedged.state.connections).toBe(1);

      // Past the cooldown: probed again.
      clock += 31_000;
      const third = client.listHosts();
      await wedged.waitForConnections(2);
      fireTimers();
      expect(await third).toEqual([]);
      expect(wedged.state.connections).toBe(2);
    } finally {
      await wedged.close();
    }
  });
});

test("linkFor returns the control url and sends the listed generation", async () => {
  await withDir(async (dir) => {
    let linkGeneration: unknown;
    let linkAccess: unknown;
    const host = await startFakeHost({
      respond: (req) => {
        if (req.op === "snapshot")
          return {
            ok: true,
            v: 1,
            snapshot: snapshotFor(INSTANCE_A, { generation: 7 }),
          };
        if (req.op === "link") {
          linkGeneration = req.generation;
          linkAccess = req.access;
          return { ok: true, v: 1, url: "https://relay.example/#room.key" };
        }
        return { ok: false, v: 1, error: "invalid_operation" };
      },
    });
    await writeMeta(dir, {
      instanceId: INSTANCE_A,
      endpoint: host.endpoint,
      token: host.token,
    });
    const client = new CollabRegistryClient({ dir });
    try {
      const hosts = await client.listHosts();
      expect(hosts[0]?.generation).toBe(7);
      expect(await client.linkFor(INSTANCE_A)).toBe(
        "https://relay.example/#room.key",
      );
      expect(linkGeneration).toBe(7);
      expect(linkAccess).toBe("control");
    } finally {
      await host.close();
    }
  });
});

test("linkFor throws when the host reports an error", async () => {
  await withDir(async (dir) => {
    const host = await startFakeHost({
      respond: (req) =>
        req.op === "snapshot"
          ? { ok: true, v: 1, snapshot: snapshotFor(INSTANCE_A) }
          : { ok: false, v: 1, error: "stale_generation" },
    });
    await writeMeta(dir, {
      instanceId: INSTANCE_A,
      endpoint: host.endpoint,
      token: host.token,
    });
    const client = new CollabRegistryClient({ dir });
    try {
      await client.listHosts();
      await expect(client.linkFor(INSTANCE_A)).rejects.toThrow();
    } finally {
      await host.close();
    }
  });
});

test("linkFor throws for an instance that was not listed", async () => {
  await withDir(async (dir) => {
    const client = new CollabRegistryClient({ dir });
    await expect(client.linkFor("never-listed-id")).rejects.toThrow();
  });
});

test("an absent registry directory lists nothing", async () => {
  const client = new CollabRegistryClient({
    dir: join(tmpdir(), `collab-reg-missing-${randomBytes(6).toString("hex")}`),
  });
  expect(await client.listHosts()).toEqual([]);
});
