import { z } from "zod";
import { NOTICE_ENVELOPE_MAX } from "./notify";

/**
 * Aggregator control protocol — the CLEAR-TEXT contract between a phone/client,
 * a host-agent, and the content-blind aggregator. These messages are NOT
 * end-to-end sealed frames (those travel in `SealedWireEnvelope`s); they
 * are aggregator-level switching control. The aggregator reads only these
 * control fields and the clear `route` of a sealed envelope — never plaintext.
 */

/**
 * Agent → aggregator: claim a machineId route. The socket authenticated at
 * upgrade with its machine's token; it may claim only the machineId that
 * token is bound to.
 */
export const RegisterMsg = z.object({
  type: z.literal("register"),
  machineId: z.string(),
});
/** Client → aggregator: join a machineId route to exchange sealed frames. */
export const AttachMsg = z.object({
  type: z.literal("attach"),
  machineId: z.string(),
});
/** Client → aggregator: request the list of currently-connected machineIds. */
export const ListMsg = z.object({ type: z.literal("list") });
/**
 * Agent → aggregator: a session on this machine needs attention, or a pushed
 * notice is stale — fan a Web Push to subscribed devices. It carries no clear
 * sessionId, title or text: only an opaque `notice` the aggregator cannot open,
 * so it learns only "this machine's route pinged" (routing metadata it already
 * holds). An attention push and a clear push look alike to it.
 */
export const AttentionMsg = z.object({
  type: z.literal("attention"),
  /**
   * A serialized `NotifyEnvelope` (see `notify.ts`), sealed by the agent with a
   * key the aggregator never holds. The aggregator passes it on verbatim as the
   * Web Push payload; absent means a payloadless push.
   */
  notice: z.string().max(NOTICE_ENVELOPE_MAX).optional(),
});
/**
 * Peer → aggregator: an application-level keepalive. Idle NAT mappings and
 * intermediate proxies drop silent sockets (spec §9); a peer pings on an idle
 * interval and the aggregator answers with `pong`, keeping the outbound socket
 * alive without touching any sealed content.
 */
export const PingMsg = z.object({ type: z.literal("ping") });

/** Anything a peer may send the aggregator as clear control. */
export const AggregatorControl = z.discriminatedUnion("type", [
  RegisterMsg,
  AttachMsg,
  ListMsg,
  AttentionMsg,
  PingMsg,
]);

/** Aggregator → client: the machineIds with a live agent. */
export const MachinesMsg = z.object({
  type: z.literal("machines"),
  machineIds: z.array(z.string()),
});
/** Aggregator → peer: a control-level rejection (e.g. bad token). */
export const ErrorMsg = z.object({
  type: z.literal("error"),
  reason: z.string(),
});
/** Aggregator → peer: the keepalive answer to a `ping`. */
export const PongMsg = z.object({ type: z.literal("pong") });

/** Anything the aggregator may send a peer as clear control. */
export const ServerControl = z.discriminatedUnion("type", [
  MachinesMsg,
  ErrorMsg,
  PongMsg,
]);

/**
 * The ONLY part of a sealed wire envelope the aggregator is permitted to read:
 * the clear `route` used for switching. It never parses `n`/`ct` (the sealed
 * payload). `.passthrough()` keeps the raw fields intact for verbatim forwarding.
 */
export const RoutedEnvelope = z.object({ route: z.string() }).passthrough();

export type RegisterMsg = z.infer<typeof RegisterMsg>;
export type AttachMsg = z.infer<typeof AttachMsg>;
export type ListMsg = z.infer<typeof ListMsg>;
export type AttentionMsg = z.infer<typeof AttentionMsg>;
export type PingMsg = z.infer<typeof PingMsg>;
export type AggregatorControl = z.infer<typeof AggregatorControl>;
export type MachinesMsg = z.infer<typeof MachinesMsg>;
export type ErrorMsg = z.infer<typeof ErrorMsg>;
export type PongMsg = z.infer<typeof PongMsg>;
export type ServerControl = z.infer<typeof ServerControl>;
export type RoutedEnvelope = z.infer<typeof RoutedEnvelope>;
