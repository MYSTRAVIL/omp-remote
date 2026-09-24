/**
 * Compile the `omp-remote` CLI (apps/cli/src/main.ts) to a single
 * self-contained binary via `bun build --compile`, for the public server: it
 * runs `<binary> run` with a server-only config.json in its state dir. The
 * server no longer has an entry point of its own. Usage:
 *
 *   bun run build.ts                       # native binary → dist/
 *   bun run build.ts --target bun-linux-x64
 *
 * Each `--target` produces `dist/omp-remote-aggregator-<target>`; with no
 * target it builds `dist/omp-remote-aggregator` for the host. The name stays
 * the one the deploy scripts ship. Exits non-zero if any compile fails.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const entry = join(here, "../cli/src/main.ts");
const name = "omp-remote-aggregator";

const targets: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--target") {
    const value = argv[i + 1];
    if (value === undefined) throw new Error("build: --target needs a value");
    targets.push(value);
    i += 1;
  } else {
    throw new Error(`build: unknown argument ${argv[i]}`);
  }
}

await mkdir(dist, { recursive: true });

async function compile(target: string | undefined): Promise<void> {
  const outfile = join(dist, target ? `${name}-${target}` : name);
  const args = ["build", "--compile", entry, "--outfile", outfile];
  if (target !== undefined) args.push(`--target=${target}`);
  const proc = Bun.spawn(["bun", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0)
    throw new Error(
      `build: bun build --compile failed (exit ${code})${target ? ` for ${target}` : ""}`,
    );
  console.log(`compiled omp-remote → ${outfile}`);
}

if (targets.length === 0) {
  await compile(undefined);
} else {
  for (const target of targets) await compile(target);
}
