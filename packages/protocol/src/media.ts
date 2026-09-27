/**
 * Host → phone images, cut the same way by every host emitter (the bridge's
 * IPC feed, the Collab translator) so a phone assembles identical transfers
 * from either.
 */
import {
  MAX_RESOURCE_BYTES,
  MEDIA_B64_CHARS_PER_CHUNK,
  type MediaChunkFrame,
  type MediaInitFrame,
  base64ByteLength,
  chunkBase64,
} from "./frames";

/** An inline image of an omp message or tool result. */
export interface ImageBlock {
  mimeType: string;
  /** Base64 of the whole image. */
  data: string;
}

/** The `{type:"image", data, mimeType}` blocks of a message's or a tool
 *  result's content, in order. Other blocks, and content that is not an
 *  array, yield none; an image of no stated type is taken as a PNG. */
export function imageBlocks(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ImageBlock[] = [];
  for (const block of content)
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "image" &&
      "data" in block &&
      typeof block.data === "string"
    )
      out.push({
        mimeType:
          "mimeType" in block && typeof block.mimeType === "string"
            ? block.mimeType
            : "image/png",
        data: block.data,
      });
  return out;
}

/** Media frames before the emitter stamps their session. */
export type MediaInitPayload = Omit<MediaInitFrame, "sessionId">;
export type MediaChunkPayload = Omit<MediaChunkFrame, "sessionId">;

/** An image as the frames that carry it to the phone. */
export type MediaTransfer =
  | { ok: true; init: MediaInitPayload; chunks: MediaChunkPayload[] }
  | {
      ok: false;
      /** Still announced: the `mediaError` that follows it makes the phone
       *  show the image as unavailable rather than leave no trace of it. */
      init: MediaInitPayload;
      code: "too-large" | "internal";
    };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * One image as its `mediaInit` and ordered `mediaChunk`s, anchored to the
 * message or tool call it belongs to. An image that cannot be sent is still
 * announced, with the error to send after it: `too-large` past the transfer
 * budget, `internal` when its data is not whole base64 (a copy clipped on its
 * way to the host, as Collab clips an entry past its replication cap). An
 * image without data yields nothing.
 */
export function mediaTransfer(
  mediaId: string,
  anchor: MediaInitFrame["anchor"],
  image: ImageBlock,
  name?: string,
): MediaTransfer | undefined {
  const { data, mimeType } = image;
  if (data === "") return undefined;
  const init: MediaInitPayload = {
    t: "mediaInit",
    mediaId,
    anchor,
    ...(name ? { name } : {}),
    mimeType,
    size: Math.floor(base64ByteLength(data)),
    totalChunks: Math.ceil(data.length / MEDIA_B64_CHARS_PER_CHUNK),
  };
  if (data.length % 4 !== 0 || !BASE64.test(data))
    return { ok: false, init, code: "internal" };
  if (init.size > MAX_RESOURCE_BYTES)
    return { ok: false, init, code: "too-large" };
  return {
    ok: true,
    init,
    chunks: chunkBase64(data).map((slice, index) => ({
      t: "mediaChunk",
      mediaId,
      index,
      data: slice,
    })),
  };
}
