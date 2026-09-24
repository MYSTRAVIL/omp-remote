import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MAX_RESOURCE_BYTES } from "@omp-remote/protocol";
import { ResourceAssembler } from "../src/resource-assembler";

function harness(now?: () => number) {
  const progress: Array<[string, number]> = [];
  const ready: Array<[string, string]> = [];
  const errors: Array<[string, string]> = [];
  const asm = new ResourceAssembler(
    {
      onProgress: (id, n) => progress.push([id, n]),
      onReady: (id, rid) => ready.push([id, rid]),
      onError: (id, code) => errors.push([id, code]),
    },
    now,
  );
  return { asm, progress, ready, errors };
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

const IMG = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const SHA = createHash("sha256").update(IMG).digest("hex");

function init(transferId: string, over: Record<string, unknown> = {}) {
  return {
    t: "resourceInit" as const,
    sessionId: "s",
    transferId,
    name: "photo.png",
    mimeType: "image/png",
    size: 8,
    totalChunks: 2,
    sha256: SHA,
    ...over,
  };
}
function chunk(transferId: string, index: number, data: string) {
  return {
    t: "resourceChunk" as const,
    sessionId: "s",
    transferId,
    index,
    data,
  };
}

test("assembles ordered chunks into a resolvable image resource", () => {
  const { asm, progress, ready, errors } = harness();
  asm.init(init("x"));
  asm.chunk(chunk("x", 0, b64(IMG.subarray(0, 4))));
  asm.chunk(chunk("x", 1, b64(IMG.subarray(4, 8))));

  expect(errors).toEqual([]);
  expect(progress).toEqual([
    ["x", 1],
    ["x", 2],
  ]);
  expect(ready.length).toBe(1);
  const resourceId = ready[0]?.[1] ?? "";
  const resolved = asm.resolve([resourceId]);
  expect(resolved.ok).toBe(true);
  if (resolved.ok) {
    expect(resolved.resources[0]?.mimeType).toBe("image/png");
    expect(Buffer.from(resolved.resources[0]?.data ?? "", "base64")).toEqual(
      Buffer.from(IMG),
    );
  }
});

test("assembles chunks that arrive out of order", () => {
  const { asm, ready, errors } = harness();
  asm.init(init("y"));
  asm.chunk(chunk("y", 1, b64(IMG.subarray(4, 8))));
  asm.chunk(chunk("y", 0, b64(IMG.subarray(0, 4))));
  expect(errors).toEqual([]);
  const resolved = asm.resolve([ready[0]?.[1] ?? ""]);
  expect(resolved.ok).toBe(true);
  if (resolved.ok)
    expect(Buffer.from(resolved.resources[0]?.data ?? "", "base64")).toEqual(
      Buffer.from(IMG),
    );
});

test("rejects a sha-256 mismatch as an integrity error", () => {
  const { asm, ready, errors } = harness();
  asm.init(init("z", { sha256: "00".repeat(32) }));
  asm.chunk(chunk("z", 0, b64(IMG.subarray(0, 4))));
  asm.chunk(chunk("z", 1, b64(IMG.subarray(4, 8))));
  expect(ready).toEqual([]);
  expect(errors).toEqual([["z", "integrity"]]);
});

test("rejects a byte-count mismatch as an integrity error", () => {
  const { asm, ready, errors } = harness();
  // Announce 8 bytes but deliver 6 across the two chunks.
  asm.init(init("w"));
  asm.chunk(chunk("w", 0, b64(IMG.subarray(0, 3))));
  asm.chunk(chunk("w", 1, b64(IMG.subarray(3, 6))));
  expect(ready).toEqual([]);
  expect(errors).toEqual([["w", "integrity"]]);
});

test("rejects a non-image mime type", () => {
  const { asm, errors } = harness();
  asm.init(init("p", { mimeType: "application/pdf" }));
  expect(errors).toEqual([["p", "unsupported"]]);
});

test("rejects an over-budget resource at init", () => {
  const { asm, errors } = harness();
  asm.init(init("big", { size: MAX_RESOURCE_BYTES + 1 }));
  expect(errors).toEqual([["big", "too-large"]]);
});

test("resolve reports missing ids instead of dropping them", () => {
  const { asm } = harness();
  const resolved = asm.resolve(["never-uploaded"]);
  expect(resolved.ok).toBe(false);
  if (!resolved.ok) expect(resolved.missing).toEqual(["never-uploaded"]);
});

test("abort drops an in-flight transfer so later chunks are ignored", () => {
  const { asm, ready, errors } = harness();
  asm.init(init("a"));
  asm.chunk(chunk("a", 0, b64(IMG.subarray(0, 4))));
  asm.abort("a");
  asm.chunk(chunk("a", 1, b64(IMG.subarray(4, 8))));
  expect(ready).toEqual([]);
  expect(errors).toEqual([]);
});

test("prunes a stale transfer on the next init", () => {
  let now = 0;
  const { asm, errors } = harness(() => now);
  asm.init(init("stale"));
  now = 6 * 60_000;
  asm.init(init("fresh"));
  expect(errors).toContainEqual(["stale", "expired"]);
});

test("a resolved resource can be released", () => {
  const { asm, ready } = harness();
  asm.init(init("r"));
  asm.chunk(chunk("r", 0, b64(IMG.subarray(0, 4))));
  asm.chunk(chunk("r", 1, b64(IMG.subarray(4, 8))));
  const resourceId = ready[0]?.[1] ?? "";
  expect(asm.resolve([resourceId]).ok).toBe(true);
  asm.release(resourceId);
  expect(asm.resolve([resourceId]).ok).toBe(false);
});
