import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Config, secretPaths } from "@omp-remote/config";
import { loadOrCreateSecret } from "@omp-remote/protocol/ipc";
import { z } from "zod";
import { MachineStore } from "./machine-store";
import { PairingBroker } from "./pairing";
import { PushService } from "./push";
import { PushSubscriptionStore } from "./push-store";
import { AggregatorServer } from "./server";
import type { VapidKeys } from "./vapid";
import { createWebAuthnGate } from "./webauthn";

/** The PWA this checkout builds, served when the config names no `webRoot`. */
export const DEFAULT_WEB_ROOT = resolve(import.meta.dir, "../../web/dist");

/** `vapid.json`: the VAPID key pair `omp-remote init` generates. */
const VapidFile = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
});

/** A started aggregator. */
export interface RunningServer {
  /** The TCP port it bound (resolves `listen.port: 0`). */
  port: number;
  stop(): Promise<void>;
}

/** The keys in `vapid.json`, or `undefined` when there is none: push stays off. */
async function loadVapidKeys(subject: string): Promise<VapidKeys | undefined> {
  let raw: string;
  try {
    raw = await readFile(secretPaths.vapid, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT")
      return undefined;
    throw err;
  }
  return { ...VapidFile.parse(JSON.parse(raw)), subject };
}

/**
 * Start the aggregator the config's `server` section describes. Its secrets and
 * stores live in the state dir ({@link secretPaths}); the session secret is
 * created there on first start.
 */
export async function startServer(cfg: Config): Promise<RunningServer> {
  const server = cfg.server;
  if (server === undefined) throw new Error("config has no server section");
  const auth = await createWebAuthnGate(
    {
      publicUrl: server.publicUrl,
      rpName: "omp-remote",
      sessionSecret: await loadOrCreateSecret(secretPaths.sessionSecret),
      sessionTtlSec: server.sessionTtlSec,
      rememberTtlSec: server.rememberTtlSec,
      passwordPath: secretPaths.password,
    },
    secretPaths.credentials,
  );
  const vapid = await loadVapidKeys(server.pushSubject);
  const push = vapid
    ? new PushService({
        keys: vapid,
        store: await PushSubscriptionStore.load(secretPaths.pushSubscriptions),
      })
    : undefined;
  const aggregator = new AggregatorServer({
    port: server.listen.port,
    hostname: server.listen.host,
    trustProxy: server.trustProxy,
    machines: await MachineStore.load(secretPaths.machines),
    auth,
    push,
    pairing: new PairingBroker(),
    collabRelay: server.collabRelay,
    webRoot: server.webRoot ?? DEFAULT_WEB_ROOT,
  });
  aggregator.start();
  return {
    port: aggregator.boundPort,
    stop: async () => aggregator.stop(),
  };
}
