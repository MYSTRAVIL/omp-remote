import { expect, test } from "bun:test";
import { FrameDecoder, FrameParseError, encodeFrame } from "../src/index";
import type { Frame } from "../src/index";

test("round-trips a hello frame", () => {
  const frame: Frame = {
    t: "hello",
    token: "tok",
    session: {
      id: "s1",
      cwd: "/x/proj",
      project: "proj",
      model: "m",
      title: "t",
      pid: 1,
      startedAt: 0,
    },
  };
  const dec = new FrameDecoder();
  expect(dec.push(encodeFrame(frame))).toEqual([frame]);
});

test("reassembles a frame split across chunks", () => {
  const frame: Frame = { t: "interrupt", sessionId: "s1" };
  const wire = encodeFrame(frame);
  const dec = new FrameDecoder();
  expect(dec.push(wire.slice(0, 5))).toEqual([]);
  expect(dec.push(wire.slice(5))).toEqual([frame]);
});

test("emits two frames from one chunk", () => {
  const a: Frame = { t: "interrupt", sessionId: "s1" };
  const b: Frame = { t: "bye", sessionId: "s1" };
  const dec = new FrameDecoder();
  expect(dec.push(encodeFrame(a) + encodeFrame(b))).toEqual([a, b]);
});

test("throws on a structurally invalid frame", () => {
  const dec = new FrameDecoder();
  expect(() => dec.push(`${JSON.stringify({ t: "hello" })}\n`)).toThrow(
    FrameParseError,
  );
});
