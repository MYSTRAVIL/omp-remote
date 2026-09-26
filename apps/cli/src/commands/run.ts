import { join } from "node:path";
import { parseArgs } from "node:util";
import { type RunningAgent, startAgent } from "@omp-remote/agent/src/main";
import {
  type PairingResult,
  PairingTimeoutError,
} from "@omp-remote/agent/src/pair";
import {
  DEFAULT_WEB_ROOT,
  type RunningServer,
  startServer,
} from "@omp-remote/aggregator/src/main";
import { configPath, loadConfig } from "@omp-remote/config";
import type { CliDeps } from "../deps";
import { labelledPhoneUrl, phoneUrls } from "../urls";
import {
  type PairTarget,
  agentServerUrl,
  needsPairing,
  pairPhone,
  pairingPhoneUrl,
  servePhone,
} from "./pair";

/** apps/web/build.ts writes the PWA into the `dist/` beside it. */
const WEB_BUILD_SCRIPT = join(DEFAULT_WEB_ROOT, "..", "build.ts");

/**
 * Make sure the PWA the server serves is built. The checkout's own build (the
 * default webRoot) is built once on demand; a configured webRoot is the
 * operator's to fill.
 */
async function ensureWebApp(
  webRoot: string | undefined,
  deps: CliDeps,
): Promise<void> {
  const index = join(webRoot ?? DEFAULT_WEB_ROOT, "index.html");
  if (await Bun.file(index).exists()) return;
  if (webRoot !== undefined)
    throw new Error(
      `${index} is missing; build the web app into server.webRoot, or drop webRoot from ${configPath()}`,
    );
  // A compiled binary carries no checkout to build from: its paths live in
  // Bun's virtual `$bunfs`, and process.execPath is the binary, not bun.
  if (import.meta.dir.includes("$bunfs"))
    throw new Error(
      `this omp-remote binary has no web app to build; set server.webRoot in ${configPath()} to a built apps/web/dist`,
    );
  deps.print("Building the web app (first run only)...");
  const build = Bun.spawn([process.execPath, "run", WEB_BUILD_SCRIPT], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0 || !(await Bun.file(index).exists()))
    throw new Error(
      `building the web app failed; \`bun run ${WEB_BUILD_SCRIPT}\` shows why`,
    );
}

/**
 * Pair a phone for `run`, with a fresh code each time one expires: the
 * server keeps serving meanwhile, so a missed code never ends the process.
 * `undefined` when a stop is requested first.
 */
async function pairWhileRunning(
  target: PairTarget,
  deps: CliDeps,
  stopRequested: Promise<void>,
): Promise<PairingResult | undefined> {
  const stopped = stopRequested.then(() => undefined);
  for (;;) {
    try {
      return await Promise.race([pairPhone(target, deps), stopped]);
    } catch (err) {
      if (!(err instanceof Error && err.cause instanceof PairingTimeoutError))
        throw err;
      deps.print("The pairing code expired; here is a fresh one.");
    }
  }
}

/**
 * `omp-remote run`: run this machine's server and/or agent in the foreground
 * until SIGINT/SIGTERM. The agent of a machine that also runs the server dials
 * it over loopback. An agent with no machine token or no paired phone pairs
 * one first, showing a fresh code whenever one expires.
 */
export async function run(args: string[], deps: CliDeps): Promise<number> {
  parseArgs({ args, options: {}, strict: true, allowPositionals: false });
  const loaded = await loadConfig();
  const stopRequested = deps.stopRequested();
  let server: RunningServer | undefined;
  let agent: RunningAgent | undefined;
  const stop = async (): Promise<void> => {
    await agent?.stop();
    await server?.stop();
  };
  try {
    if (loaded.server !== undefined) {
      await ensureWebApp(loaded.server.webRoot, deps);
      server = await startServer(loaded);
      deps.print(
        `omp-remote server on port ${server.port}. Open it on your phone:`,
      );
      for (const url of phoneUrls(
        loaded.server,
        server.port,
        deps.networkInterfaces(),
        await deps.defaultRouteAddress(),
      ))
        deps.print(`  ${labelledPhoneUrl(url)}`);
    }
    if (loaded.agent !== undefined) {
      let cfg = { ...loaded, agent: loaded.agent };
      const serverUrl = agentServerUrl(cfg, server?.port);
      if (await needsPairing(cfg)) {
        const paired = await pairWhileRunning(
          {
            machineId: cfg.machineId,
            serverUrl,
            phoneUrl: await pairingPhoneUrl(cfg, deps, server?.port),
            renew: true,
          },
          deps,
          stopRequested,
        );
        if (paired === undefined) {
          await stop();
          return 0;
        }
        cfg = await servePhone(cfg, paired.phonePub);
      }
      agent = await startAgent({ ...cfg, agent: { ...cfg.agent, serverUrl } });
      deps.print(`Agent ${cfg.machineId} is connecting to ${serverUrl}.`);
    }
  } catch (err) {
    await stop();
    throw err;
  }
  deps.print("omp-remote is running; Ctrl+C stops it.");
  await stopRequested;
  await stop();
  return 0;
}
