import { expect, test } from "bun:test";
import {
  type AgentDiagnostic,
  formatAgentDiagnostic,
} from "../src/diagnostics";

const NOW = new Date("2026-09-16T12:34:56.789Z");

test("formats an allowlisted timestamped control outcome", () => {
  // Simulate a contaminated object arriving across an untyped runtime boundary.
  const event = {
    event: "control_outcome",
    action: "prompt",
    sessionId: "session-1",
    mode: "steer",
    route: "ipc-prompt-control",
    outcome: "forwarded",
    execution: "unconfirmed",
    prompt: "private prompt body",
    answer: "private answer body",
    token: "secret-token",
    roomLink: "wss://relay.example/r/room#secret",
    url: "wss://relay.example/agent?token=secret-token",
    error: new Error("provider emitted private output"),
  } as unknown as AgentDiagnostic;

  const line = formatAgentDiagnostic(event, NOW);
  expect(JSON.parse(line)).toEqual({
    timestamp: "2026-09-16T12:34:56.789Z",
    level: "info",
    component: "host.control",
    event: "control_outcome",
    action: "prompt",
    sessionId: "session-1",
    mode: "steer",
    route: "ipc-prompt-control",
    outcome: "forwarded",
    execution: "unconfirmed",
  });
  expect(line).not.toContain("private prompt");
  expect(line).not.toContain("private answer");
  expect(line).not.toContain("secret-token");
  expect(line).not.toContain("room#secret");
  expect(line).not.toContain("provider emitted");
});

test("formats rotation failures with a stable code only", () => {
  expect(
    JSON.parse(
      formatAgentDiagnostic(
        { event: "log_rotation_failed", code: "io-failed" },
        NOW,
      ),
    ),
  ).toEqual({
    timestamp: "2026-09-16T12:34:56.789Z",
    level: "warn",
    component: "host.log",
    event: "log_rotation_failed",
    code: "io-failed",
  });
});

test("formats suppressed client rejections as known codes and counts only", () => {
  // Simulate a contaminated object arriving across an untyped runtime boundary.
  const event = {
    event: "client_frame_rejections_suppressed",
    suppressedCount: { malformed: 9_999, replayed: 2, "epoch-e1": 1 },
    epoch: "epoch-e2",
  } as unknown as AgentDiagnostic;

  const line = formatAgentDiagnostic(event, NOW);
  expect(JSON.parse(line)).toEqual({
    timestamp: "2026-09-16T12:34:56.789Z",
    level: "warn",
    component: "host.client",
    event: "client_frame_rejections_suppressed",
    suppressedCount: { malformed: 9_999, replayed: 2 },
  });
});
