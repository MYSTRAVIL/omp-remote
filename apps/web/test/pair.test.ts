import { expect, test } from "bun:test";
import { hostCommitment, newIdentity, pairingSas } from "@omp-remote/crypto";
import { PairClaimRequest } from "@omp-remote/protocol";
import { type PairDeps, claimPairing } from "../src/core/pair";
import { loadPairedMachines, savePairing } from "../src/core/pairing-browser";

/** A Map-backed `localStorage` pair for the pairing blob (no DOM, no network). */
function storage(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
} {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

// Fixed codes keep the ceremony deterministic; `WRONG_CODE` models a relay that
// committed the host key under a code the phone never typed.
const CODE = "9F3K-2M7Q-8T4V-5X1Z";
const WRONG_CODE = "0R2S-4T6V-8W0X-2Y4Z";

/**
 * A `/pair/claim` double: records the posted claim, then answers as the host —
 * echoing `machineId` + `hostPub` + a `hostMac` committed under `commitCode`.
 * Passing `commitCode !== CODE` models the swapped-key relay.
 */
function claimFetch(
  hostPub: string,
  commitCode: string,
  calls: PairClaimRequest[],
): PairDeps["fetch"] {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    expect(new URL(String(input)).pathname).toBe("/pair/claim");
    calls.push(PairClaimRequest.parse(JSON.parse(String(init?.body))));
    const { mac: hostMac } = await hostCommitment(commitCode, "m1", hostPub);
    return new Response(JSON.stringify({ machineId: "m1", hostPub, hostMac }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as PairDeps["fetch"];
}

test("claimPairing claims and verifies the host MAC, but trusts the machine only once saved", async () => {
  const host = await newIdentity();
  const store = storage();
  const calls: PairClaimRequest[] = [];
  const deps: PairDeps = {
    baseUrl: "https://agg.test",
    fetch: claimFetch(host.publicKey, CODE, calls),
    token: "sess.tok",
    getItem: store.getItem,
    setItem: store.setItem,
  };

  const result = await claimPairing(deps, CODE);

  // The phone committed to its freshly-minted key; the returned SAS MUST be the
  // one derived over (host, phone) under the same code the phone claimed with.
  const phonePub = calls[0]?.phonePub;
  if (phonePub === undefined) throw new Error("claim was never posted");
  expect(result).toEqual({
    machineId: "m1",
    hostPub: host.publicKey,
    sas: await pairingSas(CODE, "m1", host.publicKey, phonePub),
  });

  // Claimed is not trusted: nothing is paired until the user matches the SAS.
  expect(await loadPairedMachines(store.getItem)).toEqual([]);
  savePairing(store.getItem, store.setItem, result.machineId, result.hostPub);
  const machines = await loadPairedMachines(store.getItem);
  expect(machines.map((m) => m.machineId)).toEqual(["m1"]);
});

test("claimPairing rejects a host MAC forged under a different code", async () => {
  const host = await newIdentity();
  const store = storage();
  const calls: PairClaimRequest[] = [];
  const deps: PairDeps = {
    baseUrl: "https://agg.test",
    fetch: claimFetch(host.publicKey, WRONG_CODE, calls),
    token: "sess.tok",
    getItem: store.getItem,
    setItem: store.setItem,
  };

  await expect(claimPairing(deps, CODE)).rejects.toThrow(
    /host verification failed/,
  );
  // The swapped key was refused before any trust was granted: nothing is paired.
  expect(await loadPairedMachines(store.getItem)).toEqual([]);
});
