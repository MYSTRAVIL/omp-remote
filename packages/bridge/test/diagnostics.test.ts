import { expect, test } from "bun:test";
import {
  type BridgeDiagnostic,
  bridgeLoggerDiagnostic,
  formatBridgeDiagnostic,
} from "../src/diagnostics";

const NOW = new Date("2026-09-16T12:34:56.789Z");

test("formats only allowlisted bridge handoff metadata", () => {
  // Simulate a contaminated object arriving across an untyped extension boundary.
  const event = {
    event: "prompt_dispatch_accepted",
    sessionId: "session-1",
    mode: "followUp",
    route: "active-follow-up",
    execution: "unconfirmed",
    prompt: "private prompt body",
    answer: "private answer body",
    token: "secret-token",
    roomLink: "wss://relay.example/r/room#secret",
    url: "wss://relay.example/agent?token=secret-token",
    error: new Error("provider output"),
  } as unknown as BridgeDiagnostic;

  const line = formatBridgeDiagnostic(event, NOW);
  expect(JSON.parse(line)).toEqual({
    timestamp: "2026-09-16T12:34:56.789Z",
    level: "info",
    component: "bridge.control",
    event: "prompt_dispatch_accepted",
    sessionId: "session-1",
    mode: "followUp",
    route: "active-follow-up",
    execution: "unconfirmed",
  });
  expect(line).not.toContain("private prompt");
  expect(line).not.toContain("private answer");
  expect(line).not.toContain("secret-token");
  expect(line).not.toContain("room#secret");
  expect(line).not.toContain("provider output");
});

test("model execution is a separate diagnostic from prompt handoff", () => {
  expect(
    JSON.parse(
      formatBridgeDiagnostic(
        { event: "model_execution_started", sessionId: "session-1" },
        NOW,
      ),
    ),
  ).toEqual({
    timestamp: "2026-09-16T12:34:56.789Z",
    level: "info",
    component: "bridge.model",
    event: "model_execution_started",
    sessionId: "session-1",
  });
});

test("a failing OMP logger never escapes the bridge diagnostic sink", () => {
  const fail = () => {
    throw new Error("logger unavailable");
  };
  const diagnostic = bridgeLoggerDiagnostic({
    info: fail,
    warn: fail,
    error: fail,
  });

  expect(() =>
    diagnostic({ event: "model_execution_started", sessionId: "session-1" }),
  ).not.toThrow();
});
