import type { JobRow, MediaInitFrame, UplinkFrame } from "@omp-remote/protocol";
import { MAX_RESOURCE_BYTES } from "@omp-remote/protocol";
import { fromBase64, toBase64 } from "./base64";

/**
 * A live session transcript, reduced from the ordered bridge event feed
 * (`@omp-remote/protocol` `UplinkFrame`s relayed over the sealed channel). The
 * reducer is the deterministic, testable heart of the session view (spec §6):
 * the DOM render is a thin projection of `TranscriptState`.
 *
 * Contract (no bridge capture dictates these yet — decided here):
 * - `msg.text` is a FULL SNAPSHOT of the block at that phase, so `update`/`end`
 *   REPLACE the accumulated text (never concatenate); robust under drop-oldest.
 * - `msg.role` carries assistant / thinking / user; the render keys a class off it.
 * - entries (message blocks + tool cards) keep FIRST-SEEN order, keyed by
 *   `msgId` / `callId`; later frames for a known key mutate in place.
 */

export interface MessageEntry {
  kind: "message";
  msgId: string;
  role: string;
  text: string;
  /** True while the block is still streaming; false once its `end` phase lands. */
  streaming: boolean;
  /** Set while this is a local, unconfirmed echo of a just-sent prompt — the send
   *  mode — awaiting the agent's own message frame to reconcile it in place: a
   *  `steer` is not yet steered in, a `followUp` not yet started. */
  pending?: "steer" | "followUp";
  /** Media embedded in this message (downlink images, assembled from media frames). */
  media?: MediaEntry[];
  /** Host epoch ms the message was written, or first seen by the host; taken
   *  from the first frame that carries it and kept. Absent from older hosts
   *  and from local echoes until the host's frame adopts them. */
  at?: number;
  /** What produced a `system` message (the msg frame's `kind`, e.g.
   *  `async-result`), for labelling its notice card. Named apart from the
   *  entry discriminator `kind`. */
  noticeKind?: string;
}

export interface MediaEntry {
  mediaId: string;
  /** Source filename, if the host knew it (for the download name). */
  name?: string;
  mimeType: string;
  size: number;
  totalChunks: number;
  chunks: (Uint8Array | undefined)[];
  received: number;
  /**
   * `deferred`: a backfill only announced it; its bytes stay on the host until
   * this phone asks for them (`mediaFetch`). `expired`: the host no longer
   * holds it.
   */
  status: "deferred" | "loading" | "ready" | "error" | "expired";
  dataUrl?: string;
  /** Set once this phone asked the host for a deferred image's bytes; see
   *  {@link claimMediaFetch}. */
  requested?: boolean;
}

export interface ToolEntry {
  kind: "tool";
  callId: string;
  name: string;
  status: string;
  preview: string;
  /** Stable one-line summary of the call (command/path/intent). */
  title: string;
  /** True once the tool call's `end` phase lands. */
  done: boolean;
  /** Images embedded in this tool's result (downlink media, assembled from frames). */
  media?: MediaEntry[];
}

export type TranscriptEntry = MessageEntry | ToolEntry;

export interface Footer {
  model: string;
  thinkingLevel?: string;
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
  streaming: boolean;
  title: string;
  fastMode?: boolean;
}

export interface TranscriptState {
  /** Message blocks and tool cards, in first-seen order. */
  entries: TranscriptEntry[];
  /** Latest `state` footer, or undefined until the first `state` frame. */
  footer: Footer | undefined;
  /** The first non-empty session title observed, pinned so omp's later re-titles
   *  never change how the session is labelled. */
  title: string | undefined;
  /** Latest live async-job snapshot, or undefined until the first `jobs` frame. */
  jobs: { running: JobRow[]; recent: number } | undefined;
  /** True once the session emitted `bye`. */
  ended: boolean;
}

export function emptyTranscript(): TranscriptState {
  return {
    entries: [],
    footer: undefined,
    jobs: undefined,
    ended: false,
    title: undefined,
  };
}

function messageFor(
  state: TranscriptState,
  msgId: string,
  role: string,
  matchText?: string,
): MessageEntry {
  for (const e of state.entries)
    if (e.kind === "message" && e.msgId === msgId) return e;
  // Adopt a matching optimistic echo (an in-flight local send) so the agent's
  // own frame updates it in place instead of appearing a second time.
  if (matchText !== undefined)
    for (const e of state.entries)
      if (
        e.kind === "message" &&
        e.pending !== undefined &&
        e.role === role &&
        e.text === matchText
      ) {
        e.msgId = msgId;
        e.pending = undefined;
        return e;
      }
  const entry: MessageEntry = {
    kind: "message",
    msgId,
    role,
    text: "",
    streaming: true,
  };
  state.entries.push(entry);
  return entry;
}

function mediaEntryFor(
  state: TranscriptState,
  mediaId: string,
): MediaEntry | undefined {
  for (const e of state.entries)
    if (e.media) for (const m of e.media) if (m.mediaId === mediaId) return m;
  return undefined;
}

/** An image as its announcement starts it: a deferred one holds no chunk slots
 *  (its chunks are not coming), a live one a slot per announced chunk. */
function mediaFrom(frame: MediaInitFrame): MediaEntry {
  const bad = frame.size > MAX_RESOURCE_BYTES;
  const deferred = frame.deferred === true;
  return {
    mediaId: frame.mediaId,
    name: frame.name,
    mimeType: frame.mimeType,
    size: frame.size,
    totalChunks: frame.totalChunks,
    chunks:
      bad || deferred
        ? []
        : new Array<Uint8Array | undefined>(frame.totalChunks).fill(undefined),
    received: 0,
    status: bad ? "error" : deferred ? "deferred" : "loading",
  };
}

/**
 * Claim a fetch for a deferred image: true, marking it asked for, when
 * `mediaId` is deferred, not yet asked for, and no other image in this
 * session is on its way (asked for, or loading). One transfer at a time keeps
 * a fetch burst from overrunning the relay's per-phone buffer, which would
 * close the socket (1013) and restart every cut image. A redraw after the
 * current image lands asks for the next one. A fetch lost with its socket is
 * asked again after the next open (see `restartMediaTransfers`).
 */
export function claimMediaFetch(
  state: TranscriptState,
  mediaId: string,
): boolean {
  let target: MediaEntry | undefined;
  for (const e of state.entries)
    for (const m of e.media ?? []) {
      if (m.mediaId === mediaId) target = m;
      else if (
        m.status === "loading" ||
        (m.status === "deferred" && m.requested)
      )
        return false;
    }
  if (target?.status !== "deferred" || target.requested) return false;
  target.requested = true;
  return true;
}

/**
 * A fresh relay link lost whatever was in flight on the old one: every image
 * still loading, or asked for and unanswered, goes back to deferred and
 * un-asked. The resync's backfill re-announces the ones the host still holds;
 * the rest are fetched in turn and end `expired`, so no lost transfer holds the
 * one-at-a-time fetch gate shut.
 */
export function restartMediaTransfers(state: TranscriptState): void {
  for (const e of state.entries)
    for (const m of e.media ?? [])
      if (m.status === "loading" || m.status === "deferred") {
        m.status = "deferred";
        m.chunks = [];
        m.received = 0;
        m.requested = false;
      }
}

function toolFor(
  state: TranscriptState,
  callId: string,
  name: string,
): ToolEntry {
  for (const e of state.entries)
    if (e.kind === "tool" && e.callId === callId) return e;
  const entry: ToolEntry = {
    kind: "tool",
    callId,
    name,
    status: "",
    preview: "",
    title: "",
    done: false,
  };
  state.entries.push(entry);
  return entry;
}
/**
 * Fold one frame into `state`, mutating and returning it (O(1) for live use in
 * the store). Deterministic given frame order — `buildTranscript` is the pure
 * fold over a whole ordered list.
 */
export function reduceTranscript(
  state: TranscriptState,
  frame: UplinkFrame,
): TranscriptState {
  switch (frame.t) {
    case "msg": {
      const entry = messageFor(state, frame.msgId, frame.role, frame.text);
      entry.text = frame.text;
      entry.role = frame.role;
      if (frame.kind !== undefined) entry.noticeKind = frame.kind;
      entry.streaming = frame.phase !== "end";
      if (entry.at === undefined && frame.at !== undefined) entry.at = frame.at;
      break;
    }
    case "tool": {
      const entry = toolFor(state, frame.callId, frame.name);
      entry.name = frame.name;
      entry.status = frame.status;
      entry.preview = frame.preview;
      if (frame.title) entry.title = frame.title;
      entry.done = frame.phase === "end";
      break;
    }
    case "state": {
      state.footer = {
        model: frame.model,
        thinkingLevel: frame.thinkingLevel,
        contextPct: frame.contextPct,
        contextTokens: frame.contextTokens,
        contextWindow: frame.contextWindow,
        streaming: frame.streaming,
        title: frame.title,
        fastMode: frame.fastMode,
      };
      if (state.title === undefined && frame.title.length > 0)
        state.title = frame.title;
      break;
    }
    case "jobs": {
      state.jobs = { running: frame.running, recent: frame.recent };
      break;
    }
    case "controlError": {
      const entry = messageFor(
        state,
        `control-error:${frame.action}`,
        "system",
      );
      entry.text = frame.message;
      entry.streaming = false;
      break;
    }
    case "bye": {
      state.ended = true;
      for (const e of state.entries)
        if (e.kind === "message") e.streaming = false;
      if (state.footer) state.footer = { ...state.footer, streaming: false };
      break;
    }
    case "mediaInit": {
      const owner =
        frame.anchor.kind === "tool"
          ? toolFor(state, frame.anchor.callId, "")
          : messageFor(state, frame.anchor.msgId, "assistant");
      if (!owner.media) owner.media = [];
      const media = owner.media;
      const at = media.findIndex((m) => m.mediaId === frame.mediaId);
      const known = media[at];
      if (known === undefined) {
        media.push(mediaFrom(frame));
        break;
      }
      // Announced again, an image starts over only when this phone lacks its
      // bytes. A deferred announcement comes with a backfill, after a resync
      // that may have cut a transfer short: it restarts an image still loading,
      // never a finished one, and leaves a deferred one as it is, so a fetch
      // sent just before the backfill landed is not asked twice (a lost fetch
      // is re-armed on the next socket open instead). A full one (a fetch
      // answer) starts an image deferred or expired here. Any other repeat
      // changes nothing.
      const restart = frame.deferred
        ? known.status === "loading"
        : known.status === "deferred" || known.status === "expired";
      if (restart) media[at] = mediaFrom(frame);
      break;
    }
    case "mediaChunk": {
      const m = mediaEntryFor(state, frame.mediaId);
      if (!m || m.status !== "loading") break;
      if (frame.index < 0 || frame.index >= m.chunks.length) {
        m.status = "error";
        break;
      }
      // Every phone hears every fetch answer, so a slot can arrive twice when
      // answers overlap a live transfer; the bytes are the same image's.
      if (m.chunks[frame.index] !== undefined) break;
      m.chunks[frame.index] = fromBase64(frame.data);
      m.received += 1;
      if (m.received !== m.totalChunks) break;
      let len = 0;
      const parts: Uint8Array[] = [];
      for (const c of m.chunks) {
        if (!c) {
          m.status = "error";
          break;
        }
        parts.push(c);
        len += c.length;
      }
      if (m.status === "error") break;
      if (len !== m.size) {
        m.status = "error";
        break;
      }
      const full = new Uint8Array(len);
      let off = 0;
      for (const c of parts) {
        full.set(c, off);
        off += c.length;
      }
      m.dataUrl = `data:${m.mimeType};base64,${toBase64(full)}`;
      m.chunks = [];
      m.status = "ready";
      break;
    }
    case "mediaError": {
      const m = mediaEntryFor(state, frame.mediaId);
      // A finished image stays whatever the host says later; `expired` answers
      // a fetch, so it concerns only an image still waiting on one.
      if (!m || m.status === "ready") break;
      if (frame.code !== "expired") m.status = "error";
      else if (m.status === "deferred") m.status = "expired";
      break;
    }
    // "hello" is session-meta/token bookkeeping — not part of the transcript.
  }
  return state;
}

/** Pure fold: build a transcript from an ordered frame list. */
export function buildTranscript(
  frames: readonly UplinkFrame[],
): TranscriptState {
  const state = emptyTranscript();
  for (const frame of frames) reduceTranscript(state, frame);
  return state;
}
