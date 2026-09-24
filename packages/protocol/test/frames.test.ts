import { describe, expect, test } from "bun:test";
import {
  CompactFrame,
  ControlFrame,
  DownlinkFrame,
  MediaChunkFrame,
  MediaErrorFrame,
  MediaInitFrame,
  ModelCatalogFrame,
  PromptFrame,
  StateFrame,
  UplinkFrame,
} from "@omp-remote/protocol";

describe("18.2.5 wire additions", () => {
  test("StateFrame carries optional fastMode", () => {
    const withFast = StateFrame.safeParse({
      t: "state",
      sessionId: "s1",
      model: "anthropic/claude",
      streaming: false,
      title: "t",
      fastMode: true,
    });
    expect(withFast.success).toBe(true);
    expect(withFast.success && withFast.data.fastMode).toBe(true);
    // omitted is still valid (collab path never sets it)
    expect(
      StateFrame.safeParse({
        t: "state",
        sessionId: "s1",
        model: "m",
        streaming: false,
        title: "t",
      }).success,
    ).toBe(true);
  });

  test("serviceTier is a downlink control frame", () => {
    const frame = { t: "serviceTier", sessionId: "s1", enabled: true };
    expect(DownlinkFrame.safeParse(frame).success).toBe(true);
    expect(ControlFrame.safeParse(frame).success).toBe(true);
  });

  test("jobs is an uplink frame with running rows", () => {
    const frame = {
      t: "jobs",
      sessionId: "s1",
      running: [
        {
          id: "j1",
          type: "task",
          label: "scout: map seams",
          status: "running",
          startMs: 1_700_000_000_000,
        },
      ],
      recent: 3,
    };
    expect(UplinkFrame.safeParse(frame).success).toBe(true);
  });
});

describe("composer + model + attachment additions", () => {
  test("PromptFrame accepts aside mode and optional attachments", () => {
    expect(
      PromptFrame.safeParse({
        t: "prompt",
        sessionId: "s1",
        text: "look at this",
        mode: "aside",
        attachments: ["res-1"],
      }).success,
    ).toBe(true);
    for (const mode of ["steer", "followUp"] as const)
      expect(
        PromptFrame.safeParse({
          t: "prompt",
          sessionId: "s1",
          text: "hi",
          mode,
        }).success,
      ).toBe(true);
    expect(
      PromptFrame.safeParse({
        t: "prompt",
        sessionId: "s1",
        text: "hi",
        mode: "whisper",
      }).success,
    ).toBe(false);
  });

  test("modelCatalog is an uplink frame, never a control frame", () => {
    const frame = {
      t: "modelCatalog",
      sessionId: "s1",
      models: [
        {
          id: "anthropic/claude-opus",
          name: "Opus",
          provider: "anthropic",
          efforts: ["low", "high"],
          acceptsImages: true,
        },
      ],
      roles: [{ role: "task", modelId: "qwen/q3", provider: "qwen" }],
    };
    expect(UplinkFrame.safeParse(frame).success).toBe(true);
    expect(ControlFrame.safeParse(frame).success).toBe(false);
  });

  test("CatalogModel.efforts defaults to an empty array", () => {
    const parsed = ModelCatalogFrame.safeParse({
      t: "modelCatalog",
      sessionId: "s1",
      models: [{ id: "m", name: "M", provider: "p" }],
      roles: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.models[0]?.efforts).toEqual([]);
  });

  test("setModel / setThinkingLevel / compact are UV-gated control frames", () => {
    for (const frame of [
      { t: "setModel", sessionId: "s1", model: "@task" },
      { t: "setThinkingLevel", sessionId: "s1", level: "high" },
      { t: "compact", sessionId: "s1" },
    ]) {
      expect(DownlinkFrame.safeParse(frame).success).toBe(true);
      expect(ControlFrame.safeParse(frame).success).toBe(true);
    }
    void CompactFrame;
  });

  test("resource upload frames are data-plane downlink, not UV-gated", () => {
    const init = {
      t: "resourceInit",
      sessionId: "s1",
      transferId: "x",
      name: "photo.png",
      mimeType: "image/png",
      size: 1024,
      totalChunks: 2,
      sha256: "abc",
    };
    const chunk = {
      t: "resourceChunk",
      sessionId: "s1",
      transferId: "x",
      index: 0,
      data: "AAAA",
    };
    const abort = { t: "resourceAbort", sessionId: "s1", transferId: "x" };
    for (const frame of [init, chunk, abort]) {
      expect(DownlinkFrame.safeParse(frame).success).toBe(true);
      expect(ControlFrame.safeParse(frame).success).toBe(false);
    }
  });

  test("resource result frames are uplink", () => {
    for (const frame of [
      { t: "resourceProgress", sessionId: "s1", transferId: "x", received: 1 },
      {
        t: "resourceReady",
        sessionId: "s1",
        transferId: "x",
        resourceId: "r1",
      },
      {
        t: "resourceError",
        sessionId: "s1",
        transferId: "x",
        code: "too-large",
      },
    ]) {
      expect(UplinkFrame.safeParse(frame).success).toBe(true);
      expect(DownlinkFrame.safeParse(frame).success).toBe(false);
    }
  });
});

describe("downlink media frames", () => {
  test("mediaInit round-trips with tool and message anchors", () => {
    const tool = {
      t: "mediaInit",
      sessionId: "s",
      mediaId: "s:0",
      anchor: { kind: "tool", callId: "c1" },
      mimeType: "image/png",
      size: 12,
      totalChunks: 1,
    };
    expect(MediaInitFrame.safeParse(tool).success).toBe(true);
    expect(UplinkFrame.safeParse(tool).success).toBe(true);
    const message = { ...tool, anchor: { kind: "message", msgId: "m1" } };
    expect(MediaInitFrame.safeParse(message).success).toBe(true);
  });
  test("mediaChunk carries base64 data and is an UplinkFrame", () => {
    const f = {
      t: "mediaChunk",
      sessionId: "s",
      mediaId: "s:0",
      index: 0,
      data: "AAAA",
    };
    expect(MediaChunkFrame.safeParse(f).success).toBe(true);
    expect(UplinkFrame.safeParse(f).success).toBe(true);
  });
  test("mediaError only accepts known codes", () => {
    expect(
      MediaErrorFrame.safeParse({
        t: "mediaError",
        sessionId: "s",
        mediaId: "s:0",
        code: "too-large",
      }).success,
    ).toBe(true);
    expect(
      MediaErrorFrame.safeParse({
        t: "mediaError",
        sessionId: "s",
        mediaId: "s:0",
        code: "nope",
      }).success,
    ).toBe(false);
  });
});
