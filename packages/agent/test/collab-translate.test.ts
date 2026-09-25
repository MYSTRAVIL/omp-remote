import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DownlinkFrame, UplinkFrame } from "@omp-remote/protocol";
// A real host-frame trace captured live (scripts/parity/collab-capture-trace.ts):
// a prompt that triggers a bash tool call and a "done" reply. Cast once here — a
// JSON module is untyped; every frame is Zod-parsed before use below.
import rawTrace from "../src/collab/__fixtures__/collab-trace.json";
import { CollabHostFrameSchema } from "../src/collab/schema";
import { CollabTranslator } from "../src/collab/translate";

const trace = rawTrace as unknown[];

type Msg = Extract<UplinkFrame, { t: "msg" }>;
type Tool = Extract<UplinkFrame, { t: "tool" }>;
type State = Extract<UplinkFrame, { t: "state" }>;
type Attention = Extract<UplinkFrame, { t: "attention" }>;

function replayTrace(): UplinkFrame[] {
  const translator = new CollabTranslator("sess-1");
  const out: UplinkFrame[] = [];
  for (const frame of trace) {
    const parsed = CollabHostFrameSchema.safeParse(frame);
    if (parsed.success) out.push(...translator.host(parsed.data));
  }
  return out;
}

const msgs = (frames: UplinkFrame[]): Msg[] =>
  frames.filter((f): f is Msg => f.t === "msg");
const tools = (frames: UplinkFrame[]): Tool[] =>
  frames.filter((f): f is Tool => f.t === "tool");
const states = (frames: UplinkFrame[]): State[] =>
  frames.filter((f): f is State => f.t === "state");

test("the fixture trace parses to at least the frames we translate", () => {
  const parsedCount = trace.filter(
    (f) => CollabHostFrameSchema.safeParse(f).success,
  ).length;
  // welcome + snapshot + events + entries + states; only genuinely unknown types (e.g. a notice-free bus frame) may drop.
  expect(parsedCount).toBeGreaterThanOrEqual(trace.length - 1);
});

test("every emitted frame is a schema-valid UplinkFrame", () => {
  for (const frame of replayTrace()) {
    expect(UplinkFrame.safeParse(frame).success).toBe(true);
  }
});

test("msg frames carry the Collab source time, one per message across its phases", () => {
  const out = msgs(replayTrace());
  // The prompt entry carries only an ISO `timestamp`.
  expect(out.find((m) => m.role === "user")?.at).toBe(
    Date.parse("2026-09-14T15:11:47.898Z"),
  );
  // The streamed "done" reply takes its message's numeric ms `timestamp`.
  expect(out.at(-1)?.at).toBe(1789398710759);
  const atByMsg = new Map<string, Set<number | undefined>>();
  for (const m of out) {
    const seen = atByMsg.get(m.msgId) ?? new Set();
    seen.add(m.at);
    atByMsg.set(m.msgId, seen);
  }
  for (const seen of atByMsg.values()) {
    expect(seen.size).toBe(1);
    expect(seen.has(undefined)).toBe(false);
  }
});

test("every phase of a streamed assistant message keeps its first emission's time", () => {
  const translator = new CollabTranslator("s");
  const event = (type: string, text: string, timestamp: number) =>
    translator.host({
      t: "event",
      event: {
        type,
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          timestamp,
        },
      },
    });
  const frames = msgs([
    ...event("message_start", "Hi", 1_000),
    ...event("message_update", "Hi there", 2_000),
    ...event("message_end", "Hi there!", 3_000),
  ]);
  expect(frames.map((m) => [m.phase, m.at])).toEqual([
    ["start", 1_000],
    ["update", 1_000],
    ["end", 1_000],
  ]);
  expect(new Set(frames.map((m) => m.msgId)).size).toBe(1);

  // The next message is a new stream with its own time.
  expect(msgs(event("message_start", "Next", 4_000))[0]?.at).toBe(4_000);
});

test("the injected prompt appears exactly once, as the user's message", () => {
  const out = replayTrace();
  const userMsgs = msgs(out).filter((m) => m.role === "user");
  expect(userMsgs).toHaveLength(1);
  expect(userMsgs[0]?.text).toContain("echo pong");
  // toolResult / custom roles must never leak through as chat messages.
  expect(
    msgs(out).some((m) => m.role === "toolResult" || m.role === "custom"),
  ).toBe(false);
});

test("a custom_message notice is a system message labelled by its customType", () => {
  const translator = new CollabTranslator("s");
  const notice =
    "<system-notice>\nBackground job bg_5 has completed. Resume your work using the result below.\nomp/18.1.13\nEXIT=0\n</system-notice>";
  const out = msgs(
    translator.host(
      CollabHostFrameSchema.parse({
        t: "snapshot-chunk",
        final: true,
        entries: [
          {
            type: "custom_message",
            id: "c1",
            customType: "async-result",
            content: notice,
            display: true,
          },
          {
            type: "custom_message",
            id: "c2",
            customType: "collab-prompt",
            content: "run it",
            display: true,
          },
        ],
      }),
    ),
  );
  expect(out).toEqual([
    {
      t: "msg",
      sessionId: "s",
      phase: "end",
      msgId: "c1",
      role: "system",
      text: notice,
      kind: "async-result",
    },
    // The injected remote prompt stays the user's message, unlabelled.
    {
      t: "msg",
      sessionId: "s",
      phase: "end",
      msgId: "c2",
      role: "user",
      text: "run it",
    },
  ]);
});

test("the assistant reply streams under one stable msgId and never emits an empty bubble", () => {
  const out = replayTrace();
  const assistant = msgs(out).filter((m) => m.role === "assistant");
  expect(assistant.length).toBeGreaterThan(0);
  const ids = new Set(assistant.map((m) => m.msgId));
  expect(ids.size).toBe(1); // one assistant message this turn, not collapsed and not split
  expect(assistant.at(-1)?.phase).toBe("end");
  expect(assistant.every((m) => m.text.length > 0)).toBe(true);
  // distinct from the user prompt's id (no cross-message collapse)
  const userId = msgs(out).find((m) => m.role === "user")?.msgId;
  expect(ids.has(userId ?? "")).toBe(false);
});

test("the bash tool round-trips as start -> end under a single callId", () => {
  const out = tools(replayTrace());
  const byCall = new Map<string, Tool[]>();
  for (const t of out)
    byCall.set(t.callId, [...(byCall.get(t.callId) ?? []), t]);
  const bash = [...byCall.values()].find((frames) =>
    frames.some((f) => f.name === "bash"),
  );
  expect(bash).toBeDefined();
  expect(bash?.[0]?.phase).toBe("start");
  expect(bash?.at(-1)?.phase).toBe("end");
  expect(bash?.at(-1)?.status).toBe("done");
});

test("state frames track streaming start and stop", () => {
  const out = states(replayTrace());
  expect(out.length).toBeGreaterThanOrEqual(2);
  expect(out.some((s) => s.streaming)).toBe(true);
  expect(out.at(-1)?.streaming).toBe(false);
  expect(out.at(-1)?.model).toBe("Claude Opus 4.8");
});

test("agent lifecycle drives the working flag immediately, reusing the footer", () => {
  const translator = new CollabTranslator("s");
  // Establish the footer (model/effort/context) from a real state.
  translator.host({
    t: "state",
    state: {
      isStreaming: false,
      model: { name: "Opus" },
      thinkingLevel: "xhigh",
      contextUsage: { percent: 12 },
    },
  });
  // A turn begins before any output (initial thinking): the footer must flip to
  // working at once and keep the last model/effort/context.
  const started = states(
    translator.host({ t: "event", event: { type: "agent_start" } }),
  );
  expect(started.at(-1)).toMatchObject({
    streaming: true,
    model: "Opus",
    thinkingLevel: "xhigh",
    contextPct: 12,
  });
  // The agent finishing flips back to idle and raises one idle attention.
  const ended = translator.host({ t: "event", event: { type: "agent_end" } });
  expect(states(ended).at(-1)?.streaming).toBe(false);
  expect(ended.some((f) => f.t === "attention" && f.reason === "idle")).toBe(
    true,
  );
});

test("ordering: prompt precedes the tool which precedes the reply", () => {
  const out = replayTrace();
  const promptAt = out.findIndex((f) => f.t === "msg" && f.role === "user");
  const toolAt = out.findIndex((f) => f.t === "tool");
  const replyAt = out.findIndex((f) => f.t === "msg" && f.role === "assistant");
  expect(promptAt).toBeGreaterThanOrEqual(0);
  expect(promptAt).toBeLessThan(toolAt);
  expect(toolAt).toBeLessThan(replyAt);
});

test("prompt stays off Collab while interrupt maps to its native guest frame", () => {
  const translator = new CollabTranslator("s");
  const prompt: DownlinkFrame = {
    t: "prompt",
    sessionId: "s",
    text: "hello",
    mode: "followUp",
  };
  expect(translator.downlink(prompt)).toBeNull();
  expect(translator.downlink({ t: "interrupt", sessionId: "s" })).toEqual({
    t: "abort",
  });
});

test("spawn and sync downlink frames are ignored", () => {
  const translator = new CollabTranslator("s");
  expect(
    translator.downlink({
      t: "spawn",
      machineId: "m",
      cwd: "/tmp",
      approvalMode: "write",
      spawnId: "spawn-nonce-1",
    }),
  ).toBeNull();
  expect(translator.downlink({ t: "sync" })).toBeNull();
});

test("a select ui-request becomes an ask interaction and its reply maps back to ui-response", () => {
  const translator = new CollabTranslator("s");
  const [interaction] = translator.host({
    t: "ui-request",
    request: {
      reqId: 7,
      kind: "select",
      title: "Pick one",
      options: ["Allow", { label: "Deny", description: "block it" }],
      initialIndex: 1,
    },
  });
  if (!interaction || interaction.t !== "interaction")
    throw new Error("expected an interaction frame");
  expect(interaction.id).toBe("ui-7");
  expect(interaction.payload.kind).toBe("ask");
  if (interaction.payload.kind !== "ask")
    throw new Error("expected ask payload");
  expect(interaction.payload.questions[0]?.question).toBe("Pick one");
  expect(interaction.payload.questions[0]?.options).toEqual([
    { label: "Allow" },
    { label: "Deny", description: "block it" },
  ]);
  expect(interaction.payload.questions[0]?.recommended).toBe(1);

  const guest = translator.downlink({
    t: "interactionReply",
    sessionId: "s",
    id: interaction.id,
    response: { kind: "ask", answers: ["Deny"] },
  });
  expect(guest).toEqual({ t: "ui-response", reqId: 7, value: "Deny" });
});

test("an editor ui-request becomes a free-text ask, and ui-request-end resolves it", () => {
  const translator = new CollabTranslator("s");
  const [interaction] = translator.host({
    t: "ui-request",
    request: { reqId: 4, kind: "editor", title: "Edit message", prefill: "hi" },
  });
  if (
    !interaction ||
    interaction.t !== "interaction" ||
    interaction.payload.kind !== "ask"
  )
    throw new Error("expected ask interaction");
  expect(interaction.payload.questions[0]?.question).toBe("Edit message");
  expect(interaction.payload.questions[0]?.options).toBeUndefined();

  const [end] = translator.host({ t: "ui-request-end", reqId: 4 });
  expect(end).toEqual({
    t: "interactionEnd",
    sessionId: "s",
    id: "ui-4",
    reason: "resolved",
  });
});

test("emits a single idle attention when the turn completes", () => {
  const out = replayTrace();
  const attentions = out.filter((f): f is Attention => f.t === "attention");
  expect(attentions).toHaveLength(1);
  expect(attentions[0]?.reason).toBe("idle");
  // it lands after the assistant reply, not before the work starts
  const idleAt = out.findIndex((f) => f.t === "attention");
  const replyAt = out.findIndex((f) => f.t === "msg" && f.role === "assistant");
  expect(idleAt).toBeGreaterThan(replyAt);
});

test("a welcome that starts idle does not raise attention", () => {
  const translator = new CollabTranslator("s");
  const frames = translator.host({
    t: "welcome",
    proto: 3,
    header: { title: "t" },
    state: { isStreaming: false, cwd: "/x" },
    entryCount: 0,
  });
  expect(frames.some((f) => f.t === "attention")).toBe(false);
});

test("a live tool call carries its intent as a title through to the end frame", () => {
  const translator = new CollabTranslator("s");
  const start = tools(
    translator.host({
      t: "event",
      event: {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "bash",
        args: { command: "ls -la" },
        intent: "List files",
      },
    }),
  );
  expect(start[0]).toMatchObject({
    name: "bash",
    title: "List files",
    status: "running",
  });
  const end = tools(
    translator.host({
      t: "event",
      event: {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "a\nb" }] },
      },
    }),
  );
  expect(end[0]).toMatchObject({
    name: "bash",
    title: "List files",
    status: "done",
    preview: "a b",
  });
});

test("a tool title falls back to a key argument when there is no intent", () => {
  const translator = new CollabTranslator("s");
  const start = tools(
    translator.host({
      t: "event",
      event: {
        type: "tool_execution_start",
        toolCallId: "c2",
        toolName: "read",
        args: { path: "src/main.ts" },
      },
    }),
  );
  expect(start[0]?.title).toBe("src/main.ts");
});

test("a historical snapshot reconstructs a tool card with name and title", () => {
  const translator = new CollabTranslator("s");
  const frames = tools(
    translator.host({
      t: "snapshot-chunk",
      final: true,
      entries: [
        {
          type: "message",
          id: "m1",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "" },
              {
                type: "toolCall",
                id: "c3",
                name: "read",
                arguments: { path: "a.ts" },
                intent: "Read a",
              },
            ],
          },
        },
        {
          type: "message",
          id: "r1",
          message: {
            role: "toolResult",
            toolCallId: "c3",
            toolName: "read",
            content: [{ type: "text", text: "contents" }],
          },
        },
      ],
    }),
  );
  expect(frames.find((f) => f.phase === "start")).toMatchObject({
    callId: "c3",
    name: "read",
    title: "Read a",
  });
  // The end frame (from the result) keeps the title so the backfilled card,
  // which coalesces to the latest frame per call, is never barren.
  expect(frames.find((f) => f.phase === "end")).toMatchObject({
    callId: "c3",
    name: "read",
    title: "Read a",
    status: "done",
    preview: "contents",
  });
});

test("a live xd:// device call is labelled by the device, not the outer write", () => {
  const translator = new CollabTranslator("s");
  const start = tools(
    translator.host({
      t: "event",
      event: {
        type: "tool_execution_start",
        toolCallId: "x1",
        toolName: "write",
        args: {
          path: "xd://ast_edit",
          content: JSON.stringify({ paths: ["src/main.ts"] }),
        },
      },
    }),
  );
  // The card names the device and summarizes the decoded args, not `{path,content}`.
  expect(start[0]).toMatchObject({ name: "ast_edit", status: "running" });
  expect(start[0]?.title).toContain("src/main.ts");
  expect(start[0]?.title).not.toContain("xd://");
  const end = tools(
    translator.host({
      t: "event",
      event: {
        type: "tool_execution_end",
        toolCallId: "x1",
        toolName: "write",
        result: { content: [{ type: "text", text: "done" }] },
      },
    }),
  );
  // The argless end event keeps the device label across phases.
  expect(end.find((f) => f.phase === "end")).toMatchObject({
    callId: "x1",
    name: "ast_edit",
    status: "done",
  });
});

test("a historical xd:// device call reconstructs under the device name", () => {
  const translator = new CollabTranslator("s");
  const frames = tools(
    translator.host({
      t: "snapshot-chunk",
      final: true,
      entries: [
        {
          type: "message",
          id: "m2",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "x2",
                name: "write",
                arguments: {
                  path: "xd://lsp",
                  content: JSON.stringify({ query: "findRefs" }),
                },
              },
            ],
          },
        },
        {
          type: "message",
          id: "r2",
          message: {
            role: "toolResult",
            toolCallId: "x2",
            toolName: "write",
            content: [{ type: "text", text: "3 refs" }],
          },
        },
      ],
    }),
  );
  expect(frames.find((f) => f.phase === "start")).toMatchObject({
    callId: "x2",
    name: "lsp",
    title: "findRefs",
  });
  // The toolResult end frame carries the outer `write` name; it must stay `lsp`.
  expect(frames.find((f) => f.phase === "end")).toMatchObject({
    callId: "x2",
    name: "lsp",
    status: "done",
    preview: "3 refs",
  });
});

test("a tool result with an inline image emits media anchored to the tool call", () => {
  const translator = new CollabTranslator("sess-1");
  const png = Buffer.from([1, 2, 3, 4, 5]).toString("base64");
  const raw = {
    t: "event",
    event: {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: {
        content: [
          { type: "text", text: "read image file" },
          { type: "image", data: png, mimeType: "image/webp" },
        ],
      },
    },
  };
  const parsed = CollabHostFrameSchema.safeParse(raw);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const out = translator.host(parsed.data);
  expect(out.find((f) => f.t === "mediaInit")).toMatchObject({
    t: "mediaInit",
    sessionId: "sess-1",
    anchor: { kind: "tool", callId: "call-1" },
    mimeType: "image/webp",
  });
  const joined = out
    .filter((f) => f.t === "mediaChunk")
    .map((f) => (f.t === "mediaChunk" ? f.data : ""))
    .join("");
  expect(joined).toBe(png);
  expect(out.some((f) => f.t === "tool" && f.callId === "call-1")).toBe(true);
});

test("a read image carries its source filename into the media frame", () => {
  const translator = new CollabTranslator("sess-1");
  const png = Buffer.from([1, 2, 3]).toString("base64");
  const start = CollabHostFrameSchema.parse({
    t: "event",
    event: {
      type: "tool_execution_start",
      toolCallId: "c9",
      toolName: "read",
      args: { path: "docs/x/desktop.png:img" },
    },
  });
  const end = CollabHostFrameSchema.parse({
    t: "event",
    event: {
      type: "tool_execution_end",
      toolCallId: "c9",
      toolName: "read",
      result: {
        content: [{ type: "image", data: png, mimeType: "image/webp" }],
      },
    },
  });
  translator.host(start);
  const out = translator.host(end);
  expect(out.find((f) => f.t === "mediaInit")).toMatchObject({
    t: "mediaInit",
    name: "desktop.png",
    anchor: { kind: "tool", callId: "c9" },
  });
});

test("a read image is sent from the original file with its true filetype", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-media-"));
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
  ]);
  writeFileSync(join(dir, "shot.png"), png);
  const translator = new CollabTranslator("sess-1");
  translator.host(
    CollabHostFrameSchema.parse({
      t: "state",
      state: { isStreaming: false, cwd: dir },
    }),
  );
  translator.host(
    CollabHostFrameSchema.parse({
      t: "event",
      event: {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "read",
        args: { path: "shot.png:img" },
      },
    }),
  );
  const out = translator.host(
    CollabHostFrameSchema.parse({
      t: "event",
      event: {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "read",
        // omp's inline copy is webp; the phone must get the original png instead.
        result: {
          content: [
            { type: "image", data: "d2VicA==", mimeType: "image/webp" },
          ],
        },
      },
    }),
  );
  expect(out.find((f) => f.t === "mediaInit")).toMatchObject({
    t: "mediaInit",
    name: "shot.png",
    mimeType: "image/png",
  });
  const joined = out
    .filter((f) => f.t === "mediaChunk")
    .map((f) => (f.t === "mediaChunk" ? f.data : ""))
    .join("");
  expect(Buffer.from(joined, "base64")).toEqual(png);
});
