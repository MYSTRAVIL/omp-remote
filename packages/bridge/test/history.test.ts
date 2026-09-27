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
const answered = (toolCallId: string) =>
  entry({
    type: "message",
    message: { role: "toolResult", toolCallId, content: [], timestamp: 0 },
  });
const call = (id: string, name: string, args: unknown = {}) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

test("the branch comes back as the live feed showed it", () => {
  const frames = historyFrames("s1", [
    user("fix the flaky test", 1_000),
    assistant(
      2_000,
      { type: "thinking", thinking: "Where is it?" },
      { type: "text", text: "Reading it first." },
      call("c1", "read", { path: "a.test.ts" }),
      // The question surfaces as an interaction, never as a card.
      call("c2", "ask"),
    ),
    answered("c1"),
    entry({ type: "model_change", model: "p/other" }),
    // A tool-call-only message is no row; its device call still runs.
    assistant(3_000, call("c3", "write", { path: "xd://lsp", content: "{}" })),
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
      preview: "",
    },
    {
      t: "tool",
      sessionId: "s1",
      phase: "start",
      callId: "c3",
      name: "lsp",
      status: "running",
      preview: "",
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
