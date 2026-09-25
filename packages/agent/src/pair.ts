import { writeFileAtomic } from "@omp-remote/config";
import {
  type PairingStore,
  hostCommitment,
  newPairingCode,
  pairingSas,
  verifyPeerMac,
} from "@omp-remote/crypto";
import { PairHostResponse, PairResultResponse } from "@omp-remote/protocol";
import { readSecret } from "@omp-remote/protocol/ipc";

/**
 * Everything `performPairing` needs, with the impure edges (network, clock,
 * sleep, code generation, output) injected so the ceremony can be exercised
 * without real timers or sockets.
 */
export interface PairingDeps {
  baseUrl: string;
  fetch: typeof fetch;
  machineId: string;
  /**
   * Where to store the `/agent` token the aggregator issues on the phone's
   * claim (owner-only, 0600); the next uplink dial presents it.
   */
  agentTokenPath: string;
  store: PairingStore;
  /**
   * Present the token already at `agentTokenPath` on `/pair/host`, so the
   * claim may replace this machine's token. Set it only when pairing with the
   * server that issued that token (`run`, `pair`), never on `join`, which may
   * name another server that must not see it.
   */
  renew?: boolean;
  print: (line: string) => void;
  /** Defaults to `newPairingCode`; injected in tests to fix the code. */
  newCode?: () => Promise<string>;
  /** How often to poll `/pair/result` while waiting for the phone. */
  pollIntervalMs?: number;
  /** How long to wait for a claim before giving up. */
  timeoutMs?: number;
  /** Injected in tests so no wall-clock timer is used. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to `Date.now`; injected in tests for a deterministic clock. */
  now?: () => number;
}

export interface PairingResult {
  machineId: string;
  phonePub: string;
  sas: string;
  /** This machine's new `/agent` token, as stored at `agentTokenPath`. */
  agentToken: string;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 300_000;

/** No phone claimed the pairing code before it expired. */
export class PairingTimeoutError extends Error {
  constructor() {
    super("pairing timed out");
    this.name = "PairingTimeoutError";
  }
}

/**
 * Drive the host side of the brokered pairing ceremony end to end: register a
 * pending pairing with the aggregator, show the operator the code + SAS, poll
 * for the phone's claim, verify the phone's role-tagged MAC against the code,
 * and — only if it verifies — store the machine's new `/agent` token and trust
 * the phone peer in the store. Only the code yields the rendezvous id; with
 * `renew`, the machine presents its current token on `/pair/host`, since the
 * server lets a claim replace an existing machine's token only then (a machine
 * whose token is gone or unreadable pairs as a new one). When the server
 * refuses the claim because `machineId` is already on it, this rejects with
 * the fix, in one line.
 */
export async function performPairing(
  deps: PairingDeps,
): Promise<PairingResult> {
  const {
    baseUrl,
    fetch: doFetch,
    machineId,
    agentTokenPath,
    store,
    renew = false,
    print,
    newCode = newPairingCode,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = deps;

  await store.load();
  const hostPub = store.self().publicKey;
  const code = await newCode();
  const { rendezvousId, mac: hostMac } = await hostCommitment(
    code,
    machineId,
    hostPub,
  );

  const headers = { "content-type": "application/json" } as const;
  const current = renew
    ? await readSecret(agentTokenPath).catch(() => undefined)
    : undefined;

  const hostRes = await doFetch(`${baseUrl}/pair/host`, {
    method: "POST",
    headers:
      current === undefined
        ? headers
        : { ...headers, authorization: `Bearer ${current}` },
    body: JSON.stringify({ machineId, rendezvousId, hostPub, hostMac }),
  });
  if (!hostRes.ok) throw new Error(`pair/host failed: ${hostRes.status}`);
  PairHostResponse.parse(await hostRes.json());

  print(`Pairing code: ${code}`);
  print("Enter this code in the omp-remote app to pair, then compare the SAS.");

  const deadline = now() + timeoutMs;
  let claimed:
    | { phonePub: string; phoneMac: string; agentToken: string }
    | undefined;
  while (now() < deadline) {
    const resultRes = await doFetch(`${baseUrl}/pair/result`, {
      method: "POST",
      headers,
      body: JSON.stringify({ rendezvousId }),
    });
    if (!resultRes.ok)
      throw new Error(`pair/result failed: ${resultRes.status}`);
    const result = PairResultResponse.parse(await resultRes.json());
    if (result.status === "refused")
      throw new Error(
        `A machine named ${machineId} is already on this server. If that is this machine, revoke it under Settings > Machines on this server, then pair again. Otherwise use a different --name.`,
      );
    if (result.status === "claimed") {
      claimed = {
        phonePub: result.phonePub,
        phoneMac: result.phoneMac,
        agentToken: result.agentToken,
      };
      break;
    }
    await sleep(pollIntervalMs);
  }
  if (!claimed) throw new PairingTimeoutError();

  const { phonePub, phoneMac, agentToken } = claimed;
  if (!(await verifyPeerMac(code, "phone", phonePub, phoneMac)))
    throw new Error(
      "phone MAC verification failed — possible MITM, not pairing",
    );

  const sas = await pairingSas(code, machineId, hostPub, phonePub);
  print(`SAS: ${sas}`);

  await writeFileAtomic(agentTokenPath, agentToken);
  await store.trust({ id: phonePub, publicKey: phonePub });
  print(`Paired ${machineId} with phone ${phonePub}.`);

  return { machineId, phonePub, sas, agentToken };
}
