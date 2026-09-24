import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliDeps } from "../../src/deps";

const ENV_KEYS = ["OMP_REMOTE_STATE_DIR", "OMP_REMOTE_IPC_PATH"] as const;
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
export const cleanups: Array<() => unknown> = [];

/** Run each test's cleanups, newest first, and restore the env; for `afterEach`. */
export async function cleanUp(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

/** A temp dir removed after the test. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-remote-cli-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A fresh state dir and a private IPC endpoint, both set in the env. */
export async function freshState(): Promise<string> {
  const dir = await tempDir();
  process.env.OMP_REMOTE_STATE_DIR = dir;
  process.env.OMP_REMOTE_IPC_PATH =
    process.platform === "win32"
      ? `\\\\.\\pipe\\omp-remote-cli-${crypto.randomUUID()}`
      : join(dir, "agent.sock");
  return dir;
}

/**
 * Deps for a command under test: output is captured, and a prompt, a stdin
 * read or a pairing sleep the test did not supply fails instead of blocking.
 * Nothing asks to stop unless `stopRequested` is supplied.
 */
export function cliDeps(overrides: Partial<CliDeps> = {}): {
  deps: CliDeps;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const unexpected = (what: string) => () =>
    Promise.reject(new Error(`unexpected ${what}`));
  const deps: CliDeps = {
    print: (text) => out.push(text),
    printError: (text) => err.push(text),
    ask: unexpected("prompt"),
    choose: unexpected("prompt"),
    askSecret: unexpected("prompt"),
    readStdin: unexpected("stdin read"),
    hostname: () => "test-host",
    networkInterfaces: () => ({}),
    defaultRouteAddress: async () => undefined,
    fetch,
    now: Date.now,
    sleep: unexpected("sleep"),
    stopRequested: () => Promise.withResolvers<void>().promise,
    ...overrides,
  };
  return { deps, out, err };
}
