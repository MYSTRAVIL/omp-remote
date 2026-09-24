import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Config, secretPaths } from "@omp-remote/config";
import { PairingStore, newIdentity } from "@omp-remote/crypto";
import { restrictToOwner } from "@omp-remote/protocol/ipc";
import { startAgent } from "../../../packages/agent/src/main";
import { MachineStore } from "../../aggregator/src/machine-store";
import { startServer } from "../../aggregator/src/main";
import { writeCheapPassword } from "../../aggregator/test/helpers/password";
import { doctor } from "../src/commands/doctor";
import { bridgeInstallPath } from "../src/service/bridge";

const ENV_KEYS = [
  "OMP_REMOTE_STATE_DIR",
  "OMP_REMOTE_IPC_PATH",
  "HOME",
  "USERPROFILE",
] as const;
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

/** A healthy one-box stack in a temp state dir: server + agent + paired phone + bridge file. */
async function healthyStack() {
  const dir = await mkdtemp(join(tmpdir(), "omp-remote-doctor-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  process.env.OMP_REMOTE_STATE_DIR = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.OMP_REMOTE_IPC_PATH =
    process.platform === "win32"
      ? `\\\\.\\pipe\\omp-remote-doctor-${Math.random().toString(36).slice(2)}`
      : join(dir, "agent.sock");
  await writeFile(join(dir, "session-secret"), "s".repeat(43), { mode: 0o600 });
  const machines = await MachineStore.load(secretPaths.machines);
  await writeFile(
    secretPaths.agentToken,
    await machines.issue("box", Date.now()),
    {
      mode: 0o600,
    },
  );
  // Windows ignores the mode: install's owner-only ACL is what doctor checks.
  if (process.platform === "win32")
    for (const secret of [secretPaths.sessionSecret, secretPaths.agentToken])
      expect(await restrictToOwner(secret)).toBeUndefined();
  const pairing = new PairingStore(secretPaths.pairing);
  await pairing.load();
  await pairing.trust({
    id: "phone-1",
    publicKey: (await newIdentity()).publicKey,
  });
  await writeCheapPassword(secretPaths.password, "correct horse", Date.now());
  await writeFile(join(dir, "index.html"), "shell");
  const bridge = bridgeInstallPath();
  await mkdir(dirname(bridge), { recursive: true });
  await writeFile(bridge, "// bridge");

  const base = Config.parse({
    version: 1,
    machineId: "box",
    server: { listen: { host: "127.0.0.1", port: 0 }, webRoot: dir },
    agent: { serverUrl: "http://127.0.0.1:1" },
  });
  const server = await startServer(base);
  cleanups.push(() => server.stop());
  const cfg = Config.parse({
    ...base,
    server: {
      ...base.server,
      listen: { host: "127.0.0.1", port: server.port },
    },
    agent: { serverUrl: `http://127.0.0.1:${server.port}` },
  });
  const agent = await startAgent(cfg);
  cleanups.push(() => agent.stop());
  return { cfg, server, machines };
}

async function runDoctor(
  cfg: Config,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await doctor({
    load: async () => cfg,
    print: (l) => lines.push(l),
  });
  return { code, lines };
}

test("a healthy stack passes every check", async () => {
  const { cfg } = await healthyStack();
  const { code, lines } = await runDoctor(cfg);
  expect(lines.filter((l) => !l.startsWith("ok "))).toEqual([]);
  expect(code).toBe(0);
});

test("a stopped server fails the server check with a fix", async () => {
  const { cfg, server } = await healthyStack();
  await server.stop();
  const { code, lines } = await runDoctor(cfg);
  expect(code).toBe(1);
  expect(lines.find((l) => l.startsWith("FAIL server answers"))).toContain(
    "omp-remote run",
  );
});

test("a secret other accounts can read fails and names the fix", async () => {
  const { cfg } = await healthyStack();
  // Recreated without restricting it, as a rename over the file would: it
  // takes the state dir's inherited ACL on Windows, a 0644 mode on Unix.
  await rm(secretPaths.sessionSecret);
  await writeFile(secretPaths.sessionSecret, "s".repeat(43));
  if (process.platform !== "win32")
    await chmod(secretPaths.sessionSecret, 0o644);
  const { code, lines } = await runDoctor(cfg);
  expect(code).toBe(1);
  expect(lines.find((l) => l.startsWith("FAIL session secret"))).toEndWith(
    process.platform === "win32"
      ? "→ omp-remote install re-applies owner-only access"
      : `→ chmod 600 ${secretPaths.sessionSecret}`,
  );
});

// `join --force` would rewrite a host's config as agent-only; `pair` keeps it.
test("a machine token the server does not accept fails and names omp-remote pair", async () => {
  const { cfg } = await healthyStack();
  // Well-formed, but never issued: what a revoked token looks like to the server.
  await writeFile(secretPaths.agentToken, "A".repeat(43), { mode: 0o600 });
  const { code, lines } = await runDoctor(cfg);
  expect(code).toBe(1);
  expect(
    lines.find((l) => l.startsWith("FAIL machine accepted by server")),
  ).toEndWith("→ omp-remote pair");
});

test("a missing machine token fails both token checks and names omp-remote pair", async () => {
  const { cfg } = await healthyStack();
  await rm(secretPaths.agentToken);
  const { code, lines } = await runDoctor(cfg);
  expect(code).toBe(1);
  const failures = lines.filter((l) => l.startsWith("FAIL machine"));
  expect(failures).toHaveLength(2);
  for (const line of failures) expect(line).toEndWith("→ omp-remote pair");
});

test("a missing config is one FAIL line", async () => {
  const lines: string[] = [];
  const code = await doctor({
    load: async () => {
      throw new Error("no config at x; run `omp-remote init`");
    },
    print: (l) => lines.push(l),
  });
  expect(code).toBe(1);
  expect(lines).toEqual(["FAIL config: no config at x; run `omp-remote init`"]);
});
