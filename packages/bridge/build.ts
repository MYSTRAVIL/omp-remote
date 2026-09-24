/**
 * Bundle the bridge into a single self-contained OMP extension file. OMP loads
 * extensions from `~/.omp/agent/extensions/` as standalone modules with no
 * workspace resolution, so the `@omp-remote/*` imports must be inlined. The host
 * runtime (`@oh-my-pi/pi-coding-agent`) is a type-only import (erased) and node
 * builtins stay external.
 *
 *   bun run build.ts            # -> dist/omp-remote-bridge.js
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
await mkdir(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(here, "src/index.ts")],
  target: "bun",
  format: "esm",
  external: ["@oh-my-pi/pi-coding-agent"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("bridge extension bundle failed");
}

const outfile = join(dist, "omp-remote-bridge.js");
await Bun.write(outfile, await result.outputs[0].text());
console.log(`bundled bridge extension → ${outfile}`);
