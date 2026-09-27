import { expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { historyFrames } from "../src/history";

/** A stored session entry, with only the fields the backfill reads. */
function entry(fields: Record<string, unknown>): SessionEntry {
  // Test fake: omp's entries carry more (id, parent id, usage, model, ...).
  return fields as unknown as SessionEntry;
}
const user = (text: string, timestamp: number) =>
  entry({
    type: "message",
    message: { role: "user", content: text, timestamp },
  });
const assistant = (timestamp: number, ...content: unknown[]) =>
  entry({
    type: "message",
    message: { role: "assistant", content, timestamp },
  });
const answered = (toolCallId: string, text = "", isError = false) =>
  entry({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      content: [{ type: "text", text }],
      isError,
      timestamp: 0,
    },
  });
const call = (
  id: string,
  name: string,
  args: unknown = {},
  intent?: string,
) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
  ...(intent === undefined ? {} : { intent }),
});

test("the branch comes back as the live feed showed it", () => {
  const frames = historyFrames("s1", [
    user("fix the flaky test", 1_000),
    assistant(
      2_000,
      { type: "thinking", thinking: "Where is it?" },
      { type: "text", text: "Reading it first." },
      call("c1", "read", { path: "a.test.ts" }, "Read the test"),
      call("c4", "bash", { command: "bun test a.test.ts" }),
      // The question surfaces as an interaction, never as a card.
      call("c2", "ask"),
    ),
    answered("c1", "1: test('flaky', ...)"),
    answered("c4", "1 fail", true),
    entry({ type: "model_change", model: "p/other" }),
    // A tool-call-only message is no row; its device call still runs.
    assistant(
      3_000,
      call("c3", "write", {
        path: "xd://lsp",
        content: JSON.stringify({ query: "findRefs" }),
      }),
    ),
  ]);

  expect(frames).toEqual([
    {
      t: "msg",
      sessionId: "s1",
      phase: "end",
      msgId: "user-1000",
      role: "user",
      text: "fix the flaky test",
      at: 1_000,
    },
    {
      t: "msg",
      sessionId: "s1",
      phase: "end",
      msgId: "assistant-2000",
      role: "assistant",
      text: "Reading it first.",
      at: 2_000,
    },
    {
      t: "tool",
      sessionId: "s1",
      phase: "end",
      callId: "c1",
      name: "read",
      status: "done",
      title: "Read the test",
      preview: "a.test.ts\n\n1: test('flaky', ...)",
    },
    {
      t: "tool",
      sessionId: "s1",
      phase: "end",
      callId: "c4",
      name: "bash",
      status: "error",
      title: "bun test a.test.ts",
      preview: "bun test a.test.ts\n\n1 fail",
    },
    {
      t: "tool",
      sessionId: "s1",
      phase: "start",
      callId: "c3",
      name: "lsp",
      status: "running",
      title: "findRefs",
      preview: "findRefs",
    },
  ]);
});

test("only the newest rows since the last /clear go back, within the text budget", () => {
  const texts = historyFrames("s1", [
    user("before the clear", 0),
    entry({ type: "reset_boundary" }),
    ...Array.from({ length: 250 }, (_, i) => user(`m${i}`, i + 1)),
  ]).map((f) => (f.t === "msg" ? f.text : f.t));
  expect(texts).toEqual(Array.from({ length: 200 }, (_, i) => `m${i + 50}`));

  // The newest message goes even alone past the budget; nothing older does.
  const times = historyFrames("s1", [
    user("old", 1),
    assistant(2, { type: "text", text: "short" }),
    user("x".repeat(300 * 1024), 3),
  ]).map((f) => (f.t === "msg" ? f.at : f.t));
  expect(times).toEqual([3]);
});

test("tool cards' titles and bodies count against the text budget", () => {
  // 200 calls, each answered with more output than a card body holds.
  const calls = Array.from({ length: 200 }, (_, i) =>
    call(`c${i}`, "bash", { command: `step ${i}` }),
  );
  const frames = historyFrames("s1", [
    assistant(1, ...calls),
    ...calls.map((c) => answered(c.id, "o".repeat(4096))),
  ]);
  const bytes = frames.reduce(
    (sum, f) =>
      sum + (f.t === "tool" ? Buffer.byteLength(`${f.title}${f.preview}`) : 0),
    0,
  );
  expect(bytes).toBeLessThanOrEqual(256 * 1024);
  expect(frames.length).toBeLessThan(200);
  // The newest cards are the ones kept.
  expect(frames.at(-1)).toMatchObject({ callId: "c199", phase: "end" });
});
