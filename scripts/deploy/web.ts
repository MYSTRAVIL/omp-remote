#!/usr/bin/env bun
/**
 * One-command PWA deploy to the VPS.
 *
 * Builds apps/web, streams the dist tarball to the deploy host over ssh, and runs
 * scripts/deploy/deploy-web.sh there to land it as a versioned release and flip
 * the nginx symlink atomically. Then verifies the public site serves the new
 * build. No aggregator/nginx touch, no downtime, one-command rollback on the box.
 *
 *   bun run deploy:web
 *
 * The target comes from OMP_DEPLOY_HOST (ssh host) and OMP_DEPLOY_URL (public
 * URL), normally set in the repo-root .env; see ./target.ts. Requires ssh access
 * to the host (a key is enough) and tar/ssh/git on PATH.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deployTarget } from "./target";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { host, publicUrl } = deployTarget();

async function capture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: repoRoot,
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${cmd.join(" ")} failed: ${err.trim() || out.trim()}`);
  }
  return out;
}

async function step(label: string, exited: Promise<number>): Promise<void> {
  if ((await exited) !== 0) throw new Error(`${label} failed`);
}

// 1. Build id = the git short sha the web bundle embeds in its SW cache name.
const sha = (await capture(["git", "rev-parse", "--short", "HEAD"])).trim();
const dirty =
  (await capture(["git", "status", "--porcelain"])).trim().length > 0;
if (dirty)
  console.warn("⚠ working tree is dirty — deploying uncommitted changes");
const buildId = sha;

// 2. Build the PWA (build.ts stamps the SW cache with the same sha).
console.log(`building apps/web @ ${buildId} …`);
await step(
  "web build",
  Bun.spawn([process.execPath, "run", "build.ts"], {
    cwd: join(repoRoot, "apps", "web"),
    stdout: "inherit",
    stderr: "inherit",
  }).exited,
);

// 3. Stream dist/ (flat) to the box.
const distDir = join(repoRoot, "apps", "web", "dist");
const remoteTarball = `/tmp/omp-remote-web-${buildId}.tgz`;
console.log(`shipping dist → ${host}:${remoteTarball} …`);
const tar = Bun.spawn(["tar", "-czf", "-", "-C", distDir, "."], {
  stdout: "pipe",
  stderr: "inherit",
});
const put = Bun.spawn(["ssh", host, `cat > ${remoteTarball}`], {
  stdin: tar.stdout,
  stdout: "inherit",
  stderr: "inherit",
});
await step("upload", put.exited);
await step("tar", tar.exited);

// 4. Flip the release atomically on the box (deploy-web.sh piped over ssh stdin).
console.log("flipping release …");
const script = await Bun.file(
  join(repoRoot, "scripts", "deploy", "deploy-web.sh"),
).bytes();
const deploy = Bun.spawn(
  ["ssh", host, "bash", "-s", "--", buildId, remoteTarball],
  { stdin: script, stdout: "pipe", stderr: "inherit" },
);
const report = await new Response(deploy.stdout).text();
await step("remote deploy", deploy.exited);
process.stdout.write(report);

// 5. Verify the public edge serves the new build.
const expected = `omp-remote-shell-${buildId}`;
console.log(`verifying ${publicUrl}/sw.js serves ${expected} …`);
const swText = await (
  await fetch(`${publicUrl}/sw.js`, { cache: "no-store" })
).text();
if (swText.includes(expected)) {
  console.log(
    `✓ live: ${expected}. Reopen the PWA on the phone to pick up the new SW.`,
  );
} else {
  const live = swText.match(/omp-remote-shell-[a-z0-9]+/)?.[0] ?? "(none)";
  throw new Error(`public sw.js still serves ${live}, expected ${expected}`);
}
