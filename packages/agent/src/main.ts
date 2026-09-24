import { type Config, secretPaths } from "@omp-remote/config";
import { PairingStore, notifyKey, serverSessionKeys } from "@omp-remote/crypto";
import {
  IpcEndpointInUseError,
  type SecretOptions,
  devClientSecretPath,
  loadOrCreateSecret,
  prepareIpcEndpoint,
  readSecret,
  resolveIpcToken,
} from "@omp-remote/protocol/ipc";
import { CollabController } from "./collab";
import { meetsMinOmp, ompVersion } from "./collab/omp-cli";
import { CollabRegistryClient } from "./collab/registry-client";
import { type AgentStartFailure, consoleAgentDiagnostic } from "./diagnostics";
import { NotifyPolicy, notifyPolicyPath } from "./notify-policy";
import { agentSocketUrl } from "./server-url";
import { AgentService, type DevClientConfig } from "./service";
import { Uplink } from "./uplink";

const diagnostic = consoleAgentDiagnostic;

/** A started host-agent. */
export interface RunningAgent {
  stop(): Promise<void>;
}

/** The host-agent could not start; it logged `agent_start_failed` with `code`. */
export class AgentStartError extends Error {
  readonly code: AgentStartFailure;
  constructor(code: AgentStartFailure) {
    super(`host-agent failed to start: ${code}`);
    this.code = code;
  }
}

/** Log `agent_start_failed` and return the error to throw. */
function startFailed(code: AgentStartFailure): AgentStartError {
  diagnostic({ event: "agent_start_failed", code });
  return new AgentStartError(code);
}

/**
 * Start the host-agent the config's `agent` section describes: the IPC
 * endpoint its bridges dial, the loopback dev client when configured, the
 * uplink once this machine has joined (an `agent-token`) and paired a phone,
 * and Collab discovery when `collab` is on. A start that fails logs
 * `agent_start_failed`, releases what did start, and throws
 * {@link AgentStartError}.
 */
export async function startAgent(cfg: Config): Promise<RunningAgent> {
  const agent = cfg.agent;
  if (agent === undefined) throw startFailed("configuration-invalid");
  let uplinkUrl: string;
  try {
    uplinkUrl = agentSocketUrl(agent.serverUrl);
  } catch {
    throw startFailed("configuration-invalid");
  }

  // A secret that stays readable by other accounts is a warning, not fatal.
  const secretOptions: SecretOptions = {
    onAclFailure: (code) => diagnostic({ event: "secret_acl_failed", code }),
  };
  let token: string;
  let devClient: DevClientConfig | undefined;
  try {
    token = await resolveIpcToken(process.env, secretOptions);
    // The loopback dev client is opt-in; otherwise nothing listens on TCP.
    if (agent.devClient)
      devClient = {
        port: agent.devClient.port,
        allowedOrigins: agent.devClient.origins,
        secret: await loadOrCreateSecret(devClientSecretPath(), secretOptions),
      };
  } catch {
    throw startFailed("secret-unavailable");
  }
  let ipcPath: string;
  try {
    ipcPath = await prepareIpcEndpoint();
  } catch {
    throw startFailed("service-start-failed");
  }
  // The phone's notify policy, as it last set it; reading it never throws.
  const notifyPolicy = new NotifyPolicy({
    path: notifyPolicyPath(),
    diagnostic,
  });
  await notifyPolicy.load();
  const svc = new AgentService({
    token,
    ipcPath,
    devClient,
    diagnostic,
    notifyPolicy,
  });
  try {
    await svc.start();
  } catch (err) {
    const failure = startFailed(
      err instanceof IpcEndpointInUseError
        ? "ipc-endpoint-in-use"
        : "service-start-failed",
    );
    // Close whatever did start (IPC), so no half-started agent lingers.
    await svc.stop();
    throw failure;
  }

  // The outbound uplink runs once pairing has issued this machine's token.
  let uplink: Uplink | undefined;
  try {
    const agentToken = await readSecret(secretPaths.agentToken);
    if (agentToken === undefined) {
      diagnostic({
        event: "uplink_not_started",
        code: "agent-token-not-found",
      });
    } else {
      const store = new PairingStore(secretPaths.pairing);
      await store.load();
      const phone = agent.phoneId
        ? store.peer(agent.phoneId)
        : store.peers()[0];
      if (!phone) {
        diagnostic({ event: "uplink_not_started", code: "pairing-not-found" });
      } else {
        const keys = await serverSessionKeys(store.self(), phone.publicKey);
        uplink = new Uplink({
          url: uplinkUrl,
          machineId: cfg.machineId,
          token: agentToken,
          keys,
          feed: svc,
          diagnostic,
          // The phone opens the notices with the same key, from its `rx`.
          notifyKey: await notifyKey(keys.tx),
          notifyPolicy,
        });
        uplink.start();
      }
    }
  } catch {
    const failure = startFailed("uplink-start-failed");
    await svc.stop();
    throw failure;
  }

  // Logged once IPC is listening and the uplink (when configured) has started,
  // so a health check that sees this line also sees any uplink_started before it.
  diagnostic({
    event: "agent_listening",
    devClientPort: devClient ? svc.boundPort : undefined,
  });

  let collab: CollabController | undefined;
  if (agent.collab) {
    try {
      const version = await ompVersion(agent.ompBin);
      if (!meetsMinOmp(version)) {
        diagnostic({ event: "collab_not_started", code: "unsupported-omp" });
      } else {
        const registry = new CollabRegistryClient();
        collab = new CollabController({
          service: svc,
          listHosts: registry.listHosts,
          linkFor: registry.linkFor,
          excludeSessionId: process.env.OMP_REMOTE_SELF_SESSION,
          diagnostic,
        });
        collab.start();
      }
    } catch {
      // Collab setup is additive; the IPC bridge remains available.
      diagnostic({ event: "collab_not_started", code: "setup-failed" });
    }
  }

  return {
    stop: async () => {
      collab?.stop();
      uplink?.stop();
      await svc.stop();
    },
  };
}
