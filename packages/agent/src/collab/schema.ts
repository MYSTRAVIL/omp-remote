/**
 * Zod schemas for the inbound Collab `HostFrame` variants the guest adapter
 * consumes. The relay authenticates frames cryptographically (AES-256-GCM with
 * the room key), but the host is a foreign, fast-moving protocol (COLLAB_PROTO
 * churn), so every decrypted frame is parsed here at the trust boundary rather
 * than cast. Only consumed fields are modelled; objects `.passthrough()` extras,
 * and unknown `t` values fail the union and are ignored by the caller — the
 * tolerant-skip pi-wire itself prescribes.
 */
import { z } from "zod";

const contentBlock = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    // `toolCall` blocks (in an assistant message) carry the invocation.
    id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.unknown().optional(),
    intent: z.string().optional(),
  })
  .passthrough();

const textOrBlocks = z.union([z.string(), z.array(contentBlock)]);

const wireMessage = z
  .object({
    role: z.string(),
    content: textOrBlocks,
    // Present on a `toolResult` message: which call it answers and its outcome.
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

const sessionEntry = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    message: wireMessage.optional(),
    customType: z.string().optional(),
    content: textOrBlocks.optional(),
    display: z.boolean().optional(),
  })
  .passthrough();

const agentEvent = z
  .object({
    type: z.string(),
    message: z.union([wireMessage, z.string()]).optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    partialResult: z.unknown().optional(),
    isError: z.boolean().optional(),
    intent: z.string().optional(),
  })
  .passthrough();

const sessionState = z
  .object({
    isStreaming: z.boolean(),
    sessionName: z.string().optional(),
    cwd: z.string().optional(),
    model: z
      .object({ id: z.string(), name: z.string(), provider: z.string() })
      .partial()
      .passthrough()
      .optional(),
    contextUsage: z
      .object({
        percent: z.number().nullable(),
        tokens: z.number().nullable().optional(),
        contextWindow: z.number().nullable().optional(),
      })
      .passthrough()
      .optional(),
    thinkingLevel: z.string().optional(),
  })
  .passthrough();

const sessionHeader = z
  .object({
    title: z.string().optional(),
    cwd: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough();

const uiRequest = z
  .object({
    reqId: z.number(),
    kind: z.enum(["select", "editor"]),
    title: z.string(),
    options: z
      .array(
        z.union([
          z.string(),
          z
            .object({ label: z.string(), description: z.string().optional() })
            .passthrough(),
        ]),
      )
      .optional(),
    initialIndex: z.number().optional(),
    selectionMarker: z.enum(["radio", "checkbox"]).optional(),
    helpText: z.string().optional(),
    prefill: z.string().optional(),
  })
  .passthrough();

export const CollabHostFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"),
    proto: z.number(),
    header: sessionHeader,
    state: sessionState,
    entryCount: z.number(),
    readOnly: z.boolean().optional(),
  }),
  z.object({
    t: z.literal("snapshot-chunk"),
    entries: z.array(sessionEntry),
    final: z.boolean(),
  }),
  z.object({ t: z.literal("entry"), entry: sessionEntry }),
  z.object({ t: z.literal("event"), event: agentEvent }),
  z.object({ t: z.literal("state"), state: sessionState }),
  z.object({ t: z.literal("ui-request"), request: uiRequest }),
  z.object({ t: z.literal("ui-request-end"), reqId: z.number() }),
  z.object({ t: z.literal("bye"), reason: z.string() }),
  z.object({ t: z.literal("error"), message: z.string() }),
]);

export type CollabHostFrame = z.infer<typeof CollabHostFrameSchema>;
export type CollabUiRequest = z.infer<typeof uiRequest>;
export type CollabSessionState = z.infer<typeof sessionState>;
export type CollabSessionEntry = z.infer<typeof sessionEntry>;
export type CollabAgentEvent = z.infer<typeof agentEvent>;
export type CollabWireMessage = z.infer<typeof wireMessage>;
