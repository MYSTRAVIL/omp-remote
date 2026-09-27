/**
 * Composer image preparation: downscale oversized images and strip EXIF from
 * JPEGs before sending. Uses the browser's image decoding (EXIF-aware) and
 * canvas encoding.
 *
 * Policy:
 * - JPEG: always re-encode (strips EXIF/GPS). Scale down if the long edge exceeds
 *   the limit, preserving aspect ratio. Encode at quality 0.9. No byte cap.
 * - PNG/WebP at or under the limit: pass through unchanged (keeps screenshots
 *   lossless). Over the limit: downscale and keep the same format.
 * - GIF and any type the browser cannot decode: pass through unchanged.
 */

export const IMAGE_MAX_EDGE = 2576;
const JPEG_QUALITY = 0.9;

const JPEG_TYPES = ["image/jpeg", "image/jpg"];
const PNG_TYPES = ["image/png"];
const WEBP_TYPES = ["image/webp"];
const REENCODE_TYPES = [...JPEG_TYPES];
const DOWNSCALE_TYPES = [...REENCODE_TYPES, ...PNG_TYPES, ...WEBP_TYPES];

/** Should this file be re-encoded regardless of size? (JPEG: EXIF stripping) */
export function shouldReencode(mimeType: string): boolean {
  return REENCODE_TYPES.includes(mimeType);
}

/** Should this file be downscaled if its long edge exceeds the limit? */
export function shouldDownscale(mimeType: string): boolean {
  return DOWNSCALE_TYPES.includes(mimeType);
}

/**
 * Given source dimensions and a long-edge limit, compute whether downscaling is
 * needed and, if so, the target dimensions that preserve the aspect ratio.
 * Returns null when no scaling is needed.
 */
export function targetSize(
  width: number,
  height: number,
  limit = IMAGE_MAX_EDGE,
): { width: number; height: number } | null {
  const long = Math.max(width, height);
  if (long <= limit) return null;
  const scale = limit / long;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

/** Draw `bitmap` at `width`x`height` and encode it as `type`. */
async function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  type: string,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type, quality: JPEG_QUALITY });
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  canvas.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
    type,
    JPEG_QUALITY,
  );
  return promise;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Prepare a composer image for sending. A JPEG is always re-encoded (which
 * drops EXIF and GPS); a PNG or WebP is re-encoded only when it is over the
 * long-edge limit, so screenshots stay byte-identical. Anything else, and
 * anything that fails to decode or encode, is returned unchanged.
 */
export async function prepareImage(file: File): Promise<File> {
  const type = JPEG_TYPES.includes(file.type) ? "image/jpeg" : file.type;
  if (!shouldDownscale(type)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const scaled = targetSize(bitmap.width, bitmap.height);
    if (scaled === null && !shouldReencode(type)) return file;
    const { width, height } = scaled ?? bitmap;
    const blob = await encode(bitmap, width, height, type);
    // A browser that cannot encode `type` (old Safari and WebP) falls back to PNG.
    const ext = EXTENSIONS[blob.type] ?? "png";
    const base = file.name.replace(/\.[^.]+$/, "") || "image";
    return new File([blob], `${base}.${ext}`, {
      type: blob.type,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}
