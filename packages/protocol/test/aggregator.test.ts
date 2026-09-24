import { expect, test } from "bun:test";
import type { AggregatorControl as AggregatorControlType } from "../src/aggregator";
import {
  AggregatorControl,
  MachinesMsg,
  RoutedEnvelope,
  ServerControl,
} from "../src/aggregator";

test("client/agent control messages round-trip through the union", () => {
  const msgs: AggregatorControlType[] = [
    { type: "register", machineId: "machine-a" },
    { type: "attach", machineId: "machine-b" },
    { type: "list" },
    { type: "attention" },
    { type: "ping" },
  ];
  for (const m of msgs) {
    const parsed = AggregatorControl.safeParse(m);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(m);
  }
});

test("register requires a machineId", () => {
  expect(
    AggregatorControl.safeParse({ type: "register", machineId: "m" }).success,
  ).toBe(true);
  expect(AggregatorControl.safeParse({ type: "register" }).success).toBe(false);
});

test("server control messages round-trip", () => {
  const machines = { type: "machines", machineIds: ["a", "b"] };
  const err = { type: "error", reason: "bad token" };
  const pong = { type: "pong" };
  expect(ServerControl.safeParse(machines).success).toBe(true);
  expect(ServerControl.safeParse(err).success).toBe(true);
  expect(ServerControl.safeParse(pong).success).toBe(true);
  // ping is inbound-only; the aggregator never emits it
  expect(ServerControl.safeParse({ type: "ping" }).success).toBe(false);
  expect(MachinesMsg.safeParse({ type: "machines" }).success).toBe(false);
});

test("routed envelope exposes only the clear route and keeps sealed fields", () => {
  const wire = { route: "machine-a", n: "nonce", ct: "cipher" };
  const parsed = RoutedEnvelope.safeParse(wire);
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.route).toBe("machine-a");
    // passthrough keeps sealed fields for verbatim forwarding
    expect(parsed.data).toEqual(wire);
  }
  expect(RoutedEnvelope.safeParse({ n: "x", ct: "y" }).success).toBe(false);
});
