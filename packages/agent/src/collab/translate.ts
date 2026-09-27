import { readFileSync } from "node:fs";
import { resolve } from "node:path";
/**
 * Translate between omp Collab host/guest frames and omp-remote uplink/downlink
 * frames, so the phone keeps rendering its existing contract while the engine is
 * Collab.
 *
 * Reducer notes (verified against a real trace, see collab-trace.json):
 * - Only ASSISTANT messages stream. `message_start/update/end` events carry the
 *   full accumulating message with no id and can arrive out of order (an
 *   `update` before its `start`), but every event of one message carries its
 *   `timestamp`, so role + timestamp key the row (`FeedMsgIds`), exactly as
 *   they key that message's entry in a snapshot.
 * - Empty (tool-call-only) assistant messages emit nothing; the tool shows via
 *   `tool_execution_*` events.
 * - `toolResult` never becomes a message; live tool output rides the
 *   `tool_execution_*` events, and a finalized `entry` for an assistant message
 *   is skipped because it was already streamed. A `collab-prompt`
 *   `custom_message` (the injected remote prompt) is shown once as the user's
 *   message; any other is a `system` notice labelled by its `customType` (`kind`).
 */
import type { GuestFrame } from "@oh-my-pi/pi-wire";
import type {
  DownlinkFrame,
  ImageBlock,
  InteractionQuestion,
  MediaInitFrame,
  ToolCard,
  UplinkFrame,
} from "@omp-remote/protocol";
import {
  FeedMsgIds,
  MAX_RESOURCE_BYTES,
  describeToolCall,
  imageBlocks,
  mediaTransfer,
  toolPreview,
} from "@omp-remote/protocol";
import type {
  CollabAgentEvent,
  CollabHostFrame,
  CollabSessionEntry,
  CollabSessionState,
  CollabUiRequest,
  CollabWireMessage,
} from "./schema";

/** Collab ui-request reqId (number) <-> omp-remote interaction id (string). */
function interactionId(reqId: number): string {
  return `ui-${reqId}`;
}

function reqIdFromInteraction(id: string): number | undefined {
  if (!id.startsWith("ui-")) return undefined;
  const n = Number(id.slice(3));
  return Number.isInteger(n) ? n : undefined;
}

function extractText(
  content: CollabWireMessage["content"] | undefined,
): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

/** A Collab timestamp as epoch ms: message objects carry numeric ms, session
 *  entries an ISO string. Absent or malformed values yield undefined, so a
 *  foreign-format change drops only the time, never the frame. */
function epochMs(value: unknown): number | undefined {
  let ms = Number.NaN;
  if (typeof value === "number") ms = value;
  else if (typeof value === "string") ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** True image type from magic bytes (not the extension), or undefined. */
function mimeFromBytes(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (bytes.length >= 6 && bytes.toString("latin1", 0, 3) === "GIF")
    return "image/gif";
  return undefined;
}

function optionsFrom(request: CollabUiRequest): InteractionQuestion["options"] {
  if (!request.options || request.options.length === 0) return undefined;
  return request.options.map((option) =>
    typeof option === "string" ? { label: option } : option,
  );
}

export class CollabTranslator {
  readonly #sessionId: string;
  #model = "";
  #title = "";
  #seq = 0;
  /** Row ids of the messages that carry a timestamp (see `#streamAssistant`).
   *  A welcome's snapshot replays the history in order, so it starts afresh. */
  #ids = new FeedMsgIds();
  /** Row id of the assistant message last streamed, or null between messages. */
  #streamId: string | null = null;
  #wasStreaming = false;
  #thinkingLevel?: string;
  #contextPct?: number;
  #contextTokens?: number;
  #contextWindow?: number;
  /** callId → the card its start described, so the end (its event carries
   *  no args) keeps its label, title and argument, and a device call stays
   *  labelled by the device, not the outer `write`. */
  readonly #toolCards = new Map<string, ToolCard>();
  #cwd = "";

  constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  /** Translate an inbound host frame to zero or more uplink frames for the phone. */
  host(frame: CollabHostFrame): UplinkFrame[] {
    switch (frame.t) {
      case "welcome":
        this.#ids = new FeedMsgIds();
        this.#title = frame.header.title ?? frame.state.sessionName ?? "";
        this.#absorbState(frame.state);
        return this.#stateFrames(frame.state.isStreaming);
      case "state":
        this.#absorbState(frame.state);
        return this.#stateFrames(frame.state.isStreaming);
      case "snapshot-chunk":
        return frame.entries.flatMap((entry) =>
          this.#entryFrames(entry, false),
        );
      case "entry":
        return this.#entryFrames(frame.entry, true);
      case "event":
        return this.#eventFrames(frame.event);
      case "ui-request":
        return [this.#interactionFrame(frame.request)];
      case "ui-request-end":
        return [
          {
            t: "interactionEnd",
            sessionId: this.#sessionId,
            id: interactionId(frame.reqId),
            reason: "resolved",
          },
        ];
      case "bye":
        return [{ t: "bye", sessionId: this.#sessionId }];
      case "error":
        return [];
    }
  }

  /** Translate an outbound (phone -> session) frame to a Collab guest frame, or null if not applicable. */
  downlink(frame: DownlinkFrame): GuestFrame | null {
    switch (frame.t) {
      case "prompt":
        // Native Collab prompts always steer active turns. Queue/Steer prompts
        // travel over the supplemental mode-aware IPC bridge instead.
        return null;
      case "serviceTier":
        return null;
      case "interrupt":
        return { t: "abort" };
      case "interactionReply": {
        if (frame.response.kind !== "ask") return null;
        const reqId = reqIdFromInteraction(frame.id);
        if (reqId === undefined) return null;
        return { t: "ui-response", reqId, value: frame.response.answers[0] };
      }
      default:
        return null;
    }
  }

  /** Absorb the model/title/effort/context from a real host state so synthetic
   *  lifecycle states (agent/turn boundaries) can reuse the latest footer. */
  #absorbState(state: CollabSessionState): void {
    this.#model = state.model?.name ?? state.model?.id ?? this.#model;
    if (state.sessionName) this.#title = state.sessionName;
    if (state.cwd) this.#cwd = state.cwd;
    this.#thinkingLevel = state.thinkingLevel ?? this.#thinkingLevel;
    const usage = state.contextUsage;
    if (usage) {
      this.#contextPct = usage.percent ?? this.#contextPct;
      this.#contextTokens = usage.tokens ?? this.#contextTokens;
      this.#contextWindow = usage.contextWindow ?? this.#contextWindow;
    }
  }

  /** A state frame carrying the working flag, plus a one-shot idle `attention`
   *  when a turn just finished (drives push). */
  #stateFrames(streaming: boolean): UplinkFrame[] {
    const out: UplinkFrame[] = [this.#stateFrame(streaming)];
    if (this.#wasStreaming && !streaming) {
      out.push({ t: "attention", sessionId: this.#sessionId, reason: "idle" });
    }
    this.#wasStreaming = streaming;
    return out;
  }
  #stateFrame(streaming: boolean): UplinkFrame {
    const frame: UplinkFrame = {
      t: "state",
      sessionId: this.#sessionId,
      model: this.#model,
      thinkingLevel: this.#thinkingLevel,
      contextPct: this.#contextPct,
      streaming,
      title: this.#title,
    };
    if (this.#contextTokens !== undefined) {
      frame.contextTokens = this.#contextTokens;
    }
    if (this.#contextWindow !== undefined) {
      frame.contextWindow = this.#contextWindow;
    }
    return frame;
  }

  #interactionFrame(request: CollabUiRequest): UplinkFrame {
    const question: InteractionQuestion = { question: request.title };
    const options = optionsFrom(request);
    if (options) question.options = options;
    if (request.selectionMarker === "checkbox") question.multi = true;
    if (typeof request.initialIndex === "number")
      question.recommended = request.initialIndex;
    return {
      t: "interaction",
      sessionId: this.#sessionId,
      id: interactionId(request.reqId),
      payload: { kind: "ask", questions: [question] },
    };
  }

  #entryFrames(entry: CollabSessionEntry, live: boolean): UplinkFrame[] {
    if (entry.type === "message" && entry.message) {
      const message = entry.message;
      const role = message.role;
      if (role === "toolResult") {
        // Live tool output arrives via tool_execution events; only the historical
        // snapshot reconstructs a finished tool. The result message carries the
        // call id + tool name, so the card merges with its start (below). An
        // `ask` answers a question, which never showed as a card.
        if (live || message.toolName === "ask") return [];
        const callId = message.toolCallId ?? entry.id ?? `t${++this.#seq}`;
        const card = this.#toolCards.get(callId);
        this.#toolCards.delete(callId);
        return [
          this.#tool(
            callId,
            card?.name ?? message.toolName ?? "",
            "end",
            message.isError ? "error" : "done",
            toolPreview(card, message.content),
            card?.title,
          ),
        ];
      }
      const out: UplinkFrame[] = [];
      if (!live && role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type !== "toolCall" || !block.id) continue;
          if (block.name === "ask") continue; // surfaces via interaction instead
          const card = describeToolCall(
            block.name ?? "",
            block.arguments,
            block.intent,
          );
          this.#toolCards.set(block.id, card);
          out.push(
            this.#tool(
              block.id,
              card.name,
              "start",
              "running",
              card.argument,
              card.title,
            ),
          );
        }
      }
      if (live && role === "assistant") return out; // empty; text streamed via events
      const text = extractText(message.content);
      const timestamp = epochMs(message.timestamp);
      // A reply keys its row as it streamed; every one takes its occurrence,
      // text or not. A user message keeps its entry id, the same live and in
      // a snapshot, and always gets a row: an image sent without words
      // settles the phone's copy of it too.
      const msgId =
        role === "assistant" && timestamp !== undefined
          ? this.#ids.end("assistant", timestamp, text)
          : (entry.id ?? `e${++this.#seq}`);
      if (text || role === "user")
        out.push(
          this.#msg(
            msgId,
            "end",
            role,
            text,
            timestamp ?? epochMs(entry.timestamp),
          ),
        );
      // The photos sent with a prompt show in its bubble, after the row they
      // anchor to. Only live: a snapshot comes again with every reconnect.
      if (live && role === "user")
        for (const [i, image] of imageBlocks(message.content).entries())
          out.push(
            ...this.#mediaFor(
              `${msgId}:${i}`,
              { kind: "message", msgId },
              image,
            ),
          );
      return out;
    }
    if (entry.type === "custom_message" && entry.display !== false) {
      const text = extractText(entry.content);
      if (!text) return [];
      const prompt = entry.customType === "collab-prompt";
      return [
        this.#msg(
          entry.id ?? `c${++this.#seq}`,
          "end",
          prompt ? "user" : "system",
          text,
          epochMs(entry.timestamp),
          prompt ? undefined : entry.customType,
        ),
      ];
    }
    return [];
  }

  #eventFrames(event: CollabAgentEvent): UplinkFrame[] {
    switch (event.type) {
      case "message_start":
      case "message_update":
        return this.#streamAssistant(event, false);
      case "message_end":
        return this.#streamAssistant(event, true);
      case "tool_execution_start":
        return this.#toolEvent(event, "start", "running");
      case "tool_execution_update":
        return this.#toolEvent(event, "update", "running");
      case "tool_execution_end":
        return this.#toolEvent(event, "end", event.isError ? "error" : "done");
      case "agent_start":
      case "turn_start":
        return this.#stateFrames(true);
      case "agent_end":
        return this.#stateFrames(false);
      default:
        return [];
    }
  }

  #streamAssistant(event: CollabAgentEvent, isEnd: boolean): UplinkFrame[] {
    const message = event.message;
    if (
      !message ||
      typeof message !== "object" ||
      message.role !== "assistant"
    ) {
      if (isEnd) this.#streamId = null;
      return [];
    }
    const text = extractText(message.content);
    // omp gives a message no id, but all its events share one timestamp: it
    // keys the row, as it keys the message's snapshot entry, so a reconnect's
    // snapshot and a restarted translator land on the same rows instead of
    // doubling them or reusing a synthetic id. A message without one streams
    // under a synthetic id until it ends.
    const timestamp = epochMs(message.timestamp);
    // omp's trailing snapshot after `message_end` repeats the ended reply.
    if (
      !isEnd &&
      timestamp !== undefined &&
      this.#ids.repeatsEnded("assistant", timestamp, text)
    )
      return [];
    const id =
      timestamp === undefined
        ? (this.#streamId ?? `a${++this.#seq}`)
        : isEnd
          ? this.#ids.end("assistant", timestamp, text)
          : this.#ids.id("assistant", timestamp);
    const streamed = this.#streamId === id;
    if (isEnd) {
      this.#streamId = null;
      if (!text && !streamed) return [];
      return [this.#msg(id, "end", "assistant", text, timestamp)];
    }
    if (!text) return [];
    this.#streamId = id;
    return [
      this.#msg(
        id,
        streamed ? "update" : "start",
        "assistant",
        text,
        timestamp,
      ),
    ];
  }

  #toolEvent(
    event: CollabAgentEvent,
    phase: "start" | "update" | "end",
    status: string,
  ): UplinkFrame[] {
    if (!event.toolCallId) return [];
    if (event.toolName === "ask") return []; // surfaces via interactionFrame instead
    const callId = event.toolCallId;
    if (phase === "start") {
      const card = describeToolCall(
        event.toolName ?? "",
        event.args,
        event.intent,
      );
      this.#toolCards.set(callId, card);
      return [
        this.#tool(callId, card.name, phase, status, card.argument, card.title),
      ];
    }
    const card = this.#toolCards.get(callId);
    const name = card?.name ?? event.toolName ?? "";
    if (phase === "update")
      return [
        this.#tool(
          callId,
          name,
          phase,
          status,
          toolPreview(card, event.partialResult),
          card?.title,
        ),
      ];
    this.#toolCards.delete(callId);
    const result = event.result;
    return [
      this.#tool(
        callId,
        name,
        phase,
        status,
        toolPreview(card, result),
        card?.title,
      ),
      ...this.#mediaFrames(
        callId,
        typeof result === "object" && result !== null && "content" in result
          ? result.content
          : undefined,
        card?.file,
      ),
    ];
  }

  /** The images a tool result returned, anchored to its call so the phone
   *  shows them under the card. Integrity rides the sealed channel, so no
   *  per-transfer hash. */
  #mediaFrames(
    callId: string,
    content: unknown,
    sourcePath?: string,
  ): UplinkFrame[] {
    const images = imageBlocks(content);
    if (images.length === 0) return [];
    const anchor = { kind: "tool", callId } as const;
    // Prefer the ORIGINAL file on disk (true name + filetype) over omp's inline
    // content, which may be transcoded (a png read can arrive as webp).
    const original = sourcePath ? this.#readImageFile(sourcePath) : undefined;
    if (original)
      return this.#mediaFor(`${callId}:0`, anchor, original, original.name);
    const base = sourcePath
      ? ((sourcePath.split(/[\\/]/).pop() ?? "").split(":")[0] ?? "")
      : "";
    return images.flatMap((image, i) =>
      this.#mediaFor(`${callId}:${i}`, anchor, image, base || undefined),
    );
  }

  /** One image's frames (see `mediaTransfer`) stamped with this session: its
   *  `mediaInit` and chunks, or its `mediaInit` and the error to show in its
   *  place (over budget, or clipped by Collab's replication cap). */
  #mediaFor(
    mediaId: string,
    anchor: MediaInitFrame["anchor"],
    image: ImageBlock,
    name?: string,
  ): UplinkFrame[] {
    const transfer = mediaTransfer(mediaId, anchor, image, name);
    if (!transfer) return [];
    const sessionId = this.#sessionId;
    const init: UplinkFrame = { ...transfer.init, sessionId };
    if (!transfer.ok)
      return [
        init,
        { t: "mediaError", sessionId, mediaId, code: transfer.code },
      ];
    return [init, ...transfer.chunks.map((chunk) => ({ ...chunk, sessionId }))];
  }

  /** Read the original image the `read` tool referenced, so the phone gets the
   *  true filename + filetype instead of omp's transcoded inline copy. Returns
   *  undefined when the path isn't a readable local image within budget. */
  #readImageFile(
    sourcePath: string,
  ): { name: string; mimeType: string; data: string } | undefined {
    const match = /^(.+?\.(?:png|jpe?g|webp|gif|bmp|avif))(?::.*)?$/i.exec(
      sourcePath,
    );
    const filePath = match?.[1];
    if (!filePath) return undefined;
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolve(this.#cwd || ".", filePath));
    } catch {
      return undefined;
    }
    if (bytes.length === 0 || bytes.length > MAX_RESOURCE_BYTES)
      return undefined;
    const mimeType = mimeFromBytes(bytes);
    if (!mimeType) return undefined;
    const name = filePath.split(/[\\/]/).pop() ?? filePath;
    return { name, mimeType, data: bytes.toString("base64") };
  }

  #msg(
    msgId: string,
    phase: "start" | "update" | "end",
    role: string,
    text: string,
    at?: number,
    kind?: string,
  ): UplinkFrame {
    return {
      t: "msg",
      sessionId: this.#sessionId,
      phase,
      msgId,
      role,
      text,
      ...(at === undefined ? {} : { at }),
      ...(kind === undefined ? {} : { kind }),
    };
  }

  #tool(
    callId: string,
    name: string,
    phase: "start" | "update" | "end",
    status: string,
    previewText: string,
    title = "",
  ): UplinkFrame {
    return {
      t: "tool",
      sessionId: this.#sessionId,
      phase,
      callId,
      name,
      status,
      preview: previewText,
      title,
    };
  }
}
