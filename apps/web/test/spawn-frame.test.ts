import { expect, test } from "bun:test";
import { SpawnFrame } from "@omp-remote/protocol";
import { spawnFrame } from "../src/core/spawn-frame";

test("a new session's spawn carries the chosen model and no resume", () => {
  const frame = spawnFrame(
    "desk",
    {
      cwd: "/p/alpha",
      model: "anthropic/opus",
      thinkingLevel: "high",
      approvalMode: "write",
    },
    "n1",
  );
  expect(frame).toEqual({
    t: "spawn",
    machineId: "desk",
    cwd: "/p/alpha",
    model: "anthropic/opus",
    thinkingLevel: "high",
    approvalMode: "write",
    spawnId: "n1",
  });
  expect("resume" in frame).toBe(false);
});

test("a resume spawn names the stored session and sends no model, since omp restores its own", () => {
  const frame = spawnFrame(
    "desk",
    {
      cwd: "C:\\p\\alpha",
      model: "anthropic/opus",
      approvalMode: "always-ask",
      resume: "0f1e2d3c-4b5a-6978",
    },
    "n2",
  );
  expect(frame).toEqual({
    t: "spawn",
    machineId: "desk",
    cwd: "C:\\p\\alpha",
    approvalMode: "always-ask",
    spawnId: "n2",
    resume: "0f1e2d3c-4b5a-6978",
  });
  expect("model" in frame).toBe(false);
  // What the host receives parses as the contract's spawn.
  expect(SpawnFrame.parse(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
});
