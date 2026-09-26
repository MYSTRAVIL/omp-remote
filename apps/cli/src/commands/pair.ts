import { parseArgs } from "node:util";
import { type PairingResult, performPairing } from "@omp-remote/agent/src/pair";
import {
  type Config,
  loadConfig,
  saveConfig,
  secretPaths,
} from "@omp-remote/config";
import { newPairingCode } from "@omp-remote/crypto";
import { PairingStore } from "@omp-remote/crypto/pairing-store";
import { readSecret } from "@omp-remote/protocol/ipc";
import type { CliDeps } from "../deps";
import { renderQr } from "../qr";
import { httpBaseUrl, localServerUrl, pairLink, phoneUrls } from "../urls";

/** A config whose machine runs the host-agent. */
export type AgentConfig = Config & { agent: NonNullable<Config["agent"]> };

/**
 * The server this machine's agent talks to. A machine that runs the server
 * too reaches it over loopback, at `boundPort` once it is running, so an
 * edited `listen.port` never strands the agent. Otherwise `agent.serverUrl`.
 */
export function agentServerUrl(cfg: AgentConfig, boundPort?: number): string {
  return cfg.server === undefined
    ? cfg.agent.serverUrl
    : localServerUrl(
        cfg.server.listen.host,
        boundPort ?? cfg.server.listen.port,
      );
}

/**
 * Where the pairing QR sends the phone: the best URL of this machine's own
 * server when it runs one, else the server the agent joined.
 */
export async function pairingPhoneUrl(
  cfg: AgentConfig,
  deps: CliDeps,
  boundPort?: number,
): Promise<string> {
  if (cfg.server === undefined) return httpBaseUrl(cfg.agent.serverUrl);
  const port = boundPort ?? cfg.server.listen.port;
  const urls = phoneUrls(
    cfg.server,
    port,
    deps.networkInterfaces(),
    await deps.defaultRouteAddress(),
  );
  return urls[0]?.url ?? localServerUrl(cfg.server.listen.host, port);
}

/**
 * Whether this machine still has to pair a phone: it holds no machine token,
 * or `pairing.json` lacks the phone the agent serves (`agent.phoneId`, else
 * the first trusted one).
 */
export async function needsPairing(cfg: AgentConfig): Promise<boolean> {
  if ((await readSecret(secretPaths.agentToken)) === undefined) return true;
  const store = new PairingStore(secretPaths.pairing);
  await store.load();
  const phone =
    cfg.agent.phoneId === undefined
      ? store.peers()[0]
      : store.peer(cfg.agent.phoneId);
  return phone === undefined;
}

export interface PairTarget {
  machineId: string;
  /** The server URL this machine's agent uses; pairing runs on its HTTP base. */
  serverUrl: string;
  /** Where the phone reaches that server; the QR opens it with the code. */
  phoneUrl: string;
  /**
   * Present this machine's current token so the pairing may replace it. True
   * for `run` and `pair` (same server that issued it); false for `join`.
   */
  renew: boolean;
}

/**
 * Pair a phone with this machine: register the pairing with the server, show
 * the code with a QR of the phone's `#pair=` link, wait for the phone's
 * claim, and show the SAS. On success the machine's new token is in
 * `agent-token` and the phone is trusted in `pairing.json`.
 */
export async function pairPhone(
  target: PairTarget,
  deps: CliDeps,
): Promise<PairingResult> {
  const baseUrl = httpBaseUrl(target.serverUrl);
  let code: string | undefined;
  let qrShown = false;
  try {
    return await performPairing({
      baseUrl,
      fetch: deps.fetch,
      machineId: target.machineId,
      agentTokenPath: secretPaths.agentToken,
      store: new PairingStore(secretPaths.pairing, {
        onAclFailure: (failure) =>
          deps.print(
            `warning: could not restrict pairing.json to this account (${failure}); omp-remote doctor checks it`,
          ),
      }),
      renew: target.renew,
      newCode: async () => {
        code = await newPairingCode();
        return code;
      },
      print: (line) => {
        deps.print(line);
        // The first line naming the code comes once the server holds the pairing.
        if (code === undefined || qrShown || !line.includes(code)) return;
        qrShown = true;
        const link = pairLink(target.phoneUrl, code);
        deps.print(renderQr(link));
        deps.print(`Scan the QR code with your phone, or open ${link}`);
      },
      sleep: deps.sleep,
      now: deps.now,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`pairing with ${baseUrl} failed: ${reason}`, {
      cause: err,
    });
  }
}

/**
 * Make `phonePub` the phone this machine's agent serves, in `config.json`:
 * the newest pairing replaces the phone before it.
 */
export async function servePhone(
  cfg: AgentConfig,
  phonePub: string,
): Promise<AgentConfig> {
  const next = { ...cfg, agent: { ...cfg.agent, phoneId: phonePub } };
  await saveConfig(next);
  return next;
}

/** `omp-remote pair`: pair a phone with this machine, replacing the one it serves. */
export async function pair(args: string[], deps: CliDeps): Promise<number> {
  parseArgs({ args, options: {}, strict: true, allowPositionals: false });
  const loaded = await loadConfig();
  const agent = loaded.agent;
  if (agent === undefined)
    throw new Error(
      "this machine runs no agent; `omp-remote join <url>` adds one",
    );
  const cfg = { ...loaded, agent };
  const result = await pairPhone(
    {
      machineId: cfg.machineId,
      serverUrl: agentServerUrl(cfg),
      phoneUrl: await pairingPhoneUrl(cfg, deps),
      renew: true,
    },
    deps,
  );
  await servePhone(cfg, result.phonePub);
  deps.print(
    "Restart omp-remote so its agent serves the new phone: `omp-remote install` restarts the service, or restart `omp-remote run`.",
  );
  return 0;
}
