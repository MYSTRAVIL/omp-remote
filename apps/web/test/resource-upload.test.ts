import { expect, test } from "bun:test";
import {
  type DownlinkFrame,
  MAX_RESOURCE_CHUNK_BYTES,
} from "@omp-remote/protocol";
import { AttachmentUploader } from "../src/core/resource-upload";

function imageFile(size: number): File {
  return new File([new Uint8Array(size).fill(7)], "photo.png", {
    type: "image/png",
  });
}

test("upload announces the resource, streams chunks, and resolves on ready", async () => {
  const sent: DownlinkFrame[] = [];
  const initSeen = Promise.withResolvers<string>();
  const uploader = new AttachmentUploader((_machineId, frame) => {
    sent.push(frame);
    if (frame.t === "resourceInit") initSeen.resolve(frame.transferId);
    return true;
  });

  // One full chunk plus a remainder → exactly two chunks.
  const file = imageFile(MAX_RESOURCE_CHUNK_BYTES + 10);
  const progress: number[] = [];
  const pending = uploader.upload("m1", "s1", file, (f) => progress.push(f));

  // Awaiting the init frame is the real "hashing + announce done" signal.
  const transferId = await initSeen.promise;
  const init = sent.find((f) => f.t === "resourceInit");
  const chunks = sent.filter((f) => f.t === "resourceChunk");
  expect(init).toMatchObject({
    t: "resourceInit",
    sessionId: "s1",
    mimeType: "image/png",
    size: MAX_RESOURCE_CHUNK_BYTES + 10,
    totalChunks: 2,
  });
  expect(chunks.length).toBe(2);

  uploader.handleFrame({
    t: "resourceProgress",
    sessionId: "s1",
    transferId,
    received: 1,
  });
  uploader.handleFrame({
    t: "resourceReady",
    sessionId: "s1",
    transferId,
    resourceId: "res-42",
  });

  expect(await pending).toBe("res-42");
  expect(progress).toContain(0.5);
});

test("a resource error rejects the upload", async () => {
  const initSeen = Promise.withResolvers<string>();
  const uploader = new AttachmentUploader((_machineId, frame) => {
    if (frame.t === "resourceInit") initSeen.resolve(frame.transferId);
    return true;
  });
  const pending = uploader.upload("m1", "s1", imageFile(16), () => {});
  const transferId = await initSeen.promise;
  uploader.handleFrame({
    t: "resourceError",
    sessionId: "s1",
    transferId,
    code: "integrity",
  });
  await expect(pending).rejects.toThrow("integrity");
});

test("a non-image file is refused before any frame is sent", async () => {
  const sent: DownlinkFrame[] = [];
  const uploader = new AttachmentUploader((_machineId, frame) => {
    sent.push(frame);
    return true;
  });
  const file = new File([new Uint8Array(8)], "notes.txt", {
    type: "text/plain",
  });
  await expect(uploader.upload("m1", "s1", file, () => {})).rejects.toThrow(
    "unsupported",
  );
  expect(sent).toEqual([]);
});

test("a silent upload rejects with timeout instead of hanging forever", async () => {
  const uploader = new AttachmentUploader(() => true, 20);
  const pending = uploader.upload("m1", "s1", imageFile(16), () => {});
  await expect(pending).rejects.toThrow("timeout");
});
