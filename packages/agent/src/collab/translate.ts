import { readFileSync } from "node:fs";
import { resolve } from "node:path";
/**
 * Translate between omp Collab host/guest frames and omp-remote uplink/downlink
 * frames, so the phone keeps rendering its existing contract while the engine is
 * Collab.
 *
 * Reducer notes (verified against a real trace, see collab-trace.json):
 * - Only ASSISTANT messages stream. `message_start/update/end` events carry the
 *   full accumulating message with no stable id and can arrive out of order
 *   (an `update` before its `start`), so a message is keyed by one synthetic id
 *   that is assigned on the first non-empty emission and retired on `message_end`.
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
  InteractionQuestion,
  UplinkFrame,
} from "@omp-remote/protocol";
import {
  MAX_RESOURCE_BYTES,
  base64ByteLength,
  chunkBase64,
  parseXdevWrite,
} from "@omp-remote/protocol";
import type {
  CollabAgentEvent,
  CollabHostFrame,
  CollabSessionEntry,
  CollabSessionState,
  CollabUiRequest,
  CollabWireMessage,
} from "./schema";

const PREVIEW_MAX = 200;

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

function preview(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > PREVIEW_MAX
    ? `${text.slice(0, PREVIEW_MAX)}\u2026`
    : text;
}

/** Collapse whitespace and truncate to a single readable summary line. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX
    ? `${flat.slice(0, PREVIEW_MAX)}\u2026`
    : flat;
}

/** Salient argument keys, in priority order, for a one-line tool summary. */
const ARG_KEYS = [
  "command",
  "cmd",
  "path",
  "file",
  "pattern",
  "query",
  "url",
  "code",
  "input",
  "text",
  "prompt",
];

/** A concise human one-liner describing a tool call from its arguments. */
function argSummary(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return preview(args);
  // Tool arguments are arbitrary per-tool JSON (Zod `unknown`); read salient
  // string fields by key, guarding each access with a typeof check.
  const record = args as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return oneLine(value);
  }
  return preview(args);
}

/** Full value of the first path-like arg (`path`/`file`), or "" when none. Any
 *  read selector suffix (`:img`, `:50-100`) is left on for the reader to strip. */
function filePathFromArgs(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
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

/** One text block of a tool result, or "" if it is not a `{type:"text"}` block. */
function blockText(block: unknown): string {
  if (
    block &&
    typeof block === "object" &&
    "type" in block &&
    block.type === "text" &&
    "text" in block &&
    typeof block.text === "string"
  )
    return block.text;
  return "";
}

/** Readable text from a tool result (`{content:[{type,text}]}`), else a JSON preview. */
function resultText(value: unknown): string {
  if (typeof value === "string") return oneLine(value);
  if (value && typeof value === "object" && "content" in value) {
    const content = value.content;
    if (Array.isArray(content)) {
      const text = content.map(blockText).join("");
      if (text.trim()) return oneLine(text);
    }
  }
  return preview(value);
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
  /** Synthetic id of the assistant message currently streaming, or null between messages. */
  #streamId: string | null = null;
  /** Source time of the streaming message, fixed at its first emission so every phase shares it. */
  #streamAt: number | undefined;
  #streamStarted = false;
  #wasStreaming = false;
  #thinkingLevel?: string;
  #contextPct?: number;
  #contextTokens?: number;
  #contextWindow?: number;
  readonly #toolTitles = new Map<string, string>();
  readonly #toolFiles = new Map<string, string>();
  /** callId → xd:// device name, so a device call's card is labelled by the
   *  device (not the outer `write`) across its start and end frames. */
  readonly #toolDevices = new Map<string, string>();
  #cwd = "";

  constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  /** Translate an inbound host frame to zero or more uplink frames for the phone. */
  host(frame: CollabHostFrame): UplinkFrame[] {
    switch (frame.t) {
      case "welcome":
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
        // call id + tool name, so the card merges with its start (below).
        if (live) return [];
        const callId = message.toolCallId ?? entry.id ?? `t${++this.#seq}`;
        const title = this.#toolTitles.get(callId) ?? "";
        this.#toolTitles.delete(callId);
        const device = this.#toolDevices.get(callId);
        this.#toolDevices.delete(callId);
        return [
          this.#tool(
            callId,
            device ?? message.toolName ?? "",
            "end",
            message.isError ? "error" : "done",
            extractText(message.content),
            title,
          ),
        ];
      }
      const out: UplinkFrame[] = [];
      if (!live && role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type !== "toolCall" || !block.id) continue;
          if (block.name === "ask") continue; // surfaces via interaction instead
          const xdev = parseXdevWrite(block.name, block.arguments);
          const name = xdev ? xdev.device : (block.name ?? "");
          if (xdev) this.#toolDevices.set(block.id, xdev.device);
          const detail = argSummary(xdev ? xdev.content : block.arguments);
          const title = oneLine(block.intent ?? "") || detail;
          this.#toolTitles.set(block.id, title);
          out.push(
            this.#tool(block.id, name, "start", "running", detail, title),
          );
        }
      }
      if (live && role === "assistant") return out; // empty; text streamed via events
      const text = extractText(message.content);
      if (text)
        out.push(
          this.#msg(
            entry.id ?? `e${++this.#seq}`,
            "end",
            role,
            text,
            epochMs(message.timestamp) ?? epochMs(entry.timestamp),
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
      if (isEnd) this.#retireStream();
      return [];
    }
    const text = extractText(message.content);
    if (isEnd) {
      const id = this.#streamId;
      const at = id === null ? epochMs(message.timestamp) : this.#streamAt;
      this.#retireStream();
      if (!text) return [];
      return [this.#msg(id ?? `a${++this.#seq}`, "end", "assistant", text, at)];
    }
    if (!text) return [];
    if (this.#streamId === null) {
      this.#streamId = `a${++this.#seq}`;
      this.#streamAt = epochMs(message.timestamp);
    }
    const phase = this.#streamStarted ? "update" : "start";
    this.#streamStarted = true;
    return [
      this.#msg(this.#streamId, phase, "assistant", text, this.#streamAt),
    ];
  }

  #retireStream(): void {
    this.#streamId = null;
    this.#streamAt = undefined;
    this.#streamStarted = false;
  }

  #toolEvent(
    event: CollabAgentEvent,
    phase: "start" | "update" | "end",
    status: string,
  ): UplinkFrame[] {
    if (!event.toolCallId) return [];
    if (event.toolName === "ask") return []; // surfaces via interactionFrame instead
    const callId = event.toolCallId;
    let title = this.#toolTitles.get(callId);
    let device = this.#toolDevices.get(callId);
    let startPreview = "";
    if (phase === "start") {
      // An `xd://` device call surfaces only as the outer `write`; label the
      // card by the device and summarize its decoded args, not `{path,content}`.
      const xdev = parseXdevWrite(event.toolName, event.args);
      if (xdev) {
        device = xdev.device;
        this.#toolDevices.set(callId, device);
      }
      startPreview = argSummary(xdev ? xdev.content : event.args);
      title = oneLine(event.intent ?? "") || startPreview;
      if (title) this.#toolTitles.set(callId, title);
      if (!xdev) {
        const file = filePathFromArgs(event.args);
        if (file) this.#toolFiles.set(callId, file);
      }
    }
    const previewText =
      phase === "end"
        ? resultText(event.result)
        : phase === "update"
          ? resultText(event.partialResult)
          : startPreview;
    const frame = this.#tool(
      callId,
      device ?? event.toolName ?? "",
      phase,
      status,
      previewText,
      title ?? "",
    );
    if (phase === "end") {
      this.#toolTitles.delete(callId);
      this.#toolDevices.delete(callId);
      const sourcePath = this.#toolFiles.get(callId);
      this.#toolFiles.delete(callId);
      const result = event.result as { content?: unknown } | undefined;
      return [frame, ...this.#mediaFrames(callId, result?.content, sourcePath)];
    }
    return [frame];
  }

  /** Media (image) frames for any inline `{type:"image",data,mimeType}` blocks in a
   *  tool result's content, anchored to the tool call so the phone renders them under
   *  the tool card. Integrity rides the sealed channel, so no per-transfer hash. */
  #mediaFrames(
    callId: string,
    content: unknown,
    sourcePath?: string,
  ): UplinkFrame[] {
    // Prefer the ORIGINAL file on disk (true name + filetype) over omp's inline
    // content, which may be transcoded (a png read can arrive as webp).
    const original = sourcePath ? this.#readImageFile(sourcePath) : undefined;
    if (original)
      return this.#mediaFor(
        `${callId}:0`,
        callId,
        original.name,
        original.mimeType,
        original.data,
      );
    if (!Array.isArray(content)) return [];
    const base = sourcePath
      ? ((sourcePath.split(/[\\/]/).pop() ?? "").split(":")[0] ?? "")
      : "";
    const out: UplinkFrame[] = [];
    let ordinal = 0;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; data?: unknown; mimeType?: unknown };
      if (b.type !== "image" || typeof b.data !== "string") continue;
      const mime = typeof b.mimeType === "string" ? b.mimeType : "image/png";
      out.push(
        ...this.#mediaFor(
          `${callId}:${ordinal++}`,
          callId,
          base || undefined,
          mime,
          b.data,
        ),
      );
    }
    return out;
  }

  /** Build a `mediaInit` + ordered `mediaChunk`s for one image, or [] when it is
   *  empty or over the size budget. */
  #mediaFor(
    mediaId: string,
    callId: string,
    name: string | undefined,
    mimeType: string,
    data: string,
  ): UplinkFrame[] {
    const size = base64ByteLength(data);
    if (size === 0 || size > MAX_RESOURCE_BYTES) return [];
    const slices = chunkBase64(data);
    const out: UplinkFrame[] = [
      {
        t: "mediaInit",
        sessionId: this.#sessionId,
        mediaId,
        anchor: { kind: "tool", callId },
        name,
        mimeType,
        size,
        totalChunks: slices.length,
      },
    ];
    for (const [i, chunk] of slices.entries())
      out.push({
        t: "mediaChunk",
        sessionId: this.#sessionId,
        mediaId,
        index: i,
        data: chunk,
      });
    return out;
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
