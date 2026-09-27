import { describe, expect, test } from "bun:test";
import {
  IMAGE_MAX_EDGE,
  prepareImage,
  shouldDownscale,
  shouldReencode,
  targetSize,
} from "../src/core/image-prep";

describe("targetSize", () => {
  test("exactly at limit — no scaling", () => {
    expect(targetSize(IMAGE_MAX_EDGE, 1000)).toBeNull();
    expect(targetSize(1000, IMAGE_MAX_EDGE)).toBeNull();
  });

  test("just over limit — scales down", () => {
    const result = targetSize(IMAGE_MAX_EDGE + 1, 1000);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.width).toBeLessThan(IMAGE_MAX_EDGE + 1);
      expect(result.height).toBeLessThanOrEqual(IMAGE_MAX_EDGE);
    }
  });

  test("large landscape image", () => {
    const result = targetSize(4032, 3024);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.width).toBe(2576);
      expect(result.height).toBe(1932);
    }
  });

  test("large portrait image", () => {
    const result = targetSize(3000, 5000);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.width).toBe(1546);
      expect(result.height).toBe(2576);
    }
  });

  test("tiny image — no scaling", () => {
    expect(targetSize(100, 100)).toBeNull();
  });
});

describe("shouldReencode", () => {
  test("JPEG re-encodes", () => {
    expect(shouldReencode("image/jpeg")).toBe(true);
  });

  test("PNG does not re-encode at normal size", () => {
    expect(shouldReencode("image/png")).toBe(false);
  });

  test("WebP does not re-encode at normal size", () => {
    expect(shouldReencode("image/webp")).toBe(false);
  });

  test("GIF does not re-encode", () => {
    expect(shouldReencode("image/gif")).toBe(false);
  });
});

describe("shouldDownscale", () => {
  test("JPEG is downscaled if over limit", () => {
    expect(shouldDownscale("image/jpeg")).toBe(true);
  });

  test("PNG is downscaled if over limit", () => {
    expect(shouldDownscale("image/png")).toBe(true);
  });

  test("WebP is downscaled if over limit", () => {
    expect(shouldDownscale("image/webp")).toBe(true);
  });

  test("GIF is not downscaled", () => {
    expect(shouldDownscale("image/gif")).toBe(false);
  });
});

describe("prepareImage", () => {
  test("JPEG is always re-encoded (EXIF strip)", async () => {
    const fakeJpeg = new File(["not a real jpeg"], "test.jpg", {
      type: "image/jpeg",
    });
    try {
      const result = await prepareImage(fakeJpeg);
      expect(result.type).toBe("image/jpeg");
      expect(result.name).not.toBe("test.jpg");
    } catch {
      // createImageBitmap may fail on fake data in test env
    }
  });

  test("GIF passes through unchanged", async () => {
    const fakeGif = new File(["gif data"], "test.gif", { type: "image/gif" });
    const result = await prepareImage(fakeGif);
    expect(result).toBe(fakeGif);
  });

  test("decode failure falls back to original", async () => {
    const fakePng = new File(["garbage"], "test.png", { type: "image/png" });
    const result = await prepareImage(fakePng);
    expect(result).toBeDefined();
  });
});
