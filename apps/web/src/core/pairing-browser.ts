import {
  type Identity,
  clientSessionKeys,
  newIdentity,
} from "@omp-remote/crypto";
import { z } from "zod";
import type { PairedMachine } from "./client";

/** `localStorage` key holding the phone's identity + trusted machine peers. */
export const PAIRING_KEY = "omp-remote.pairing";

const PairingBlob = z.object({
  identity: z.object({ publicKey: z.string(), secretKey: z.string() }),
  peers: z.array(z.object({ machineId: z.string(), publicKey: z.string() })),
});
type PairingBlob = z.infer<typeof PairingBlob>;

/**
 * Read + parse the pairing blob, or `null` when it is absent or malformed.
 * Every reader and writer below shares this one parse so the stored shape is
 * validated in a single place. `getItem` is injected so the storage layer is
 * testable without a DOM (production passes `localStorage.getItem`).
 */
function readBlob(getItem: (key: string) => string | null): PairingBlob | null {
  const raw = getItem(PAIRING_KEY);
  if (raw === null) return null;
  try {
    return PairingBlob.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Load the phone's paired machines and derive each machine's per-session keys.
 * The pairing blob is written by the (separate) pairing ceremony; until a machine
 * is paired this returns `[]` and the tree is empty. A missing or malformed blob
 * is treated as "no pairings", never a crash. `getItem` is injected so the loader
 * is testable without a DOM (production passes `localStorage.getItem`).
 */
export async function loadPairedMachines(
  getItem: (key: string) => string | null,
): Promise<PairedMachine[]> {
  const blob = readBlob(getItem);
  if (blob === null) return [];
  const machines: PairedMachine[] = [];
  for (const peer of blob.peers) {
    const keys = await clientSessionKeys(blob.identity, peer.publicKey);
    machines.push({ machineId: peer.machineId, keys });
  }
  return machines;
}

/**
 * The machineIds this browser holds a host key for, whether or not the machine
 * is online. Settings lists them so an offline (e.g. retired) machine can still
 * be renamed or forgotten. A missing or malformed blob means none.
 */
export function pairedMachineIds(
  getItem: (key: string) => string | null,
): string[] {
  return readBlob(getItem)?.peers.map((peer) => peer.machineId) ?? [];
}

/**
 * Load the phone's long-term identity, minting and persisting a fresh one on
 * first use. A missing or malformed blob is treated as "no identity yet": a new
 * identity is generated with an empty peer list and written back, so a later
 * {@link savePairing} has an identity to attach peers to. A valid blob returns
 * its stored identity unchanged.
 */
export async function loadOrCreateIdentity(
  getItem: (key: string) => string | null,
  setItem: (key: string, value: string) => void,
): Promise<Identity> {
  const blob = readBlob(getItem);
  if (blob !== null) return blob.identity;
  const identity = await newIdentity();
  setItem(PAIRING_KEY, JSON.stringify({ identity, peers: [] }));
  return identity;
}

/**
 * Upsert a paired machine's host public key into the stored blob, keyed by
 * `machineId` (re-pairing the same machine replaces its key rather than
 * duplicating it). The blob MUST already carry a phone identity — the pairing
 * flow always calls {@link loadOrCreateIdentity} first — so a missing/malformed
 * blob is a programmer error and throws rather than silently minting a new one.
 */
export function savePairing(
  getItem: (key: string) => string | null,
  setItem: (key: string, value: string) => void,
  machineId: string,
  hostPub: string,
): void {
  const blob = readBlob(getItem);
  if (blob === null)
    throw new Error("no phone identity; call loadOrCreateIdentity first");
  const peers = blob.peers.filter((peer) => peer.machineId !== machineId);
  peers.push({ machineId, publicKey: hostPub });
  setItem(PAIRING_KEY, JSON.stringify({ identity: blob.identity, peers }));
}

/**
 * Drop one machine's host key from the stored blob ("Forget on this device"),
 * keeping the phone identity and every other peer. This browser stops trusting
 * that host; nothing is revoked host-side, so pairing again with a fresh code
 * works. A machine that isn't paired here (or no blob at all) writes nothing.
 */
export function forgetPairing(
  getItem: (key: string) => string | null,
  setItem: (key: string, value: string) => void,
  machineId: string,
): void {
  const blob = readBlob(getItem);
  if (blob === null) return;
  const peers = blob.peers.filter((peer) => peer.machineId !== machineId);
  if (peers.length === blob.peers.length) return;
  setItem(PAIRING_KEY, JSON.stringify({ identity: blob.identity, peers }));
}
