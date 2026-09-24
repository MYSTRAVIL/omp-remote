import {
  MAX_RESOURCE_BYTES,
  base64ByteLength,
  chunkBase64,
} from "@omp-remote/protocol";

/** An inline image pulled from an omp message's content array. */
export interface ImageBlock {
  mimeType: string;
  /** Base64 of the complete image bytes. */
  data: string;
}

/** Pull `{ type:"image", data, mimeType }` blocks out of a message's content.
 *  Text and unknown blocks are ignored; non-array content yields nothing. */
export function imagesOf(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ImageBlock[] = [];
  for (const c of content) {
    if (
      c &&
      typeof c === "object" &&
      "type" in c &&
      c.type === "image" &&
      "data" in c &&
      typeof c.data === "string"
    ) {
      const img = c as { data: string; type: "image"; mimeType?: string };
      out.push({
        mimeType: typeof img.mimeType === "string" ? img.mimeType : "image/png",
        data: img.data,
      });
    }
  }
  return out;
}

export type ChunkedImage =
  | {
      ok: true;
      init: {
        t: "mediaInit";
        mediaId: string;
        anchor: { kind: "message"; msgId: string };
        mimeType: string;
        size: number;
        totalChunks: number;
      };
      chunks: {
        t: "mediaChunk";
        mediaId: string;
        index: number;
        data: string;
      }[];
    }
  | { ok: false; code: "too-large" | "internal" };

/** Slice one image into an init + ordered base64 chunks at the shared 48 KiB
 *  boundary, enforcing the 8 MiB budget. Frames omit `sessionId`; the SessionBridge
 *  emit methods stamp it. Anchored to an assistant message (IPC-feed path). */
export function chunkImage(
  mediaId: string,
  msgId: string,
  image: ImageBlock,
): ChunkedImage {
  const size = base64ByteLength(image.data);
  if (size === 0) return { ok: false, code: "internal" };
  if (size > MAX_RESOURCE_BYTES) return { ok: false, code: "too-large" };
  const slices = chunkBase64(image.data);
  return {
    ok: true,
    init: {
      t: "mediaInit",
      mediaId,
      anchor: { kind: "message", msgId },
      mimeType: image.mimeType,
      size,
      totalChunks: slices.length,
    },
    chunks: slices.map((data, index) => ({
      t: "mediaChunk",
      mediaId,
      index,
      data,
    })),
  };
}
