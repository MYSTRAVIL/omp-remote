import { z } from "zod";

/**
 * Clear-text HTTP bodies for the aggregator-brokered pairing ceremony (spec §7,
 * §12). These cross the aggregator, so — like everything the aggregator touches
 * — they carry ONLY public keys, MACs, and a code-derived `rendezvousId`, never
 * a private/session key or any session content. Every value binds to the
 * out-of-band pairing code via `@omp-remote/crypto`; the aggregator matches
 * host↔phone on the opaque `rendezvousId` and forwards the rest verbatim.
 */

/**
 * A 32-byte value as unpadded base64url — 43 characters: a rendezvous id, a
 * device public key, or a MAC (see `@omp-remote/crypto`'s pairing ceremony).
 * Pinned so the open `/pair/*` routes never hold more than that per field.
 */
const Bytes32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `POST /pair/host` (open): the host registers a pending pairing. */
export const PairHostRequest = z.object({
  /** This machine's route label, echoed to the phone on claim. */
  machineId: z.string().min(1),
  /** Code-derived match key; the aggregator switches host↔phone on this alone. */
  rendezvousId: Bytes32,
  /** The host device's long-term public key. */
  hostPub: Bytes32,
  /** MAC over `hostPub` under the code — the phone verifies it end-to-end. */
  hostMac: Bytes32,
});
/** Response to `POST /pair/host`: when the pending pairing expires (epoch ms). */
export const PairHostResponse = z.object({ expiresAt: z.number().int() });

/** `POST /pair/claim` (session-token gated): the phone claims a pending pairing. */
export const PairClaimRequest = z.object({
  rendezvousId: Bytes32,
  /** The phone device's long-term public key. */
  phonePub: Bytes32,
  /** MAC over `phonePub` under the code — the host verifies it end-to-end. */
  phoneMac: Bytes32,
});
/** Response to a successful claim: the host side the phone binds to. */
export const PairClaimResponse = z.object({
  machineId: z.string().min(1),
  hostPub: z.string().min(1),
  hostMac: z.string().min(1),
});

/** `POST /pair/result` (open: only the code yields the rendezvousId): the host polls for the phone side. */
export const PairResultRequest = z.object({
  rendezvousId: Bytes32,
});
/**
 * Why the server refused a pairing's claim: `machine-exists` — the claim
 * would replace the token of a machine already on the server, and the host
 * did not present that machine's current token.
 */
export const PairRefusalReason = z.enum(["machine-exists"]);
/**
 * Response to `POST /pair/result`: `pending` until the phone claims, then
 * `claimed` with the phone side and the machine's new `/agent` token exactly
 * once (the broker drops it on delivery) — or, when the server refused the
 * claim, `refused` with why, likewise exactly once.
 */
export const PairResultResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("claimed"),
    phonePub: z.string().min(1),
    phoneMac: z.string().min(1),
    /** The bearer this machine presents on its `/agent` upgrade from now on. */
    agentToken: z.string().min(1),
  }),
  z.object({ status: z.literal("refused"), reason: PairRefusalReason }),
]);

export type PairHostRequest = z.infer<typeof PairHostRequest>;
export type PairHostResponse = z.infer<typeof PairHostResponse>;
export type PairClaimRequest = z.infer<typeof PairClaimRequest>;
export type PairClaimResponse = z.infer<typeof PairClaimResponse>;
export type PairResultRequest = z.infer<typeof PairResultRequest>;
export type PairResultResponse = z.infer<typeof PairResultResponse>;
export type PairRefusalReason = z.infer<typeof PairRefusalReason>;
