import { z } from "zod";

/**
 * The E2E `SealedChannel` wire format (v2): one JSON line per envelope, which the
 * content-blind aggregator forwards verbatim, reading only `route`. The clear
 * header binds every envelope against replay: the sender's random per-instance
 * epoch `e`, its monotonic counter `c`, and the receiver epoch `a` it is bound
 * to. Every header field is AEAD associated data, so editing one makes the
 * envelope fail to open. Only the frame payload (`n` + `ct`) is secret.
 */

/** A sender's message counter: a safe non-negative integer. */
const SealedCounter = z.number().int().nonnegative();

export const SealedWireEnvelope = z.object({
  /** The clear switching key (= machineId), the one field the aggregator reads. */
  route: z.string(),
  /**
   * `d` data (payload: a JSON `SealedFrame`), `h` hello (empty payload), `a` ack
   * (payload: {@link SealedAckPayload}).
   */
  k: z.enum(["d", "h", "a"]),
  /** The sender's epoch: random bytes, base64url, drawn per channel instance. */
  e: z.string(),
  /** The sender's counter: every envelope it sends takes the next value. */
  c: SealedCounter,
  /** The receiver epoch this envelope is bound to (phone data, acks). */
  a: z.string().optional(),
  /** The AEAD nonce, base64url. */
  n: z.string(),
  /** The sealed payload, base64url. */
  ct: z.string(),
});

/**
 * The sealed payload of an ack (`k: "a"`): the counter `c` of the initiator hello
 * it answers. An initiator accepts only an ack that answers a newer hello than
 * the last ack it accepted, so a recorded ack can never re-bind it to an older
 * responder epoch.
 */
export const SealedAckPayload = SealedCounter;

export type SealedWireEnvelope = z.infer<typeof SealedWireEnvelope>;
