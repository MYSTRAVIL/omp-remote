import { expect, test } from "bun:test";
import { MAX_RESOURCE_BYTES } from "../src/frames";
import { imageBlocks, mediaTransfer } from "../src/media";

test("only a content array's image blocks are images, in order", () => {
  const images = imageBlocks([
    { type: "text", text: "hello" },
    { type: "image", data: "AA==", mimeType: "image/webp" },
    { type: "image", data: "BB==" },
    { type: "image", data: 42 },
    { type: "other" },
  ]);
  expect(images).toEqual([
    { mimeType: "image/webp", data: "AA==" },
    { mimeType: "image/png", data: "BB==" },
  ]);
  expect(imageBlocks("just text")).toEqual([]);
  expect(imageBlocks(null)).toEqual([]);
});

test("an image goes out in slices that reassemble to its bytes, under its anchor", () => {
  const bytes = Buffer.alloc(200 * 1024, 0x42);
  bytes[bytes.length - 1] = 0x07;
  const transfer = mediaTransfer(
    "call-1:0",
    { kind: "tool", callId: "call-1" },
    { mimeType: "image/png", data: bytes.toString("base64") },
    "shot.png",
  );
  if (!transfer?.ok) throw new Error("expected a transfer");
  expect(transfer.init).toEqual({
    t: "mediaInit",
    mediaId: "call-1:0",
    anchor: { kind: "tool", callId: "call-1" },
    name: "shot.png",
    mimeType: "image/png",
    size: bytes.length,
    totalChunks: transfer.chunks.length,
  });
  expect(transfer.chunks.length).toBeGreaterThan(1);
  expect(transfer.chunks.map((c) => c.index)).toEqual(
    transfer.chunks.map((_, i) => i),
  );
  const whole = Buffer.concat(
    transfer.chunks.map((c) => Buffer.from(c.data, "base64")),
  );
  expect(whole.equals(bytes)).toBe(true);
});

test("an image that cannot be sent is announced with the error to show in its place", () => {
  const anchor = { kind: "message", msgId: "user-1" } as const;
  const big = mediaTransfer("big", anchor, {
    mimeType: "image/png",
    data: Buffer.alloc(MAX_RESOURCE_BYTES + 3).toString("base64"),
  });
  expect(big).toMatchObject({
    ok: false,
    code: "too-large",
    init: { mediaId: "big", anchor, size: MAX_RESOURCE_BYTES + 3 },
  });
  // Collab clips a string past its replication cap and marks the cut: the
  // copy is no longer base64, and must never reach the phone as chunks.
  const clipped = `${"A".repeat(4000)}\n…[123456 chars elided for collab session]`;
  const cut = mediaTransfer("cut", anchor, {
    mimeType: "image/jpeg",
    data: clipped,
  });
  expect(cut).toMatchObject({ ok: false, code: "internal" });
  expect(cut && Number.isInteger(cut.init.size)).toBe(true);
  expect(
    mediaTransfer("none", anchor, { mimeType: "image/png", data: "" }),
  ).toBeUndefined();
});
