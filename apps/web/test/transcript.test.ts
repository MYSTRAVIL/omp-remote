import { expect, test } from "bun:test";
import type { UplinkFrame } from "@omp-remote/protocol";
import { fromBase64, toBase64 } from "../src/core/base64";
import {
  type MediaEntry,
  type MessageEntry,
  type ToolEntry,
  type TranscriptState,
  buildTranscript,
  claimMediaFetch,
  emptyTranscript,
  reduceTranscript,
  restartMediaTransfers,
} from "../src/core/transcript";
import { s1Frames } from "./fixtures/transcript-frames";

const msg = (
  phase: "start" | "update" | "end",
  msgId: string,
  role: string,
  text: string,
): UplinkFrame => ({ t: "msg", sessionId: "s1", phase, msgId, role, text });

const tool = (
  phase: "start" | "update" | "end",
  callId: string,
  status: string,
  preview: string,
): UplinkFrame => ({
  t: "tool",
  sessionId: "s1",
  phase,
  callId,
  name: "read",
  status,
  preview,
});

test("msg text is a full snapshot: updates replace, they never concatenate", () => {
  const t = buildTranscript([
    msg("start", "a1", "assistant", ""),
    msg("update", "a1", "assistant", "Hel"),
    msg("update", "a1", "assistant", "Hello"),
    msg("end", "a1", "assistant", "Hello world"),
  ]);
  expect(t.entries).toHaveLength(1);
  const e = t.entries[0] as MessageEntry;
  expect(e.text).toBe("Hello world");
  expect(e.streaming).toBe(false);
});

test("streaming stays true through updates and flips false only on end", () => {
  let s = reduceTranscript(
    emptyTranscript(),
    msg("start", "a1", "assistant", ""),
  );
  expect((s.entries[0] as MessageEntry).streaming).toBe(true);
  s = reduceTranscript(s, msg("update", "a1", "assistant", "Hi"));
  expect((s.entries[0] as MessageEntry).streaming).toBe(true);
  s = reduceTranscript(s, msg("end", "a1", "assistant", "Hi"));
  expect((s.entries[0] as MessageEntry).streaming).toBe(false);
});

test("thinking and assistant blocks are distinct entries, role preserved, first-seen order", () => {
  const t = buildTranscript([
    msg("start", "th1", "thinking", "reasoning"),
    msg("start", "a1", "assistant", "answer"),
  ]);
  expect(t.entries.map((e) => (e as MessageEntry).role)).toEqual([
    "thinking",
    "assistant",
  ]);
});

test("tool-card lifecycle: start creates, update mutates, end finalizes, one card per callId", () => {
  const t = buildTranscript([
    tool("start", "c1", "running", "file.ts"),
    tool("update", "c1", "running", "file.ts:1-40"),
    tool("end", "c1", "ok", "40 lines"),
  ]);
  const cards = t.entries.filter((e): e is ToolEntry => e.kind === "tool");
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    callId: "c1",
    name: "read",
    status: "ok",
    preview: "40 lines",
    done: true,
  });
});

test("entries keep first-seen order across interleaved messages and tools", () => {
  const t = buildTranscript([
    msg("start", "a1", "assistant", "one"),
    tool("start", "c1", "running", "x"),
    msg("start", "a2", "assistant", "two"),
    // a late update to a1 must NOT reorder it to the end
    msg("update", "a1", "assistant", "one!"),
  ]);
  expect(
    t.entries.map((e) => (e.kind === "message" ? e.msgId : e.callId)),
  ).toEqual(["a1", "c1", "a2"]);
});

test("footer reflects the latest state frame", () => {
  const t = buildTranscript([
    {
      t: "state",
      sessionId: "s1",
      model: "m1",
      contextPct: 5,
      streaming: true,
      title: "A",
    },
    {
      t: "state",
      sessionId: "s1",
      model: "m2",
      contextPct: 42,
      streaming: false,
      title: "B",
    },
  ]);
  expect(t.footer).toEqual({
    model: "m2",
    contextPct: 42,
    streaming: false,
    title: "B",
  });
  expect(t.title).toBe("A");
});

test("state.fastMode folds into the footer", () => {
  const state = reduceTranscript(emptyTranscript(), {
    t: "state",
    sessionId: "s",
    model: "m",
    streaming: false,
    title: "t",
    fastMode: true,
  });
  expect(state.footer?.fastMode).toBe(true);
});

test("jobs frame folds into transcript job list", () => {
  const state = reduceTranscript(emptyTranscript(), {
    t: "jobs",
    sessionId: "s",
    recent: 1,
    running: [
      {
        id: "j1",
        type: "task",
        label: "scout",
        status: "running",
        startMs: 1,
      },
    ],
  });
  expect(state.jobs?.running).toHaveLength(1);
  expect(state.jobs?.running[0]?.label).toBe("scout");
});

test("an optimistic echo is adopted in place by the agent's matching message", () => {
  const state = emptyTranscript();
  state.entries.push({
    kind: "message",
    msgId: "pending-1",
    role: "user",
    text: "steer left",
    streaming: false,
    pending: "steer",
  });
  reduceTranscript(state, msg("end", "u9", "user", "steer left"));
  expect(state.entries).toHaveLength(1);
  const entry = state.entries[0] as MessageEntry;
  expect(entry.msgId).toBe("u9");
  expect(entry.pending).toBeUndefined();
  expect(entry.streaming).toBe(false);
});

test("a non-matching message keeps the optimistic echo separate", () => {
  const state = emptyTranscript();
  state.entries.push({
    kind: "message",
    msgId: "pending-1",
    role: "user",
    text: "steer left",
    streaming: false,
    pending: "steer",
  });
  reduceTranscript(state, msg("end", "u9", "user", "different text"));
  expect(state.entries).toHaveLength(2);
});

test("bye ends the transcript and clears streaming on message and footer", () => {
  const t = buildTranscript([
    {
      t: "state",
      sessionId: "s1",
      model: "m",
      contextPct: 1,
      streaming: true,
      title: "T",
    },
    msg("start", "a1", "assistant", "partial"),
    { t: "bye", sessionId: "s1" },
  ]);
  expect(t.ended).toBe(true);
  expect((t.entries[0] as MessageEntry).streaming).toBe(false);
  expect(t.footer?.streaming).toBe(false);
});

test("an update with no prior start still creates the entry (drop-oldest robustness)", () => {
  const t = buildTranscript([msg("update", "a1", "assistant", "recovered")]);
  expect(t.entries).toHaveLength(1);
  expect((t.entries[0] as MessageEntry).text).toBe("recovered");
});

test("a hello frame is ignored (no transcript entry)", () => {
  const t = buildTranscript([
    {
      t: "hello",
      token: "tok",
      session: {
        id: "s1",
        cwd: "/x",
        project: "x",
        model: "m",
        title: "T",
        pid: 1,
        startedAt: 0,
      },
    },
  ]);
  expect(t.entries).toHaveLength(0);
  expect(t.footer).toBeUndefined();
});

test("a prompt-control error becomes an actionable finished system message", () => {
  const t = buildTranscript([
    {
      t: "controlError",
      sessionId: "s1",
      action: "prompt",
      code: "prompt-control-unavailable",
      message:
        "Queue and Steer are unavailable. Restart OMP to load the updated bridge.",
    },
  ]);
  expect(t.entries).toEqual([
    {
      kind: "message",
      msgId: "control-error:prompt",
      role: "system",
      text: "Queue and Steer are unavailable. Restart OMP to load the updated bridge.",
      streaming: false,
    },
  ]);
});

test("buildTranscript equals a manual fold over the recorded fixture", () => {
  const folded = s1Frames.reduce(reduceTranscript, emptyTranscript());
  expect(buildTranscript(s1Frames)).toEqual(folded);
  const t = buildTranscript(s1Frames);
  expect(
    t.entries.map((e) => (e.kind === "message" ? e.msgId : e.callId)),
  ).toEqual(["u1", "th1", "a1", "c1"]);
  expect((t.entries[2] as MessageEntry).text).toBe("Hello world");
  expect(t.footer).toEqual({
    model: "opus",
    contextPct: 12,
    streaming: false,
    title: "T",
  });
});

test("assembles a single-chunk image into a data URL", () => {
  const raw = new Uint8Array([1, 2, 3, 4]);
  let s = emptyTranscript();
  s = reduceTranscript(s, {
    t: "msg",
    sessionId: "x",
    phase: "end",
    msgId: "m",
    role: "assistant",
    text: "here",
  });
  s = reduceTranscript(s, {
    t: "mediaInit",
    sessionId: "x",
    mediaId: "m:0",
    anchor: { kind: "message", msgId: "m" },
    mimeType: "image/png",
    size: 4,
    totalChunks: 1,
  });
  s = reduceTranscript(s, {
    t: "mediaChunk",
    sessionId: "x",
    mediaId: "m:0",
    index: 0,
    data: toBase64(raw),
  });
  const msg = s.entries.find((e) => e.kind === "message");
  const m = msg?.kind === "message" ? msg.media?.[0] : undefined;
  expect(m?.status).toBe("ready");
  expect(m?.dataUrl).toBe(`data:image/png;base64,${toBase64(raw)}`);
});

test("mediaChunk before its msg still lands under the message", () => {
  let s = emptyTranscript();
  s = reduceTranscript(s, {
    t: "mediaInit",
    sessionId: "x",
    mediaId: "m:0",
    anchor: { kind: "message", msgId: "m" },
    mimeType: "image/png",
    size: 2,
    totalChunks: 1,
  });
  s = reduceTranscript(s, {
    t: "mediaChunk",
    sessionId: "x",
    mediaId: "m:0",
    index: 0,
    data: toBase64(new Uint8Array([9, 9])),
  });
  s = reduceTranscript(s, {
    t: "msg",
    sessionId: "x",
    phase: "end",
    msgId: "m",
    role: "user",
    text: "look",
  });
  const msg = s.entries.find((e) => e.kind === "message" && e.msgId === "m");
  expect(msg?.kind === "message" && msg.role).toBe("user");
  expect(msg?.kind === "message" && msg.media?.[0]?.status).toBe("ready");
});

test("size mismatch and mediaError mark the entry failed", () => {
  let s = emptyTranscript();
  s = reduceTranscript(s, {
    t: "mediaInit",
    sessionId: "x",
    mediaId: "a",
    anchor: { kind: "message", msgId: "m" },
    mimeType: "image/png",
    size: 99,
    totalChunks: 1,
  });
  s = reduceTranscript(s, {
    t: "mediaChunk",
    sessionId: "x",
    mediaId: "a",
    index: 0,
    data: toBase64(new Uint8Array([1])),
  });
  s = reduceTranscript(s, {
    t: "mediaInit",
    sessionId: "x",
    mediaId: "b",
    anchor: { kind: "message", msgId: "m" },
    mimeType: "image/png",
    size: 1,
    totalChunks: 1,
  });
  s = reduceTranscript(s, {
    t: "mediaError",
    sessionId: "x",
    mediaId: "b",
    code: "internal",
  });
  const msg = s.entries.find((e) => e.kind === "message");
  const media = msg?.kind === "message" ? (msg.media ?? []) : [];
  expect(media.find((m) => m.mediaId === "a")?.status).toBe("error");
  expect(media.find((m) => m.mediaId === "b")?.status).toBe("error");
});

test("tool-anchored media attaches to its tool card as a data URL", () => {
  const raw = new Uint8Array([5, 6, 7]);
  let s = emptyTranscript();
  s = reduceTranscript(s, {
    t: "tool",
    sessionId: "x",
    phase: "end",
    callId: "c1",
    name: "read",
    status: "done",
    preview: "image",
  });
  s = reduceTranscript(s, {
    t: "mediaInit",
    sessionId: "x",
    mediaId: "c1:0",
    anchor: { kind: "tool", callId: "c1" },
    mimeType: "image/webp",
    size: 3,
    totalChunks: 1,
  });
  s = reduceTranscript(s, {
    t: "mediaChunk",
    sessionId: "x",
    mediaId: "c1:0",
    index: 0,
    data: toBase64(raw),
  });
  const tool = s.entries.find((e) => e.kind === "tool");
  const m = tool?.kind === "tool" ? tool.media?.[0] : undefined;
  expect(m?.status).toBe("ready");
  expect(m?.dataUrl).toBe(`data:image/webp;base64,${toBase64(raw)}`);
});

/** Image `mediaId` announced under message "m"; `deferred` marks a backfill
 *  announcement, whose chunks are not coming. */
function announce(
  mediaId: string,
  size: number,
  totalChunks: number,
  deferred?: true,
): UplinkFrame {
  return {
    t: "mediaInit",
    sessionId: "x",
    mediaId,
    anchor: { kind: "message", msgId: "m" },
    mimeType: "image/png",
    size,
    totalChunks,
    deferred,
  };
}

function chunk(mediaId: string, index: number, bytes: number[]): UplinkFrame {
  const data = toBase64(new Uint8Array(bytes));
  return { t: "mediaChunk", sessionId: "x", mediaId, index, data };
}

function expired(mediaId: string): UplinkFrame {
  return { t: "mediaError", sessionId: "x", mediaId, code: "expired" };
}

/** Image `mediaId` as the transcript holds it now. */
function image(s: TranscriptState, mediaId: string): MediaEntry | undefined {
  for (const e of s.entries)
    for (const m of e.media ?? []) if (m.mediaId === mediaId) return m;
  return undefined;
}

test("a deferred announcement shows a placeholder and holds no chunk slots", () => {
  const s = buildTranscript([announce("a", 4, 2, true)]);
  expect(image(s, "a")).toMatchObject({
    status: "deferred",
    chunks: [],
    received: 0,
  });
});

test("the full announcement a fetch brings upgrades a deferred image, and its chunks complete it", () => {
  const s = buildTranscript([announce("a", 4, 2, true), announce("a", 4, 2)]);
  expect(image(s, "a")?.status).toBe("loading");
  expect(image(s, "a")?.chunks).toHaveLength(2);
  reduceTranscript(s, chunk("a", 0, [1, 2]));
  reduceTranscript(s, chunk("a", 1, [3, 4]));
  expect(image(s, "a")?.status).toBe("ready");
  expect(image(s, "a")?.dataUrl).toBe(
    `data:image/png;base64,${toBase64(new Uint8Array([1, 2, 3, 4]))}`,
  );
});

test("neither a deferred replay nor an expired answer takes a finished image away", () => {
  const s = buildTranscript([
    announce("a", 1, 1),
    chunk("a", 0, [7]),
    announce("a", 1, 1, true),
    expired("a"),
  ]);
  expect(image(s, "a")?.status).toBe("ready");
  expect(image(s, "a")?.dataUrl).toBe(
    `data:image/png;base64,${toBase64(new Uint8Array([7]))}`,
  );
});

test("an expired answer marks a deferred image unavailable until the host sends it again", () => {
  const s = buildTranscript([announce("a", 1, 1, true), expired("a")]);
  expect(image(s, "a")?.status).toBe("expired");
  reduceTranscript(s, announce("a", 1, 1));
  expect(image(s, "a")?.status).toBe("loading");
});

test("a deferred replay restarts a transfer the phone lost part of", () => {
  const s = buildTranscript([
    announce("a", 2, 2),
    chunk("a", 0, [1]),
    // The link dropped mid-transfer; the resync's backfill re-announces it.
    announce("a", 2, 2, true),
  ]);
  expect(image(s, "a")).toMatchObject({ status: "deferred", chunks: [] });
  // The fetch answer resends every chunk, the one already seen included.
  for (const frame of [
    announce("a", 2, 2),
    chunk("a", 0, [1]),
    chunk("a", 1, [2]),
  ])
    reduceTranscript(s, frame);
  expect(image(s, "a")?.status).toBe("ready");
});

test("a deferred image is asked for once per link, and again after a new socket opens", () => {
  const s = buildTranscript([announce("a", 2, 2, true)]);
  expect(claimMediaFetch(s, "a")).toBe(true);
  // Redrawn while the answer travels, or the resync's backfill lands after the
  // fetch went out: not asked twice.
  expect(claimMediaFetch(s, "a")).toBe(false);
  reduceTranscript(s, announce("a", 2, 2, true));
  expect(claimMediaFetch(s, "a")).toBe(false);
  // The socket dropped with the answer: the new socket re-arms the fetch.
  restartMediaTransfers(s);
  expect(claimMediaFetch(s, "a")).toBe(true);
  // The answer starts arriving: nothing is left to ask for.
  reduceTranscript(s, announce("a", 2, 2));
  expect(claimMediaFetch(s, "a")).toBe(false);
  // The link drops mid-answer; the resync's backfill re-announces the image.
  reduceTranscript(s, announce("a", 2, 2, true));
  expect(claimMediaFetch(s, "a")).toBe(true);
  expect(claimMediaFetch(s, "unknown")).toBe(false);
});

test("only one image per session is fetched at a time", () => {
  const s = buildTranscript([
    announce("a", 1, 1, true),
    announce("b", 1, 1, true),
  ]);
  expect(claimMediaFetch(s, "a")).toBe(true);
  // `a` is asked for and not answered yet: `b` waits.
  expect(claimMediaFetch(s, "b")).toBe(false);
  // `a`'s answer is arriving: `b` still waits.
  reduceTranscript(s, announce("a", 1, 1));
  expect(claimMediaFetch(s, "b")).toBe(false);
  // `a` landed: the next draw asks for `b`.
  reduceTranscript(s, chunk("a", 0, [9]));
  expect(claimMediaFetch(s, "b")).toBe(true);
});

test("a new link restarts cut transfers, so an image the host no longer re-announces cannot block the rest", () => {
  // Live `a` was cut after one chunk and the host has since evicted it; `b`
  // and `c` wait their turn behind it.
  const s = buildTranscript([
    announce("a", 2, 2),
    chunk("a", 0, [1]),
    announce("b", 1, 1, true),
    announce("c", 1, 1, true),
  ]);
  expect(claimMediaFetch(s, "b")).toBe(false); // `a` still loading
  restartMediaTransfers(s);
  // Only `c` is re-announced by the resync; `a` and `b` are asked for in turn.
  reduceTranscript(s, announce("c", 1, 1, true));
  expect(claimMediaFetch(s, "a")).toBe(true);
  reduceTranscript(s, expired("a"));
  expect(image(s, "a")?.status).toBe("expired");
  expect(claimMediaFetch(s, "b")).toBe(true);
});

test("a chunk heard twice, as fetch answers overlap a live transfer, leaves the image whole", () => {
  const s = buildTranscript([
    announce("a", 2, 2, true),
    // This phone's answer: the chunk the host held when asked...
    announce("a", 2, 2),
    chunk("a", 0, [1]),
    // ...then another phone's answer repeats it before the live rest lands.
    announce("a", 2, 2),
    chunk("a", 0, [1]),
    chunk("a", 1, [2]),
  ]);
  expect(image(s, "a")?.status).toBe("ready");
  expect(image(s, "a")?.dataUrl).toBe(
    `data:image/png;base64,${toBase64(new Uint8Array([1, 2]))}`,
  );
});
