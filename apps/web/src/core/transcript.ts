import type {
  JobRow,
  MediaInitFrame,
  MsgFrame,
  UplinkFrame,
} from "@omp-remote/protocol";
import { MAX_RESOURCE_BYTES, normalizePromptText } from "@omp-remote/protocol";
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
 *   `msgId` / `callId`; later frames for a known key mutate in place. Local
 *   echoes of sent prompts wait last, in send order, until the host's user
 *   message confirms one: it then moves to where the host has it, after all
 *   that is confirmed, where a replay puts it too. A reply that streams new
 *   text after a later confirmed user message moves below that message: omp
 *   took the message in first, so the text arriving now answers it (the
 *   host-agent reorders its retained frames the same way for a replay).
 */

export interface MessageEntry {
  kind: "message";
  msgId: string;
  role: string;
  text: string;
  /** True while the block is still streaming; false once its `end` phase lands. */
  streaming: boolean;
  /** Set while this is a local, unconfirmed echo of a just-sent prompt — the send
   *  mode — awaiting the host's user message to confirm it: a `steer` is not
   *  yet steered in, a `followUp` not yet started. */
  pending?: "steer" | "followUp";
  /** A local echo's `PromptFrame.clientId`, which the host names on the user
   *  message it becomes. */
  clientId?: string;
  /** True once a local echo is known not to have reached omp: the host refused
   *  it, the session ended first, or a resync showed the host never got it.
   *  The host's user message still confirms it if one comes after all. */
  failed?: boolean;
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
  /** The image's bytes as a self-contained URL: a `data:` URL assembled from
   *  its chunks, or an object URL of this phone's own copy of a photo it
   *  sent. */
  dataUrl?: string;
  /** Set once this phone asked the host for a deferred image's bytes; see
   *  {@link claimMediaFetch}. */
  requested?: boolean;
  /** A photo this phone sent, shown from its own copy since the send. The
   *  host's announcement of that image takes this entry over (its id, never
   *  a second copy to load); see {@link reduceTranscript}. */
  local?: true;
}

/** A photo this phone sent with a prompt, as the prompt's echo shows it. */
export interface SentImage {
  /** An object URL of the phone's own copy, the file it uploaded. */
  url: string;
  name: string;
  mimeType: string;
  size: number;
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

/** Where a new host entry goes: after all that is confirmed, before the local
 *  echoes still waiting to be taken in (they stay last, in send order). */
function hostIndex(state: TranscriptState): number {
  let at = state.entries.length;
  while (at > 0) {
    const e = state.entries[at - 1];
    if (e?.kind !== "message" || e.pending === undefined) break;
    at--;
  }
  return at;
}

/** Move `entry` to where a new host entry goes. */
function moveToHost(state: TranscriptState, entry: TranscriptEntry): void {
  state.entries.splice(state.entries.indexOf(entry), 1);
  state.entries.splice(hostIndex(state), 0, entry);
}

function messageFor(
  state: TranscriptState,
  msgId: string,
  role: string,
): MessageEntry {
  for (const e of state.entries)
    if (e.kind === "message" && e.msgId === msgId) return e;
  const entry: MessageEntry = {
    kind: "message",
    msgId,
    role,
    text: "",
    streaming: true,
  };
  state.entries.splice(hostIndex(state), 0, entry);
  return entry;
}

/**
 * The local echo a host user message confirms: the one its `clientId` names,
 * else (a host that names none, or lost track of the prompt) the oldest whose
 * text matches. A named prompt this phone does not hold waiting is another
 * device's, or confirmed already, and confirms nothing here.
 */
function localEcho(
  state: TranscriptState,
  frame: MsgFrame,
): MessageEntry | undefined {
  const text =
    frame.clientId === undefined ? normalizePromptText(frame.text) : undefined;
  for (const e of state.entries) {
    if (e.kind !== "message" || e.role !== "user") continue;
    if (e.pending === undefined && e.failed !== true) continue;
    if (
      frame.clientId === undefined
        ? normalizePromptText(e.text) === text
        : e.clientId === frame.clientId
    )
      return e;
  }
  return undefined;
}

/**
 * The entry a msg frame updates: the one with its id; else, for a user
 * message, the local echo it confirms, moved to where the host has it; else a
 * new entry. A known reply that streams new text after a later confirmed user
 * message moves below it; a re-sent frame (same text) or its `end` leaves it.
 */
function msgEntry(state: TranscriptState, frame: MsgFrame): MessageEntry {
  const at = state.entries.findIndex(
    (e) => e.kind === "message" && e.msgId === frame.msgId,
  );
  const known = state.entries[at];
  if (known?.kind === "message") {
    if (
      frame.phase !== "end" &&
      frame.role !== "user" &&
      frame.text !== known.text
    )
      for (let i = at + 1; i < state.entries.length; i++) {
        const e = state.entries[i];
        if (
          e?.kind === "message" &&
          e.role === "user" &&
          e.pending === undefined &&
          e.failed !== true
        ) {
          moveToHost(state, known);
          break;
        }
      }
    return known;
  }
  const echo = frame.role === "user" ? localEcho(state, frame) : undefined;
  if (echo === undefined) return messageFor(state, frame.msgId, frame.role);
  echo.msgId = frame.msgId;
  echo.pending = undefined;
  echo.failed = undefined;
  moveToHost(state, echo);
  return echo;
}

/** A local echo that will not be taken in: it stops waiting, and stays where
 *  the host's entries have reached. */
function failEcho(state: TranscriptState, entry: MessageEntry): void {
  entry.pending = undefined;
  entry.failed = true;
  moveToHost(state, entry);
}

/**
 * Mark the local echo of prompt `clientId` as not delivered; false when no
 * echo with that id still waits (it was confirmed, or failed already).
 */
export function failLocalEcho(
  state: TranscriptState,
  clientId: string,
): boolean {
  for (const e of state.entries)
    if (
      e.kind === "message" &&
      e.pending !== undefined &&
      e.clientId === clientId
    ) {
      failEcho(state, e);
      return true;
    }
  return false;
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
  state.entries.splice(hostIndex(state), 0, entry);
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
      const entry = msgEntry(state, frame);
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
      // A refused prompt's echo first, then the notice explaining it.
      if (frame.clientId !== undefined) failLocalEcho(state, frame.clientId);
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
      // What the session had not taken in when it ended, it never will.
      for (const e of [...state.entries])
        if (e.kind === "message" && e.pending !== undefined) failEcho(state, e);
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
        // The host's copy of a photo this phone sent (its images come in the
        // order they were attached): the phone's own copy, shown since the
        // send, takes the host's id, so the bubble keeps one image and no
        // second copy is loaded. Its chunks, and an error, then find it ready.
        const own = media.find((m) => m.local);
        if (own === undefined) media.push(mediaFrom(frame));
        else {
          own.mediaId = frame.mediaId;
          own.local = undefined;
        }
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
