#!/usr/bin/env bun
/**
 * One-command aggregator deploy to the VPS — the service twin of deploy:web, so
 * the content-blind relay never drifts behind the source again.
 *
 * Cross-compiles apps/aggregator to a linux-x64 binary, streams it to the box,
 * and runs scripts/deploy/deploy-aggregator.sh there: it lands the binary as a
 * versioned release, flips the systemd ExecStart symlink atomically, restarts
 * the service, and rolls back if the new build does not come up. Then verifies
 * the public edge serves the auth ceremony.
 *
 *   bun run deploy:aggregator     # deploys HEAD
 *   OMP_DEPLOY_HOST / OMP_DEPLOY_URL (repo-root .env) name the target; see ./target.ts
 *
 * Requires SSH (root) to the box. The unit, env file (/etc/omp-remote/
 * aggregator.env), credential store and session secret are never touched, so a
 * deploy is a pure code swap — existing passkeys keep working.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deployTarget } from "./target";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { host, publicUrl } = deployTarget();
const target = "bun-linux-x64";

async function capture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${cmd.join(" ")} failed: ${err || out}`);
  }
  return out;
}

async function step(label: string, exited: Promise<number>): Promise<void> {
  if ((await exited) !== 0) throw new Error(`${label} failed`);
}

// 1. Build id = git short sha (matches deploy:web's scheme and the release dir).
const sha = (await capture(["git", "rev-parse", "--short", "HEAD"])).trim();
const dirty =
  (await capture(["git", "status", "--porcelain"])).trim().length > 0;
if (dirty)
  console.warn("⚠ working tree is dirty — deploying uncommitted changes");
const buildId = sha;

// 2. Cross-compile the aggregator for the box.
console.log(`building apps/aggregator @ ${buildId} (${target}) …`);
await step(
  "aggregator build",
  Bun.spawn([process.execPath, "run", "build.ts", "--target", target], {
    cwd: join(repoRoot, "apps", "aggregator"),
    stdout: "inherit",
    stderr: "inherit",
  }).exited,
);

// 3. Stream the binary (gzipped in-process) to the box.
const binPath = join(
  repoRoot,
  "apps",
  "aggregator",
  "dist",
  `omp-remote-aggregator-${target}`,
);
const remoteBin = `/tmp/omp-remote-aggregator-${buildId}`;
console.log(`shipping binary → ${host}:${remoteBin} …`);
const gz = Bun.gzipSync(await Bun.file(binPath).bytes());
const put = Bun.spawn(["ssh", host, `gunzip -c > ${remoteBin}`], {
  stdin: gz,
  stdout: "inherit",
  stderr: "inherit",
});
await step("upload", put.exited);

// 4. Swap the release + restart atomically on the box (script piped over stdin).
console.log("swapping release + restarting service …");
const script = await Bun.file(
  join(repoRoot, "scripts", "deploy", "deploy-aggregator.sh"),
).bytes();
const deploy = Bun.spawn(
  ["ssh", host, "bash", "-s", "--", buildId, remoteBin],
  { stdin: script, stdout: "pipe", stderr: "inherit" },
);
const report = await new Response(deploy.stdout).text();
await step("remote deploy", deploy.exited);
process.stdout.write(report);

// 5. Verify the public edge reaches the new aggregator (auth ceremony answers).
console.log(`verifying ${publicUrl}/auth/login/options …`);
const res = await fetch(`${publicUrl}/auth/login/options`, {
  method: "POST",
  cache: "no-store",
});
if (res.status === 200) {
  console.log("✓ aggregator live — public edge serves the auth ceremony");
} else {
  console.error(`✗ unexpected status ${res.status} from the public edge`);
  process.exit(1);
}
