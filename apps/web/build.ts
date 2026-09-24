import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// A per-build id busts the service-worker precache: the SW cache name embeds it,
// so every deploy ships a byte-changed sw.js the browser detects and reinstalls
// (re-precaching the new main.js). Falls back to a timestamp outside a git tree.
function resolveBuildId(): string {
  const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
  const sha = p.success ? p.stdout.toString().trim() : "";
  return sha.length > 0 ? sha : String(Date.now());
}
const buildId = resolveBuildId();

// Bundle the app entry and the service worker as browser targets. Entry basenames
// become `/main.js` and `/sw.js`, matching index.html and the SW registration.
const result = await Bun.build({
  entrypoints: [join(here, "src/main.ts"), join(here, "src/sw.ts")],
  outdir: dist,
  define: { __OMP_BUILD_ID__: JSON.stringify(buildId) },
  target: "browser",
  minify: true,
  sourcemap: "linked",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("web build failed");
}

// Copy the static shell (index.html, manifest, icon) verbatim.
await cp(join(here, "public"), dist, { recursive: true });

console.log(`built ${result.outputs.length} bundle(s) [${buildId}] → ${dist}`);
