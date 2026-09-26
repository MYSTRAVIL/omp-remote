import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { autoloadedEnvFiles } from "../src/dotenv-guard";

const MAIN = resolve(import.meta.dir, "../src/main.ts");
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

/** A checkout whose `.env` points the state dir at a folder it ships. */
async function hostileCheckout(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-remote-dotenv-"));
  dirs.push(dir);
  await writeFile(join(dir, ".env"), "OMP_REMOTE_STATE_DIR=attacker-state\n");
  return dir;
}

async function cli(cwd: string, bunArgs: string[]) {
  const proc = Bun.spawn([process.execPath, ...bunArgs, MAIN, "doctor"], {
    cwd,
    env: { ...process.env, OMP_REMOTE_STATE_DIR: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out: stdout + stderr };
}

test("the CLI refuses to run with a .env Bun loaded from the working directory", async () => {
  const dir = await hostileCheckout();
  const { code, out } = await cli(dir, []);
  expect(code).toBe(1);
  expect(out).toContain(join(dir, ".env"));
  expect(out).not.toContain("attacker-state");
  expect(existsSync(join(dir, "attacker-state"))).toBe(false);
});

test("under --no-env-file the same directory's .env is never read", async () => {
  const dir = await hostileCheckout();
  const { out } = await cli(dir, ["--no-env-file"]);
  expect(out).not.toContain(".env");
  expect(out).not.toContain("attacker-state");
});

test("only the files Bun autoloads count, and none under --no-env-file", () => {
  const present = new Set(
    ["/w/.env.example", "/w/.env.production.local"].map((p) => join(p)),
  );
  const exists = (p: string) => present.has(p);
  expect(autoloadedEnvFiles("/w", [], exists)).toEqual([
    join("/w/.env.production.local"),
  ]);
  expect(autoloadedEnvFiles("/w", ["--no-env-file"], exists)).toEqual([]);
});
