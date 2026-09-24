import { describe, expect, test } from "bun:test";
import { MAX_RESOURCE_BYTES } from "@omp-remote/protocol";
import { chunkImage, imagesOf } from "../src/media-chunker";

describe("imagesOf", () => {
  test("extracts image blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "image", data: "BB==" },
      { type: "other" },
    ];
    const images = imagesOf(content);
    expect(images).toHaveLength(2);
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[0]?.data).toBe("AA==");
    expect(images[1]?.mimeType).toBe("image/png");
    expect(images[1]?.data).toBe("BB==");
  });

  test("returns empty for non-image/non-array", () => {
    expect(imagesOf("just text")).toHaveLength(0);
    expect(imagesOf(null)).toHaveLength(0);
    expect(imagesOf([{ type: "tool", name: "bash" }])).toHaveLength(0);
  });
});

describe("chunkImage", () => {
  const tinyPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]).toString("base64");

  test("single-chunk image", () => {
    const result = chunkImage("s:m:0", "m", {
      mimeType: "image/png",
      data: tinyPng,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("not ok");
    expect(result.chunks).toHaveLength(1);
    expect(result.init.mediaId).toBe("s:m:0");
    expect(result.init.anchor).toEqual({ kind: "message", msgId: "m" });
    expect(result.init.size).toBe(8);
    expect(result.init.totalChunks).toBe(1);
  });

  test("too-large image", () => {
    const big = Buffer.alloc(MAX_RESOURCE_BYTES + 1, 0x42).toString("base64");
    const result = chunkImage("s:m:0", "m", {
      mimeType: "image/png",
      data: big,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not be ok");
    expect(result.code).toBe("too-large");
  });

  test("empty data after decode", () => {
    const result = chunkImage("s:m:0", "m", {
      mimeType: "image/png",
      data: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not be ok");
    expect(result.code).toBe("internal");
  });

  test("reassembled chunks match original", () => {
    const big = Buffer.alloc(MAX_RESOURCE_BYTES, 0x42).toString("base64");
    const result = chunkImage("s:m:0", "m", {
      mimeType: "image/png",
      data: big,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("not ok");
    const reassembled = result.chunks.reduce((buf, chunk) => {
      return Buffer.concat([buf, Buffer.from(chunk.data, "base64")]);
    }, Buffer.alloc(0));
    expect(reassembled.toString("base64")).toBe(big);
    expect(reassembled.length).toBe(MAX_RESOURCE_BYTES);
  });
});
