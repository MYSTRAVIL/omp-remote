import { z } from "zod";

export const SessionMeta = z.object({
  id: z.string(),
  cwd: z.string(),
  project: z.string(),
  model: z.string(),
  title: z.string(),
  pid: z.number(),
  startedAt: z.number(),
  // set only for phone-spawned sessions; the bridge copies OMP_REMOTE_SPAWN_ID so the PWA can open exactly the spawn it requested.
  spawnId: z.string().optional(),
  // present only when the host-agent knows the session is running (prompt-control IPC is up) but has no transcript source (no Collab registration and no IPC feed).
  reachable: z.literal(false).optional(),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

const phase = z.enum(["start", "update", "end"]);

export const HelloFrame = z.object({
  t: z.literal("hello"),
  /** Bridges that predate the IPC handshake authenticate with the token here;
   *  a bridge that completed the handshake omits it (it never crosses the wire). */
  token: z.string().optional(),
  session: SessionMeta,
  /** Omitted for a full session bridge; `prompt-control` carries prompts only. */
  role: z.literal("prompt-control").optional(),
  /** Downlink frame types this bridge handles beyond the original set. The
   *  agent never sends a bridge a frame type it does not list here, because a
   *  bridge's IPC decoder drops the socket on an unknown `t`. */
  capabilities: z.array(z.string()).optional(),
});
/** Host-agent acknowledgement for an authenticated prompt-control IPC bridge. */
export const PromptControlReadyFrame = z.object({
  t: z.literal("promptControlReady"),
  sessionId: z.string(),
});
export const StateFrame = z.object({
  t: z.literal("state"),
  sessionId: z.string(),
  model: z.string(),
  thinkingLevel: z.string().optional(),
  contextPct: z.number().optional(),
  /** Context tokens used and the model's context window, when the host reports
   *  them; lets the phone show "A / B tokens" beside the percentage. Optional so
   *  a path that only knows the percentage still validates. */
  contextTokens: z.number().optional(),
  contextWindow: z.number().optional(),
  streaming: z.boolean(),
  title: z.string(),
  /** Priority service tier active for the current model's provider family.
   *  Bridge (IPC) path only; the collab translator omits it. */
  fastMode: z.boolean().optional(),
});
export const MsgFrame = z.object({
  t: z.literal("msg"),
  sessionId: z.string(),
  phase,
  msgId: z.string(),
  role: z.string(),
  text: z.string(),
  /** Host epoch ms when the message was written (Collab entry time) or first
   *  seen by the host-agent (IPC feed). Absent from older hosts. */
  at: z.number().optional(),
  /** The omp custom-message type (e.g. `async-result`) for a `system` message,
   *  so the phone can label the notice. Absent for ordinary messages. */
  kind: z.string().optional(),
});
export const ToolFrame = z.object({
  t: z.literal("tool"),
  sessionId: z.string(),
  phase,
  callId: z.string(),
  name: z.string(),
  status: z.string(),
  preview: z.string(),
  /** A stable one-line summary of the call (intent or key argument) for the
   *  card header; distinct from the evolving `preview` (args -> result). */
  title: z.string().optional(),
});
/** One background async job (task subagent, bash, eval) as surfaced to the phone. */
export const JobRow = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  status: z.string(),
  startMs: z.number(),
});
/** Agent → client: the session's live async-job snapshot. */
export const JobsFrame = z.object({
  t: z.literal("jobs"),
  sessionId: z.string(),
  running: z.array(JobRow),
  /** Count of recently-finished jobs (detail elided; keeps the frame small). */
  recent: z.number(),
});
/** One selectable model in a session's catalog (the set `--model` selection sees). */
export const CatalogModel = z.object({
  /** Selection spec the bridge resolves back to a model (`provider/id` or bare id). */
  id: z.string(),
  /** Human-readable display name. */
  name: z.string(),
  /** Provider id the model belongs to (groups the picker). */
  provider: z.string(),
  /** Thinking levels this model supports, low→high (drives the effort picker). */
  efforts: z.array(z.string()).default([]),
  /** True when the model accepts image input. */
  acceptsImages: z.boolean().optional(),
});
/** One configured role alias that currently resolves to a model. */
export const CatalogRole = z.object({
  /** Role name (e.g. `task`, `reviewer`); the bridge resolves `@<role>`. */
  role: z.string(),
  /** The model id the role resolves to now. */
  modelId: z.string(),
  /** Display name of the resolved model, if known. */
  modelName: z.string().optional(),
  /** Provider of the resolved model, if known. */
  provider: z.string().optional(),
  /** Thinking level baked into the role's spec (e.g. `xhigh`), applied on select. */
  effort: z.string().optional(),
});
/**
 * Agent → client: the session's selectable models grouped for the picker —
 * configured roles (only those that resolve to a model) plus every authenticated
 * model, by provider — with the current selection tagged so the drawer highlights
 * it without string-matching the footer. Sent on connect and whenever the set or
 * the current model/effort changes.
 */
export const ModelCatalogFrame = z.object({
  t: z.literal("modelCatalog"),
  sessionId: z.string(),
  models: z.array(CatalogModel),
  roles: z.array(CatalogRole),
  /** The current model's catalog id (`provider/id`), if one is set. */
  currentId: z.string().optional(),
  /** The current thinking level (effort), if any. */
  currentEffort: z.string().optional(),
  /** True when this catalog reflects the user's curated config (`enabledModels`
   *  / `modelRoles`). A bare fallback catalog (an early/probe extension load with
   *  no config visible) is `false`; the client refuses to downgrade a configured
   *  catalog to a fallback one so a probe load never clobbers the real set. */
  configured: z.boolean().optional(),
});
export const ByeFrame = z.object({
  t: z.literal("bye"),
  sessionId: z.string(),
});

export const PromptFrame = z.object({
  t: z.literal("prompt"),
  sessionId: z.string(),
  text: z.string(),
  mode: z.enum(["steer", "followUp", "aside"]),
  /** Resolved host resource ids (from a completed transfer) to attach to this
   *  message. The bridge resolves each to model image content before
   *  `sendUserMessage`; an unresolved id fails the send rather than dropping it. */
  attachments: z.array(z.string()).optional(),
});
export const InterruptFrame = z.object({
  t: z.literal("interrupt"),
  sessionId: z.string(),
});
/**
 * Phone → agent: toggle the priority service tier ("fast mode") for a session.
 * Bridge path only — the bridge maps it to `pi.setServiceTier(family, tier)`
 * for the current model's provider family. State-changing, so it is a
 * {@link ControlFrame} gated behind a fresh user-verification.
 */
export const ServiceTierFrame = z.object({
  t: z.literal("serviceTier"),
  sessionId: z.string(),
  enabled: z.boolean(),
});
/**
 * Phone → agent: switch the session's model. `model` is a selection spec —
 * `provider/id`, a bare id, or a role alias like `@task` — resolved host-side via
 * `ctx.models.resolve`; an unresolvable/unauthenticated spec is a no-op surfaced
 * only by the next `state`. State-changing → a UV-gated {@link ControlFrame}.
 */
export const SetModelFrame = z.object({
  t: z.literal("setModel"),
  sessionId: z.string(),
  model: z.string(),
});
/**
 * Phone → agent: set the session's thinking level (effort). `level` is an omp
 * `ThinkingLevel` string (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`);
 * an unsupported value for the current model is ignored host-side. UV-gated.
 */
export const SetThinkingLevelFrame = z.object({
  t: z.literal("setThinkingLevel"),
  sessionId: z.string(),
  level: z.string(),
});
/**
 * Phone → agent: compact the session context (optionally with instructions).
 * UV-gated; the host runs `ctx.compact` and the result surfaces in the transcript.
 */
export const CompactFrame = z.object({
  t: z.literal("compact"),
  sessionId: z.string(),
  instructions: z.string().optional(),
});
/**
 * Phone → agent: end the session. The bridge calls omp's `ctx.shutdown()`;
 * a bridge without the `closeSession` capability gets a `controlError` instead.
 */
export const CloseSessionFrame = z.object({
  t: z.literal("closeSession"),
  sessionId: z.string(),
});
/**
 * Approval mode a phone-spawned session launches with (spec §8 v1). These are
 * exactly the values omp's `--approval-mode` CLI flag accepts. An adopted TUI
 * session keeps answering approvals at the desk; only spawned sessions carry a
 * mode chosen here.
 */
export const ApprovalMode = z.enum(["always-ask", "write", "yolo"]);
/** The levels omp's `--thinking` CLI flag accepts (omp 18.2.11). */
export const SpawnThinkingLevel = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
]);
export type SpawnThinkingLevel = z.infer<typeof SpawnThinkingLevel>;
/**
 * An omp session id as the host's session store names it (a UUID, lowercase
 * hex). A closed charset because a resume id reaches a command line.
 */
export const StoredSessionId = z.string().regex(/^[0-9a-f][0-9a-f-]{7,63}$/);
/**
 * Phone → agent: launch a new `omp` session on the machine. `machineId` names
 * the target (the sealed channel is already per-machine; included per contract).
 * `cwd` is the project directory; `model` is optional; `approvalMode` is
 * mandatory so a spawned session always has an explicit, surfaced approval mode.
 * `spawnId` is a phone-generated nonce the host exports to the child as
 * `OMP_REMOTE_SPAWN_ID` and the bridge echoes back in `SessionMeta.spawnId`, so
 * the PWA can correlate the launch with exactly the session it started.
 * `resume` reopens a stored session of this `cwd` (`omp --resume <id>`); omp
 * restores that session's own model, so the host ignores `model` then.
 */
export const SpawnFrame = z.object({
  t: z.literal("spawn"),
  machineId: z.string(),
  cwd: z.string(),
  model: z.string().optional(),
  /** Thinking level to start with; the host passes it as `omp --thinking`.
   *  A closed enum because the value reaches a command line. */
  thinkingLevel: SpawnThinkingLevel.optional(),
  approvalMode: ApprovalMode,
  spawnId: z.string(),
  resume: StoredSessionId.optional(),
});
/**
 * Phone → agent: list the stored (not running) omp sessions of one project
 * directory, newest activity first. A read, like `sync`: not a
 * {@link ControlFrame}. The agent answers with a {@link HistoryFrame}.
 */
export const HistoryRequestFrame = z.object({
  t: z.literal("historyRequest"),
  cwd: z.string(),
});
/** One stored session in a {@link HistoryFrame}. Times are epoch ms. */
export const HistoryEntry = z.object({
  sessionId: StoredSessionId,
  title: z.string().optional(),
  startedAt: z.number(),
  lastActiveAt: z.number(),
});
/**
 * Agent → client: the stored sessions of `cwd` (echoed exactly as requested),
 * newest `lastActiveAt` first, at most 50, excluding sessions running now.
 */
export const HistoryFrame = z.object({
  t: z.literal("history"),
  cwd: z.string(),
  entries: z.array(HistoryEntry),
});
/**
 * Phone → agent: request a fresh session-list snapshot. A phone attaching to an
 * already-connected, steady machine gets no snapshot until the next registry
 * change (the aggregator is content-blind and never tells the agent a client
 * attached); the agent answers a sealed `sync` with `snapshot()`. Not
 * session-routed — it carries no `sessionId`.
 */
export const SyncFrame = z.object({
  t: z.literal("sync"),
});

/** Agent → client: the current machine-local session list snapshot. */
export const SessionsFrame = z.object({
  t: z.literal("sessions"),
  sessions: z.array(SessionMeta),
});

/**
 * Agent → client: a session needs the user's attention (its agent loop settled
 * idle awaiting input, or it is blocked on a tool approval). Carries only the
 * `sessionId` + a coarse `reason`; it is E2E-sealed, so the aggregator never
 * sees it. The push trigger the agent sends the aggregator (`AttentionMsg`)
 * carries a separately sealed `NotifyNotice` the aggregator cannot open, so
 * it stays content-blind (spec §4.3/§12, content-blind §7).
 */
export const AttentionFrame = z.object({
  t: z.literal("attention"),
  sessionId: z.string(),
  reason: z.enum(["idle", "approval"]),
});

/**
 * Phone → agent: how long the user must be away from this machine (no keyboard
 * or mouse input) before the agent may push a notification. `0` pushes always.
 * The agent persists it; the phone re-sends it on every connect. Not a
 * {@link ControlFrame}: it changes only where the user is told, never the
 * session, so it needs no fresh user-verification.
 */
export const NotifyPolicyFrame = z.object({
  t: z.literal("notifyPolicy"),
  awaySec: z.number().int().min(0).max(86_400),
});

/**
 * Agent → client: a control did not take effect. `prompt-control-unavailable`:
 * the frame could not reach the mode-aware extension control channel (the host
 * must not silently fall back to Collab's steer-only prompt, because that would
 * turn Queue into Steer). `control-failed`: the channel delivered it, but the
 * omp operation itself failed (e.g. compaction rejected).
 */
export const ControlErrorFrame = z.object({
  t: z.literal("controlError"),
  sessionId: z.string(),
  action: z.enum([
    "prompt",
    "setModel",
    "setThinkingLevel",
    "compact",
    "resourceInit",
    "resourceChunk",
    "resourceAbort",
    "closeSession",
  ]),
  code: z.enum([
    "prompt-control-unavailable",
    "control-failed",
    "close-unsupported",
  ]),
  message: z.string().min(1),
});

/** One question in an `ask` interaction (mirrors omp's built-in `ask` tool shape). */
export const InteractionQuestion = z.object({
  id: z.string().optional(),
  question: z.string(),
  options: z
    .array(z.object({ label: z.string(), description: z.string().optional() }))
    .optional(),
  multi: z.boolean().optional(),
  recommended: z.number().int().optional(),
});

/**
 * Agent → client: a session is blocked on a decision only the user can make — a
 * question the agent raised (`ask`) or a tool it wants to run (`approval`). The
 * client answers with a matching `interactionReply` echoing `id`; the first valid
 * answer wins, so a desk answer and a phone answer can never both apply. E2E-sealed,
 * so the aggregator never sees the payload.
 */
export const InteractionFrame = z.object({
  t: z.literal("interaction"),
  sessionId: z.string(),
  /** Opaque per-interaction id; the reply must echo it. */
  id: z.string(),
  payload: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ask"),
      questions: z.array(InteractionQuestion).min(1),
    }),
    z.object({
      kind: z.literal("approval"),
      tool: z.string(),
      reason: z.string().optional(),
      input: z.unknown().optional(),
      choices: z.array(z.string()).min(1),
    }),
  ]),
});

/**
 * Agent → client: a pending interaction was settled without this client (answered
 * at the desk, cancelled, aborted, or timed out). The client dismisses its prompt;
 * a late reply for this `id` is ignored by the agent.
 */
export const InteractionEndFrame = z.object({
  t: z.literal("interactionEnd"),
  sessionId: z.string(),
  id: z.string(),
  reason: z.enum(["resolved", "cancelled"]),
});

/**
 * Client → agent: the user's answer to an {@link InteractionFrame}. State-changing,
 * so it is a {@link ControlFrame} gated behind a fresh user-verification (spec §7).
 */
export const InteractionReplyFrame = z.object({
  t: z.literal("interactionReply"),
  sessionId: z.string(),
  id: z.string(),
  response: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ask"), answers: z.array(z.string()) }),
    z.object({
      kind: z.literal("approval"),
      decision: z.enum(["allow", "deny"]),
    }),
  ]),
});

/**
 * Permissive parse of a model's `ask` tool arguments into schema-valid
 * {@link InteractionQuestion}s for an {@link InteractionFrame}. Accepts options as
 * bare strings or `{label, description}` objects; drops anything malformed. Runs at
 * the bridge boundary so a frame that would fail the wire schema is never sent.
 */
const AskToolInput = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().optional(),
        question: z.string(),
        options: z
          .array(
            z.union([
              z.string(),
              z.object({
                label: z.string(),
                description: z.string().optional(),
              }),
            ]),
          )
          .optional(),
        multi: z.boolean().optional(),
        recommended: z.number().optional(),
      }),
    )
    .default([]),
});

export function normalizeAskQuestions(params: unknown): InteractionQuestion[] {
  const parsed = AskToolInput.safeParse(params);
  if (!parsed.success) return [];
  return parsed.data.questions.map((q) => {
    const question: InteractionQuestion = { question: q.question };
    if (q.id !== undefined) question.id = q.id;
    if (q.multi !== undefined) question.multi = q.multi;
    if (q.recommended !== undefined) question.recommended = q.recommended;
    if (q.options && q.options.length > 0) {
      question.options = q.options.map((option) =>
        typeof option === "string" ? { label: option } : option,
      );
    }
    return question;
  });
}
/** Attachment transfer bounds. A chunk carries base64 of at most this many raw
 *  bytes; a whole resource may not exceed the total. The web enforces both before
 *  the first frame; the host re-checks and rejects an over-budget transfer. */
export const MAX_RESOURCE_CHUNK_BYTES = 48 * 1024;
export const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
/** base64 characters that encode exactly `MAX_RESOURCE_CHUNK_BYTES` raw bytes.
 *  48 KiB is divisible by 3, so every full chunk is standalone-valid base64 (no
 *  interior padding) and slicing the whole base64 at this boundary reproduces the
 *  per-slice encoding byte-for-byte. */
export const MEDIA_B64_CHARS_PER_CHUNK = (MAX_RESOURCE_CHUNK_BYTES / 3) * 4;
/** Raw byte length encoded by a base64 string, accounting for `=` padding. */
export function base64ByteLength(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, (b64.length / 4) * 3 - pad);
}
/** Split a base64 payload into ordered slices, each of which decodes independently. */
export function chunkBase64(b64: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += MEDIA_B64_CHARS_PER_CHUNK)
    chunks.push(b64.slice(i, i + MEDIA_B64_CHARS_PER_CHUNK));
  return chunks;
}
/**
 * Phone → agent: announce an attachment upload. The bytes follow as ordered
 * {@link ResourceChunkFrame}s; the host assembles them, verifies `size`/`sha256`,
 * and answers `resourceReady` (with an opaque id to reference in a prompt) or
 * `resourceError`. Not UV-gated on its own — the transfer is inert until a
 * UV-gated `prompt` references the resulting id.
 */
export const ResourceInitFrame = z.object({
  t: z.literal("resourceInit"),
  sessionId: z.string(),
  transferId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive(),
  /** Lowercase hex SHA-256 of the full bytes; the host aborts on a mismatch. */
  sha256: z.string(),
});
/** Phone → agent: one ordered slice of an announced resource (base64). */
export const ResourceChunkFrame = z.object({
  t: z.literal("resourceChunk"),
  sessionId: z.string(),
  transferId: z.string(),
  index: z.number().int().nonnegative(),
  data: z.string(),
});
/** Phone → agent: cancel an in-flight transfer; the host drops partial bytes. */
export const ResourceAbortFrame = z.object({
  t: z.literal("resourceAbort"),
  sessionId: z.string(),
  transferId: z.string(),
});
/** Agent → client: chunks received so far, for upload progress. */
export const ResourceProgressFrame = z.object({
  t: z.literal("resourceProgress"),
  sessionId: z.string(),
  transferId: z.string(),
  received: z.number().int().nonnegative(),
});
/** Agent → client: the resource is assembled and verified; reference `resourceId`
 *  in a prompt's `attachments`. */
export const ResourceReadyFrame = z.object({
  t: z.literal("resourceReady"),
  sessionId: z.string(),
  transferId: z.string(),
  resourceId: z.string(),
});
/** Agent → client: the transfer failed and its partial bytes were dropped. */
export const ResourceErrorFrame = z.object({
  t: z.literal("resourceError"),
  sessionId: z.string(),
  transferId: z.string(),
  code: z.enum([
    "too-large",
    "integrity",
    "expired",
    "unsupported",
    "internal",
  ]),
});
/**
 * Host → phone image transfer. Integrity comes from the sealed E2E channel, so —
 * unlike the phone→host `resource*` upload frames — no per-transfer hash is carried.
 * `anchor` attaches the image to its transcript entry: a tool call's result (collab
 * path) or an assistant message (IPC path). Chunk sizing mirrors the upload path.
 */
export const MediaAnchor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool"), callId: z.string() }),
  z.object({ kind: z.literal("message"), msgId: z.string() }),
]);
export const MediaInitFrame = z.object({
  t: z.literal("mediaInit"),
  sessionId: z.string(),
  mediaId: z.string(),
  anchor: MediaAnchor,
  /** The source filename (basename) the image came from, if known. */
  name: z.string().optional(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive(),
  /**
   * Set on a backfill (`sync` replay) announcement: the chunks are NOT coming.
   * The phone shows a placeholder and sends `mediaFetch` when it needs the image.
   * A live transfer omits it and its chunks follow.
   */
  deferred: z.literal(true).optional(),
});
/**
 * Phone → agent: send the chunks of a retained image the phone was told about
 * with a `deferred` `mediaInit`. A read like `sync`, not a control action. The
 * agent answers with the full `mediaInit` + `mediaChunk`s, or a `mediaError`
 * with code `expired` when the image is no longer retained.
 */
export const MediaFetchFrame = z.object({
  t: z.literal("mediaFetch"),
  sessionId: z.string(),
  mediaId: z.string(),
});
/** Host → phone: one ordered slice of an announced media transfer (base64). */
export const MediaChunkFrame = z.object({
  t: z.literal("mediaChunk"),
  sessionId: z.string(),
  mediaId: z.string(),
  index: z.number().int().nonnegative(),
  data: z.string(),
});
/** Host → phone: the image could not be sent; the phone marks it failed. */
export const MediaErrorFrame = z.object({
  t: z.literal("mediaError"),
  sessionId: z.string(),
  mediaId: z.string(),
  code: z.enum(["too-large", "internal", "expired"]),
});
export const UplinkFrame = z.discriminatedUnion("t", [
  HelloFrame,
  StateFrame,
  MsgFrame,
  ToolFrame,
  JobsFrame,
  ByeFrame,
  AttentionFrame,
  InteractionFrame,
  InteractionEndFrame,
  ControlErrorFrame,
  ModelCatalogFrame,
  ResourceProgressFrame,
  ResourceReadyFrame,
  ResourceErrorFrame,
  MediaInitFrame,
  MediaChunkFrame,
  MediaErrorFrame,
]);
export const DownlinkFrame = z.discriminatedUnion("t", [
  PromptFrame,
  InterruptFrame,
  ServiceTierFrame,
  SpawnFrame,
  SyncFrame,
  InteractionReplyFrame,
  SetModelFrame,
  SetThinkingLevelFrame,
  CompactFrame,
  CloseSessionFrame,
  ResourceInitFrame,
  ResourceChunkFrame,
  ResourceAbortFrame,
  MediaFetchFrame,
  NotifyPolicyFrame,
  HistoryRequestFrame,
]);
/**
 * The state-changing subset of `DownlinkFrame` — every action gated behind a
 * fresh WebAuthn user-verification (spec §7). `sync` is deliberately excluded:
 * it is a read (snapshot request), not a command.
 */
export const ControlFrame = z.discriminatedUnion("t", [
  PromptFrame,
  InterruptFrame,
  ServiceTierFrame,
  SpawnFrame,
  InteractionReplyFrame,
  SetModelFrame,
  SetThinkingLevelFrame,
  CompactFrame,
  CloseSessionFrame,
]);
export const AnyFrame = z.union([
  UplinkFrame,
  DownlinkFrame,
  PromptControlReadyFrame,
]);
/** Everything the agent may push to a connected client: snapshots, stored
 *  session history, and relayed uplink frames. */
export const ClientMessage = z.union([
  SessionsFrame,
  HistoryFrame,
  UplinkFrame,
]);
/**
 * Everything the sealed phone↔host-agent `SealedChannel` may carry, in either
 * direction: the machine's session snapshot + relayed uplink frames (agent→phone)
 * and control frames (phone→agent). This is the E2E payload contract and is
 * deliberately broader than IPC `Frame`/`AnyFrame`, which the bridge↔agent
 * loopback uses and which never carries a `SessionsFrame`.
 */
export const SealedFrame = z.union([
  SessionsFrame,
  HistoryFrame,
  UplinkFrame,
  DownlinkFrame,
]);

export type UplinkFrame = z.infer<typeof UplinkFrame>;
export type DownlinkFrame = z.infer<typeof DownlinkFrame>;
/** A phone command for a machine or one of its sessions. `sync` is excluded:
 *  it is a backfill request each agent transport answers itself. */
export type DownlinkCommand = Exclude<DownlinkFrame, { t: "sync" }>;
export type ControlFrame = z.infer<typeof ControlFrame>;
export type ApprovalMode = z.infer<typeof ApprovalMode>;
export type Frame = z.infer<typeof AnyFrame>;
export type SessionsFrame = z.infer<typeof SessionsFrame>;
export type HistoryFrame = z.infer<typeof HistoryFrame>;
export type HistoryEntry = z.infer<typeof HistoryEntry>;
export type HistoryRequestFrame = z.infer<typeof HistoryRequestFrame>;
export type SpawnFrame = z.infer<typeof SpawnFrame>;
export type MsgFrame = z.infer<typeof MsgFrame>;
export type ServiceTierFrame = z.infer<typeof ServiceTierFrame>;
export type JobsFrame = z.infer<typeof JobsFrame>;
export type JobRow = z.infer<typeof JobRow>;
export type ClientMessage = z.infer<typeof ClientMessage>;
export type AttentionFrame = z.infer<typeof AttentionFrame>;
export type SealedFrame = z.infer<typeof SealedFrame>;
export type ControlErrorFrame = z.infer<typeof ControlErrorFrame>;
export type PromptControlReadyFrame = z.infer<typeof PromptControlReadyFrame>;
export type InteractionFrame = z.infer<typeof InteractionFrame>;
export type InteractionEndFrame = z.infer<typeof InteractionEndFrame>;
export type InteractionReplyFrame = z.infer<typeof InteractionReplyFrame>;
export type InteractionQuestion = z.infer<typeof InteractionQuestion>;
export type InteractionPayload = InteractionFrame["payload"];
export type InteractionResponse = InteractionReplyFrame["response"];
export type CatalogModel = z.infer<typeof CatalogModel>;
export type CatalogRole = z.infer<typeof CatalogRole>;
export type ModelCatalogFrame = z.infer<typeof ModelCatalogFrame>;
export type SetModelFrame = z.infer<typeof SetModelFrame>;
export type SetThinkingLevelFrame = z.infer<typeof SetThinkingLevelFrame>;
export type CompactFrame = z.infer<typeof CompactFrame>;
export type CloseSessionFrame = z.infer<typeof CloseSessionFrame>;
export type ResourceInitFrame = z.infer<typeof ResourceInitFrame>;
export type ResourceChunkFrame = z.infer<typeof ResourceChunkFrame>;
export type ResourceAbortFrame = z.infer<typeof ResourceAbortFrame>;
export type ResourceProgressFrame = z.infer<typeof ResourceProgressFrame>;
export type ResourceReadyFrame = z.infer<typeof ResourceReadyFrame>;
export type ResourceErrorFrame = z.infer<typeof ResourceErrorFrame>;
export type MediaInitFrame = z.infer<typeof MediaInitFrame>;
export type MediaChunkFrame = z.infer<typeof MediaChunkFrame>;
export type MediaErrorFrame = z.infer<typeof MediaErrorFrame>;
export type MediaFetchFrame = z.infer<typeof MediaFetchFrame>;

const DOWNLINK_TAGS: ReadonlySet<string> = new Set(
  DownlinkFrame.options.map((o) => o.shape.t.value),
);
/** Narrow an already-parsed {@link SealedFrame} to the phone→agent direction.
 *  Sound because no `t` tag is shared between the sessions, uplink and downlink
 *  unions (a protocol test guards that). */
export function isDownlinkFrame(f: SealedFrame): f is DownlinkFrame {
  return DOWNLINK_TAGS.has(f.t);
}
