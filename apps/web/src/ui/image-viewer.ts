/// <reference lib="dom" />
import type { OverlayEntry } from "../core/history-nav";
import { button, element } from "./dom";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

interface Point {
  x: number;
  y: number;
}

/** The download filename: source basename + an extension matching the actual
 *  image bytes, or a generic name when the source is unknown. */
export function downloadFileName(mimeType: string, name?: string): string {
  const ext = EXT_BY_MIME[mimeType] ?? "png";
  const base = name?.trim().replace(/\.[^./\\]+$/, "");
  return base ? `${base}.${ext}` : `omp-image.${ext}`;
}

/** Save the image, confirming ONLY on a real write. Where the File System Access
 *  API exists (Android Chrome, desktop) a resolved `close()` is genuine success;
 *  otherwise a plain download hands off to the browser's own download UI. */
async function saveImage(
  dataUrl: string,
  filename: string,
  onSaved: () => void,
): Promise<void> {
  // showSaveFilePicker isn't in the DOM lib types — narrow at this boundary.
  const picker = window as unknown as {
    showSaveFilePicker?: (opts: {
      suggestedName?: string;
    }) => Promise<{
      createWritable(): Promise<{
        write(data: Blob): Promise<void>;
        close(): Promise<void>;
      }>;
    }>;
  };
  if (picker.showSaveFilePicker) {
    try {
      const handle = await picker.showSaveFilePicker({
        suggestedName: filename,
      });
      const writable = await handle.createWritable();
      await writable.write(await (await fetch(dataUrl)).blob());
      await writable.close();
      onSaved();
      return;
    } catch (err) {
      // A dismissed picker isn't a failure; other errors fall back to a plain
      // download so the image still saves, without a false confirmation.
      if ((err as { name?: string }).name === "AbortError") return;
    }
  }
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
}

/**
 * Full-screen viewer over a self-contained `data:` URL: pinch or drag to zoom
 * and pan, double-tap to toggle, a download button, and tap-backdrop / close /
 * Escape to dismiss. It holds a history entry (`onOverlay`) while open, so the
 * back gesture closes it rather than leaving the session. No network — the src
 * is the same local data URL the transcript already holds, so this never
 * fetches a remote resource.
 */
export function openImageViewer(
  dataUrl: string,
  mimeType: string,
  name: string | undefined,
  onOverlay: (close: () => void) => OverlayEntry,
): void {
  const overlay = element("div", "image-viewer");
  const stage = element("div", "image-viewer-stage");
  const img = element("img", "image-viewer-img");
  img.src = dataUrl;
  img.alt = "image";
  img.draggable = false;
  stage.append(img);

  const filename = downloadFileName(mimeType, name);
  const download = button("Download", "button primary");
  const close = button("Close", "button secondary", "close");
  const bar = element("div", "image-viewer-bar");
  bar.append(download, close);
  overlay.append(stage, bar);
  document.body.append(overlay);

  const toast = element("div", "image-viewer-toast", "Saved");
  overlay.append(toast);
  let toastTimer = 0;
  const confirmSaved = () => {
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2500);
  };
  download.addEventListener("click", () => {
    void saveImage(dataUrl, filename, confirmSaved);
  });

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let startDist = 0;
  let startScale = 1;
  let lastX = 0;
  let lastY = 0;
  const pointers = new Map<number, Point>();

  const apply = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  const spread = (): number => {
    const pts = [...pointers.values()];
    if (pts.length < 2) return 0;
    const [a, b] = pts as [Point, Point];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const reset = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  };

  img.addEventListener("pointerdown", (e) => {
    img.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      lastX = e.clientX;
      lastY = e.clientY;
    } else if (pointers.size === 2) {
      startDist = spread();
      startScale = scale;
    }
  });
  img.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2 && startDist > 0) {
      scale = Math.min(6, Math.max(1, startScale * (spread() / startDist)));
      apply();
    } else if (pointers.size === 1 && scale > 1) {
      tx += e.clientX - lastX;
      ty += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      apply();
    }
  });
  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0 && scale <= 1) reset();
  };
  img.addEventListener("pointerup", release);
  img.addEventListener("pointercancel", release);
  img.addEventListener("dblclick", () => {
    if (scale > 1) reset();
    else {
      scale = 2.5;
      apply();
    }
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") dismiss();
  };
  const remove = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey);
  };
  // Back closes the viewer through `remove`; its own close paths also pop
  // the entry.
  const entry = onOverlay(remove);
  const dismiss = () => {
    remove();
    entry.dismiss();
  };
  close.addEventListener("click", dismiss);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target === stage) dismiss();
  });
  window.addEventListener("keydown", onKey);
}
