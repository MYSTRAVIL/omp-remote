import { pairingSas, phoneCommitment, verifyPeerMac } from "@omp-remote/crypto";
import { PairClaimResponse } from "@omp-remote/protocol";
import { z } from "zod";
import { loadOrCreateIdentity } from "./pairing-browser";

/**
 * Dependencies of the phone-side pairing claim, injected so the flow is testable
 * without a DOM or network: the aggregator base URL, a `fetch`, the WebAuthn
 * session `token` (the `/pair/claim` route is session-gated, like
 * `/push/subscription`), and the storage accessors backing the pairing blob.
 */
export interface PairDeps {
  baseUrl: string;
  fetch: typeof fetch;
  token: string;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * A pairing the host proved under the code but this browser does not trust
 * yet: its host key is saved (`savePairing`) only once the user confirms that
 * `sas` matches the one the host shows.
 */
export interface ClaimedPairing {
  readonly machineId: string;
  readonly hostPub: string;
  readonly sas: string;
}

/** `/pair/claim`'s 409 when the pairing would replace a machine already on the server. */
const MachineExists = z.object({
  error: z.literal("machine-exists"),
  machineId: z.string(),
});

/** The server already has a machine named `machineId`; the claim replaced nothing. */
export class MachineExistsError extends Error {
  constructor(readonly machineId: string) {
    super(`a machine named ${machineId} is already on this server`);
    this.name = "MachineExistsError";
  }
}

/**
 * Claim a pending pairing the operator started on a host, binding this phone to
 * that host end-to-end through the content-blind aggregator (spec §7, §12).
 *
 * The phone commits to its own public key under the out-of-band `code`, POSTs
 * the claim, then verifies the host's role-tagged MAC over the key the relay
 * handed back. A relay that swapped the host key cannot forge that MAC without
 * the code, so a mismatch aborts here. Only the phone's own identity is stored
 * (minted on first use); the host key is NOT: the caller saves it once the
 * user has matched the returned SAS against the host's, since whoever made the
 * code (a link's sender, say) can also produce a valid MAC. A 409 naming a
 * machine the server already has throws {@link MachineExistsError}.
 */
export async function claimPairing(
  deps: PairDeps,
  code: string,
): Promise<ClaimedPairing> {
  const identity = await loadOrCreateIdentity(deps.getItem, deps.setItem);
  const phonePub = identity.publicKey;
  const { rendezvousId, mac: phoneMac } = await phoneCommitment(code, phonePub);
  const res = await deps.fetch(`${deps.baseUrl}/pair/claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${deps.token}`,
    },
    body: JSON.stringify({ rendezvousId, phonePub, phoneMac }),
  });
  if (res.status === 409) {
    const conflict = MachineExists.safeParse(
      await res.json().catch(() => undefined),
    );
    if (conflict.success) throw new MachineExistsError(conflict.data.machineId);
  }
  if (!res.ok) throw new Error(`pairing claim failed: ${res.status}`);
  const claim = PairClaimResponse.parse(await res.json());
  if (
    !(await verifyPeerMac(
      code,
      "host",
      claim.hostPub,
      claim.hostMac,
      claim.machineId,
    ))
  )
    throw new Error("host verification failed — possible MITM, not pairing");
  const sas = await pairingSas(code, claim.machineId, claim.hostPub, phonePub);
  return { machineId: claim.machineId, hostPub: claim.hostPub, sas };
}

/** A pairing link's fragment: `#pair=<code>`, as `omp-remote run` and `pair` print it. */
const PAIR_LINK = /^#pair=(.+)$/;

/**
 * Take the code a `#pair=<code>` link carries off the address, with
 * `history.replaceState`, so it never stays in the address bar, the history
 * or a bookmark. Main calls this before anything touches the network. The
 * code, or `undefined` when the address carries none (or a malformed one).
 */
export function takePairLinkCode(
  address: { readonly href: string },
  history: Pick<History, "state" | "replaceState">,
): string | undefined {
  const url = new URL(address.href);
  const encoded = PAIR_LINK.exec(url.hash)?.[1];
  if (encoded === undefined) return undefined;
  url.hash = "";
  history.replaceState(history.state, "", url);
  try {
    const code = decodeURIComponent(encoded).trim();
    return code.length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep taking pairing links while the app is open: a `#pair=<code>` opened in
 * this tab changes only the fragment, so no page load runs main again. Each
 * `hashchange` takes the code off the address first, as at load, then hands
 * it to `onCode`, which must ask before claiming it.
 */
export function watchPairLinks(
  target: Pick<Window, "addEventListener">,
  address: { readonly href: string },
  history: Pick<History, "state" | "replaceState">,
  onCode: (code: string) => void,
): void {
  target.addEventListener("hashchange", () => {
    const code = takePairLinkCode(address, history);
    if (code !== undefined) onCode(code);
  });
}
