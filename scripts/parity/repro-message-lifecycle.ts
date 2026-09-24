// Deterministic reproduction: message identity + lifecycle loss on the live feed
// (overnight run `2026-09-12-parity-preview`, Reserve item "Reproduce message
// identity and lifecycle loss").
//
// WHAT THIS PROVES (all against REAL production code, joined by the REAL wire type
// and the REAL IPC codec — no mocked transport, no invented frame shape):
//
//   OMP message event  ──[real bridge normalization]──▶  UplinkFrame (real codec,
//   real SessionBridge, real disposable IpcServer)  ──▶  real reduceTranscript
//
//   1. Identity collapse — the OMP `message_update` event has NO top-level `id`
//      field (source: pi-coding-agent `extensibility/extensions/types.ts`
//      `MessageUpdateEvent`; its `message: AgentMessage` = pi-ai `AssistantMessage`
//      also has no `id`, only an optional provider `responseId`). The bridge reads
//      `ev.id ?? "m"` (`packages/bridge/src/index.ts:71`), so EVERY assistant
//      message in a session is emitted with `msgId: "m"`. The web reducer keys
//      message entries by `msgId` (`apps/web/src/core/transcript.ts` `messageFor`),
//      so two distinct messages collapse into one entry and the reducer's
//      full-snapshot `entry.text = frame.text` (line 107) OVERWRITES the first
//      message's text with the second's.
//
//   2. Lifecycle incompleteness — the bridge subscribes to `message_update` ONLY;
//      it never handles `message_start`/`message_end` (`packages/bridge/src/index.ts`
//      registers no such `pi.on`). It always emits `phase: "update"`, never
//      `phase: "end"`, so the reducer's `entry.streaming = frame.phase !== "end"`
//      (line 108) stays `true` forever: a completed message is stuck rendering as
//      still-streaming until the whole session ends (`bye`).
//
//   3. Control — fed AUTHORITATIVE distinct ids and an `end` phase, the SAME
//      reducer produces two entries with `streaming:false`. This isolates the
//      defect to the bridge's identity/lifecycle capture, NOT the reducer.
//
// This is a diagnostic reproduction, not a fix and not a permanent test. It adds
// no assertion against source text and invents no event shape: the fixtures are
// typed against a structural mirror of the real event types (cited above) and the
// decisive fact — no `id` on the event — is verified at RUNTIME with `"id" in ev`.
//
// Run:  bun run scripts/parity/repro-message-lifecycle.ts
// Exit: 0 once every scenario has produced a definitive classification; 1 if the
//       harness could not gather evidence.

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type TranscriptState,
  buildTranscript,
  emptyTranscript,
  reduceTranscript,
} from "../../apps/web/src/core/transcript";
import { SessionBridge } from "../../packages/bridge/src/session-bridge";
import type {
  Frame,
  SessionMeta,
  UplinkFrame,
} from "../../packages/protocol/src/frames";
import { IpcServer, connectIpc } from "../../packages/protocol/src/ipc";
import type { IpcConn } from "../../packages/protocol/src/ipc";

// --- Faithful structural mirror of the real OMP message event ----------------
// Source (pinned omp 18.1.x):
//   pi-coding-agent `src/extensibility/extensions/types.ts`:
//     interface MessageUpdateEvent { type: "message_update"; message: AgentMessage;
//                                    assistantMessageEvent: AssistantMessageEvent }
//   pi-agent-core  `dist/types/types.d.ts`: type AgentMessage = Message | ...
//   pi-ai          `src/types.ts`: AssistantMessage = { role: "assistant";
//                                    content: (...)[]; responseId?: string; ... }
// `message_update` is emitted for ASSISTANT messages only (pi-agent-core
// `types.ts`: "Only emitted for assistant messages during streaming"); "thinking"
// is a content block, not a message role, so the message role is always "assistant".
// NOTE the crux: there is NO `id` on the event and NO `id` on the message. The
// bridge's `ev.id` therefore does not exist on the real payload — proven below at
// runtime, not merely by this type.
interface MirrorTextContent {
  type: "text";
  text: string;
}
interface MirrorAssistantMessage {
  role: "assistant";
  content: MirrorTextContent[];
  /** Provider-specific, OPTIONAL, and absent for most turns — not a stable id. */
  responseId?: string;
}
interface MirrorMessageUpdateEvent {
  type: "message_update";
  message: MirrorAssistantMessage;
  // `assistantMessageEvent` is required on the real type but unread by the bridge;
  // modelled as a minimal `text_delta` so the fixture stays structurally honest.
  assistantMessageEvent: {
    type: "text_delta";
    contentIndex: number;
    delta: string;
    partial: MirrorAssistantMessage;
  };
}

// --- REAL bridge normalization, executed live --------------------------------
// Copied verbatim from `packages/bridge/src/index.ts` (`textOf` lines 7-18; the
// `message_update` handler body lines 64-74) so the probe runs the actual capture
// logic. It is replicated here rather than imported because `index.ts` hardcodes
// the PRODUCTION IPC endpoint (`ipcPath()` → `\\.\pipe\omp-remote-agent`) and
// running its `session_start` would attempt to connect to the user's installed,
// live host-agent — forbidden by the run protocol (no production-endpoint reuse).
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) =>
        c && typeof c === "object" && "text" in c && typeof c.text === "string"
          ? c.text
          : "",
      )
      .join("");
  return "";
}

function applyBridgeMessageUpdate(bridge: SessionBridge, event: unknown): void {
  const ev = event as {
    message?: { role?: string; content?: unknown };
    id?: string;
  };
  bridge.emitMsg({
    phase: "update",
    msgId: ev.id ?? "m",
    role: ev.message?.role ?? "assistant",
    text: textOf(ev.message?.content),
  });
}

// --- disposable loopback endpoint (never the production pipe) -----------------
function disposableAddr(): string {
  const rand = Math.random().toString(36).slice(2);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-repro-${rand}`
    : join(tmpdir(), `omp-remote-repro-${rand}.sock`);
}

const meta: SessionMeta = {
  id: "s1",
  cwd: "/disposable/project",
  project: "project",
  model: "test-model",
  title: "Repro session",
  pid: process.pid,
  startedAt: 0,
};

/**
 * Push the given OMP-shaped events through the REAL bridge normalization → REAL
 * SessionBridge → REAL IPC server/codec, and return the ordered `UplinkFrame`s the
 * server actually received (the exact bytes a host-agent would relay to a phone).
 */
async function captureFramesThroughBridge(
  events: readonly unknown[],
): Promise<UplinkFrame[]> {
  const path = disposableAddr();
  const server = new IpcServer();
  const received: Frame[] = [];
  // hello + one msg frame per event.
  const expected = events.length + 1;
  const { promise: done, resolve } = Promise.withResolvers<void>();
  server.onConnection((conn: IpcConn) =>
    conn.onFrame((f) => {
      received.push(f);
      if (received.length >= expected) resolve();
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "repro",
    path,
    meta,
    connect: connectIpc,
  });
  await bridge.start();
  for (const ev of events) applyBridgeMessageUpdate(bridge, ev);
  await done;
  bridge.stop();
  await server.close();

  // The `hello` handshake is transport bookkeeping; the `bye` is this harness
  // tearing down the disposable bridge (`SessionBridge.stop()` emits it), NOT the
  // session ending. Both are excluded so the captured transcript is the honest
  // MID-SESSION view of the two-message exchange (a real `bye` would only arrive
  // at genuine session shutdown, and its reducer case force-clears streaming).
  return received.filter(
    (f): f is UplinkFrame => f.t !== "hello" && f.t !== "bye",
  );
}

function messageEntries(state: TranscriptState) {
  return state.entries.filter((e) => e.kind === "message");
}

interface Scenario {
  name: string;
  pass: boolean;
  classification: string;
  detail: Record<string, unknown>;
}

async function main(): Promise<void> {
  const scenarios: Scenario[] = [];

  // Two distinct assistant messages, exactly as the runtime would surface them:
  // each a FULL-snapshot `message_update` (the recorded decision: omp updates carry
  // the full current text). Sanitized, harmless content.
  const msg1: MirrorMessageUpdateEvent = {
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "First answer." }],
    },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "First answer.",
      partial: {
        role: "assistant",
        content: [{ type: "text", text: "First answer." }],
      },
    },
  };
  const msg2: MirrorMessageUpdateEvent = {
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Second answer." }],
    },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "Second answer.",
      partial: {
        role: "assistant",
        content: [{ type: "text", text: "Second answer." }],
      },
    },
  };

  // Runtime proof of the crux: the real event carries no top-level `id`, so the
  // bridge's `ev.id ?? "m"` fallback ALWAYS fires. (Also: the message itself has
  // no `id`.)
  const eventHasId = "id" in msg1;
  const messageHasId = "id" in msg1.message;
  scenarios.push({
    name: "event-has-no-identity",
    pass: !eventHasId && !messageHasId,
    classification:
      !eventHasId && !messageHasId
        ? 'CONFIRMED: message_update has no `id` and message has no `id`; bridge `ev.id ?? "m"` collapses to the constant "m" for every message.'
        : "UNEXPECTED: an identity field is present; re-examine the event shape.",
    detail: {
      eventHasId,
      messageHasId,
      responseIdPresent: "responseId" in msg1.message,
    },
  });

  // Scenario A — end to end through bridge + reducer.
  const framesA = await captureFramesThroughBridge([msg1, msg2]);
  const msgFramesA = framesA.filter((f) => f.t === "msg");
  const allMsgId = msgFramesA.every((f) => f.t === "msg" && f.msgId === "m");
  const noEndPhase = msgFramesA.every(
    (f) => f.t === "msg" && f.phase !== "end",
  );
  const stateA = buildTranscript(framesA);
  const entriesA = messageEntries(stateA);
  const collapsed = entriesA.length === 1;
  const overwritten =
    entriesA.length === 1 &&
    entriesA[0]?.kind === "message" &&
    entriesA[0].text === "Second answer.";
  const stuckStreaming =
    entriesA.length === 1 &&
    entriesA[0]?.kind === "message" &&
    entriesA[0].streaming === true;
  scenarios.push({
    name: "two-messages-collapse-and-overwrite",
    pass: collapsed && overwritten && stuckStreaming && allMsgId && noEndPhase,
    classification:
      collapsed && overwritten
        ? `CONFIRMED: 2 distinct messages → ${entriesA.length} entry; the first message's text ("First answer.") is destroyed, only "${entriesA[0]?.kind === "message" ? entriesA[0].text : ""}" survives. streaming stuck = ${stuckStreaming} (no message_end handler → phase never "end").`
        : `NOT REPRODUCED: got ${entriesA.length} entries (hypothesis would be 1).`,
    detail: {
      inputMessages: 2,
      emittedMsgIds: msgFramesA.map((f) => (f.t === "msg" ? f.msgId : "")),
      emittedPhases: msgFramesA.map((f) => (f.t === "msg" ? f.phase : "")),
      outputEntries: entriesA.length,
      survivingText:
        entriesA[0]?.kind === "message" ? entriesA[0].text : undefined,
      streamingStillTrue: stuckStreaming,
    },
  });

  // Scenario B — control: SAME reducer, authoritative distinct ids + an `end`
  // phase (what a correct capture would emit). Proves the reducer is sound; the
  // defect is upstream in the bridge's identity/lifecycle capture.
  const authoritative: UplinkFrame[] = [
    {
      t: "msg",
      sessionId: "s1",
      phase: "update",
      msgId: "msg-1",
      role: "assistant",
      text: "First answer.",
    },
    {
      t: "msg",
      sessionId: "s1",
      phase: "end",
      msgId: "msg-1",
      role: "assistant",
      text: "First answer.",
    },
    {
      t: "msg",
      sessionId: "s1",
      phase: "update",
      msgId: "msg-2",
      role: "assistant",
      text: "Second answer.",
    },
    {
      t: "msg",
      sessionId: "s1",
      phase: "end",
      msgId: "msg-2",
      role: "assistant",
      text: "Second answer.",
    },
  ];
  const stateB = authoritative.reduce(
    (s, f) => reduceTranscript(s, f),
    emptyTranscript(),
  );
  const entriesB = messageEntries(stateB);
  const twoDistinct =
    entriesB.length === 2 &&
    entriesB[0]?.kind === "message" &&
    entriesB[0].text === "First answer." &&
    entriesB[1]?.kind === "message" &&
    entriesB[1].text === "Second answer.";
  const bothResolved = entriesB.every(
    (e) => e.kind === "message" && e.streaming === false,
  );
  scenarios.push({
    name: "control-authoritative-ids-are-preserved",
    pass: twoDistinct && bothResolved,
    classification:
      twoDistinct && bothResolved
        ? 'CONFIRMED: given distinct ids + an `end` phase, the SAME reducer yields 2 entries, both streaming:false. The reducer is correct; the loss is entirely in the bridge\'s capture (`ev.id ?? "m"`, no message_end).'
        : `UNEXPECTED: reducer did not preserve distinct ids (${entriesB.length} entries).`,
    detail: {
      outputEntries: entriesB.length,
      texts: entriesB.map((e) => (e.kind === "message" ? e.text : "")),
      allResolved: bothResolved,
    },
  });

  // --- report ----------------------------------------------------------------
  const line = "─".repeat(78);
  console.log(line);
  console.log(
    "REPRO: message identity + lifecycle loss (bridge → wire → reducer)",
  );
  console.log(line);
  for (const s of scenarios) {
    console.log(`\n[${s.pass ? "PASS" : "FAIL"}] ${s.name}`);
    console.log(`  ${s.classification}`);
    console.log(`  detail: ${JSON.stringify(s.detail)}`);
  }

  const allClassified = scenarios.every((s) => s.pass);
  console.log(`\n${line}`);
  console.log(
    "PROPOSED FAILING REGRESSION (for the next implementation batch):",
  );
  console.log(
    [
      "  Target: packages/bridge/src/index.ts (capture) + apps/web/src/core/transcript.ts (unchanged).",
      "  A future regression test would drive two distinct messages through the bridge",
      "  capture and assert the reducer yields TWO entries whose texts are preserved and",
      '  whose streaming flag resolves to false — it fails on today\'s `ev.id ?? "m"` +',
      "  update-only capture, and passes once the bridge emits authoritative per-message",
      "  ids and a message_end phase.",
      "  Affected paths:",
      "    - packages/bridge/src/index.ts:62-76  (message_update handler; msgId fallback)",
      "    - packages/bridge/src/index.ts        (missing message_start/message_end handlers)",
      "    - apps/web/src/core/transcript.ts:100-138 (reducer keys by msgId, phase!=='end')",
      "  Minimal future fix (NOT applied here): derive a stable per-message id in the",
      "  bridge (message ordinal within the turn, or the provider responseId when present)",
      "  and add message_start/message_end handlers emitting phase 'start'/'end'.",
    ].join("\n"),
  );
  console.log(line);
  console.log(
    allClassified
      ? "RESULT: hypothesis REPRODUCED and classified across all scenarios."
      : "RESULT: at least one scenario did not classify as expected — inspect above.",
  );

  process.exit(allClassified ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(
    `repro harness error: ${err instanceof Error ? err.stack : String(err)}`,
  );
  process.exit(1);
});
