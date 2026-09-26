import { expect, test } from "bun:test";
import { join } from "node:path";

// The PWA and its service worker bundle for the browser. A Node-only module
// reached from a browser import (a secret writer, the IPC handshake) fails
// this build, as `bun run build.ts` and `deploy:web` would.
test("the app and service worker bundle for the browser", async () => {
  const here = join(import.meta.dir, "..");
  const result = await Bun.build({
    entrypoints: [join(here, "src/main.ts"), join(here, "src/sw.ts")],
    define: { __OMP_BUILD_ID__: JSON.stringify("test") },
    target: "browser",
    throw: false,
  });
  expect(result.logs.map((log) => log.message)).toEqual([]);
  expect(result.success).toBe(true);
});
