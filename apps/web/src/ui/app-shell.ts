/// <reference lib="dom" />

/**
 * Keep the app shell (`#app`) on the visible screen. The document itself never
 * scrolls: the CSS clips it and every screen scrolls its own region. The
 * browser can still move it, though: a reload restores the scroll offset saved
 * with the history entry, and focusing a field scrolls it into view. So the
 * reload skips scroll restoration, any stray document scroll is undone, and
 * the fixed shell follows the visual viewport (`--app-top`/`--app-height`),
 * re-read whenever it can change: a resize (keyboard, rotation), a visual
 * viewport move, a bfcache restore and a return to the foreground.
 */
export function pinShellToViewport(): void {
  history.scrollRestoration = "manual";
  const root = document.documentElement;
  const sync = (): void => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    const viewport = window.visualViewport;
    // A pinch zoom shrinks the visual viewport on purpose; the shell keeps its
    // last unzoomed size and place instead of shrinking with it.
    if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return;
    root.style.setProperty("--app-top", `${viewport.offsetTop}px`);
    root.style.setProperty("--app-height", `${viewport.height}px`);
  };
  sync();
  window.addEventListener("resize", sync);
  window.addEventListener("pageshow", sync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync();
  });
  window.visualViewport?.addEventListener("resize", sync);
  window.visualViewport?.addEventListener("scroll", sync);
}
