import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OverlayEntry } from "../src/core/history-nav";
import { downloadFileName, openImageViewer } from "../src/ui/image-viewer";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  for (const v of [...document.querySelectorAll(".image-viewer")]) v.remove();
});

const IMAGE = "data:image/png;base64,AAAA";

/** Stands in for `nav.overlay`: `back` plays the browser back gesture, and
 *  `dismissals` counts the history entries the viewer popped by itself. */
function historyStub() {
  let close = () => {};
  let dismissals = 0;
  return {
    onOverlay(onClose: () => void): OverlayEntry {
      close = onClose;
      return {
        dismiss() {
          dismissals += 1;
        },
      };
    },
    back: () => close(),
    dismissals: () => dismissals,
  };
}

function viewerButtons(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".image-viewer button.button",
    ),
  ];
}

test("downloadFileName keeps the source name with an extension matching the bytes", () => {
  expect(downloadFileName("image/png", "save-error.png")).toBe(
    "save-error.png",
  );
  expect(downloadFileName("image/webp", "desktop.png")).toBe("desktop.webp");
  expect(downloadFileName("image/png")).toBe("omp-image.png");
});

test("opens a viewer with the image and the app's button component", () => {
  openImageViewer(IMAGE, "image/png", "x.png", historyStub().onOverlay);
  const overlay = document.querySelector(".image-viewer");
  const img = overlay?.querySelector<HTMLImageElement>("img.image-viewer-img");
  expect(img?.getAttribute("src")).toBe(IMAGE);
  const labels = viewerButtons().map((b) => b.textContent);
  expect(labels).toContain("Download");
  expect(labels).toContain("Close");
});

test("the close button dismisses the viewer and pops its history entry", () => {
  const history = historyStub();
  openImageViewer(IMAGE, "image/png", undefined, history.onOverlay);
  const close = viewerButtons().find((b) => b.textContent?.includes("Close"));
  close?.click();
  expect(document.querySelector(".image-viewer")).toBeNull();
  expect(history.dismissals()).toBe(1);
});

test("clicking the backdrop dismisses the viewer and pops its history entry", () => {
  const history = historyStub();
  openImageViewer(IMAGE, "image/png", undefined, history.onOverlay);
  const overlay = document.querySelector<HTMLElement>(".image-viewer");
  overlay?.dispatchEvent(new Event("click", { bubbles: true }));
  expect(document.querySelector(".image-viewer")).toBeNull();
  expect(history.dismissals()).toBe(1);
});

test("Escape dismisses the viewer and pops its history entry", () => {
  const history = historyStub();
  openImageViewer(IMAGE, "image/png", undefined, history.onOverlay);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".image-viewer")).toBeNull();
  expect(history.dismissals()).toBe(1);
});

test("the back gesture closes the viewer", () => {
  const history = historyStub();
  openImageViewer(IMAGE, "image/png", undefined, history.onOverlay);
  history.back();
  expect(document.querySelector(".image-viewer")).toBeNull();
});
