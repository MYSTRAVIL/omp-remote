import { expect, test } from "bun:test";
import type { UplinkFrame } from "@omp-remote/protocol";
import {
  type TranscriptState,
  emptyTranscript,
  reduceTranscript,
} from "../src/core/transcript";
import { orbStateFor } from "../src/ui/orb";

function build(frames: UplinkFrame[]): TranscriptState {
  const state = emptyTranscript();
  for (const frame of frames) reduceTranscript(state, frame);
  return state;
}

const STATE_ON: UplinkFrame = {
  t: "state",
  sessionId: "x",
  model: "m",
  streaming: true,
  title: "T",
};
const STATE_OFF: UplinkFrame = { ...STATE_ON, streaming: false };
const TOOL_START: UplinkFrame = {
  t: "tool",
  sessionId: "x",
  phase: "start",
  callId: "c",
  name: "bash",
  status: "",
  preview: "",
};
const MSG_ASSISTANT: UplinkFrame = {
  t: "msg",
  sessionId: "x",
  phase: "start",
  msgId: "m1",
  role: "assistant",
  text: "hi",
};
const JOBS: UplinkFrame = {
  t: "jobs",
  sessionId: "x",
  recent: 0,
  running: [
    { id: "j", type: "task", label: "scout", status: "running", startMs: 0 },
  ],
};
const BYE: UplinkFrame = { t: "bye", sessionId: "x" };

test("streaming with no tool/text/jobs → working", () => {
  expect(orbStateFor(build([STATE_ON]), false)).toBe("working");
});

test("a running tool → searching", () => {
  expect(orbStateFor(build([STATE_ON, TOOL_START]), false)).toBe("searching");
});

test("a streaming assistant message → composing", () => {
  expect(orbStateFor(build([STATE_ON, MSG_ASSISTANT]), false)).toBe(
    "composing",
  );
});

test("running jobs outrank tool work → weaving", () => {
  expect(orbStateFor(build([STATE_ON, TOOL_START, JOBS]), false)).toBe(
    "weaving",
  );
});

test("needs-attention outranks any work → listening", () => {
  expect(orbStateFor(build([STATE_ON, TOOL_START]), true)).toBe("listening");
});

test("a settled, connected session → breathing", () => {
  expect(orbStateFor(build([STATE_OFF]), false)).toBe("breathing");
});

test("a tool with no end phase is ignored once the session settles", () => {
  expect(orbStateFor(build([TOOL_START, STATE_OFF]), false)).toBe("breathing");
});

test("an ended session shows no orb", () => {
  expect(orbStateFor(build([STATE_ON, BYE]), false)).toBeNull();
});

test("a session with no transcript yet → breathing", () => {
  expect(orbStateFor(undefined, false)).toBe("breathing");
});
