import { expect, test } from "bun:test";
import type { SealedFrame as SealedFrameType } from "../src/frames";
import {
  AnyFrame,
  ClientMessage,
  ControlFrame,
  DownlinkFrame,
  SealedFrame,
  SessionsFrame,
  SpawnFrame,
  UplinkFrame,
  isDownlinkFrame,
} from "../src/frames";

test("no frame tag is shared across directions, so isDownlinkFrame is sound", () => {
  const tags = (u: typeof UplinkFrame | typeof DownlinkFrame): string[] =>
    u.options.map((o) => o.shape.t.value);
  const down = tags(DownlinkFrame);
  const agentToPhone = [SessionsFrame.shape.t.value, ...tags(UplinkFrame)];
  expect(agentToPhone.filter((t) => down.includes(t))).toEqual([]);
  expect(isDownlinkFrame({ t: "sync" })).toBe(true);
  expect(isDownlinkFrame({ t: "sessions", sessions: [] })).toBe(false);
});

test("the sealed channel contract carries snapshots, uplink, and downlink frames", () => {
  const frames: SealedFrameType[] = [
    {
      t: "sessions",
      sessions: [
        {
          id: "s1",
          cwd: "/x/p",
          project: "p",
          model: "m",
          title: "T",
          pid: 3,
          startedAt: 0,
        },
      ],
    },
    {
      t: "msg",
      sessionId: "s1",
      phase: "update",
      msgId: "m1",
      role: "assistant",
      text: "hi",
    },
    {
      t: "tool",
      sessionId: "s1",
      phase: "start",
      callId: "c1",
      name: "read",
      status: "running",
      preview: "",
    },
    {
      t: "state",
      sessionId: "s1",
      model: "m",
      contextPct: 1,
      streaming: true,
      title: "T",
    },
    { t: "prompt", sessionId: "s1", text: "go", mode: "steer" },
    { t: "interrupt", sessionId: "s1" },
    {
      t: "spawn",
      machineId: "m1",
      cwd: "/x/p",
      model: "opus",
      approvalMode: "yolo",
      spawnId: "spawn-nonce-1",
    },
    {
      t: "spawn",
      machineId: "m1",
      cwd: "/x/p",
      approvalMode: "write",
      spawnId: "spawn-nonce-2",
    },
    { t: "sync" },
    { t: "attention", sessionId: "s1", reason: "idle" },
    { t: "attention", sessionId: "s1", reason: "approval" },
    {
      t: "controlError",
      sessionId: "s1",
      action: "prompt",
      code: "prompt-control-unavailable",
      message:
        "Queue and Steer are unavailable until this OMP session loads the remote bridge.",
    },
  ];
  for (const f of frames) {
    const parsed = SealedFrame.safeParse(f);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(f);
  }
});

test("spawn is a control frame; sync is not", () => {
  const spawn = {
    t: "spawn" as const,
    machineId: "m1",
    cwd: "/x/p",
    approvalMode: "yolo" as const,
    spawnId: "spawn-nonce-3",
  };
  expect(ControlFrame.safeParse(spawn).success).toBe(true);
  expect(ControlFrame.safeParse({ t: "sync" }).success).toBe(false);
});

test("an unknown approval mode is rejected", () => {
  const bad = {
    t: "spawn",
    machineId: "m1",
    cwd: "/x/p",
    approvalMode: "nuke",
    spawnId: "spawn-nonce-4",
  };
  expect(SpawnFrame.safeParse(bad).success).toBe(false);
});

test("spawn thinkingLevel admits only omp's levels, since it reaches a command line", () => {
  const spawn = {
    t: "spawn",
    machineId: "m1",
    cwd: "/x/p",
    approvalMode: "write",
    spawnId: "spawn-nonce-5",
  };
  expect(
    SpawnFrame.safeParse({ ...spawn, thinkingLevel: "xhigh" }).success,
  ).toBe(true);
  expect(
    SpawnFrame.safeParse({ ...spawn, thinkingLevel: "high & calc" }).success,
  ).toBe(false);
});

test("an attention frame is a uplink/client/sealed member but not a control frame", () => {
  const attn = {
    t: "attention" as const,
    sessionId: "s1",
    reason: "idle" as const,
  };
  expect(SealedFrame.safeParse(attn).success).toBe(true);
  expect(UplinkFrame.safeParse(attn).success).toBe(true);
  expect(ClientMessage.safeParse(attn).success).toBe(true);
  expect(ControlFrame.safeParse(attn).success).toBe(false);
});

test("a prompt-control error is visible but never a control frame", () => {
  const error = {
    t: "controlError" as const,
    sessionId: "s1",
    action: "prompt" as const,
    code: "prompt-control-unavailable" as const,
    message:
      "Queue and Steer are unavailable until this OMP session loads the remote bridge.",
  };
  expect(SealedFrame.safeParse(error).success).toBe(true);
  expect(UplinkFrame.safeParse(error).success).toBe(true);
  expect(ClientMessage.safeParse(error).success).toBe(true);
  expect(ControlFrame.safeParse(error).success).toBe(false);
});

test("prompt-control readiness is local IPC only", () => {
  const ready = { t: "promptControlReady", sessionId: "s1" };
  expect(AnyFrame.safeParse(ready).success).toBe(true);
  expect(SealedFrame.safeParse(ready).success).toBe(false);
});

test("an unknown attention reason is rejected", () => {
  expect(
    UplinkFrame.safeParse({ t: "attention", sessionId: "s1", reason: "poke" })
      .success,
  ).toBe(false);
});
