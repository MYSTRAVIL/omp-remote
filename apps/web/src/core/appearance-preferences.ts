/// <reference lib="dom" />
import { z } from "zod";

const Theme = z.enum(["system", "dark", "light"]);
/** `system` follows this device's light or dark setting. */
export type AppearanceTheme = z.infer<typeof Theme>;

const Density = z.enum(["comfortable", "compact"]);
export type AppearanceDensity = z.infer<typeof Density>;

/** The palette the page is painted in once `system` is resolved. */
export type ColorScheme = "dark" | "light";

/** `localStorage` key holding this browser's appearance choices. */
export const APPEARANCE_KEY = "omp-remote.appearance";

/** The media query a `system` theme follows. */
export const PREFERS_LIGHT = "(prefers-color-scheme: light)";

/**
 * Each field falls back on its own, so one unknown value never resets the
 * other. Dark is the default: nothing changes for anyone who never chooses.
 */
const StoredAppearance = z.object({
  theme: Theme.catch("dark"),
  density: Density.catch("comfortable"),
});
type StoredAppearance = z.infer<typeof StoredAppearance>;

/** Each palette's `--canvas` in styles.css, for the browser's own chrome. */
const THEME_COLORS: Record<ColorScheme, string> = {
  dark: "#000000",
  light: "#f7f5f0",
};

/**
 * How the app looks in this browser. `applyAppearance` keeps the document in
 * step and Settings subscribes, so a change applies everywhere at once,
 * without a reload.
 */
export class AppearancePreferences {
  #values: StoredAppearance = StoredAppearance.parse({});
  readonly #listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = window.localStorage.getItem(APPEARANCE_KEY);
      if (raw === null) return;
      const parsed = StoredAppearance.safeParse(JSON.parse(raw));
      if (parsed.success) this.#values = parsed.data;
    } catch {
      // Denied storage or malformed JSON must not prevent opening the workspace.
    }
  }

  get theme(): AppearanceTheme {
    return this.#values.theme;
  }

  /** Compact tightens the session list, settings rows and the conversation. */
  get density(): AppearanceDensity {
    return this.#values.density;
  }

  setTheme(theme: AppearanceTheme): boolean {
    return this.#commit({ ...this.#values, theme });
  }

  setDensity(density: AppearanceDensity): boolean {
    return this.#commit({ ...this.#values, density });
  }

  /** Call `listener` after every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Apply at once; false when storage is unavailable and the choice lasts only this page load. */
  #commit(values: StoredAppearance): boolean {
    this.#values = values;
    for (const listener of this.#listeners) listener();
    try {
      window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(values));
      return true;
    } catch {
      return false;
    }
  }
}

/** The slice of `MediaQueryList` a `system` theme listens to. */
export interface SchemeQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
}

/**
 * Paint `doc` in the chosen appearance from now on. The root's `data-theme`
 * and `data-density` select the palette and spacing in styles.css; the
 * `theme-color` and `color-scheme` metas tell the browser which palette
 * surrounds the page. A `system` theme follows `prefersLight` live. Call once
 * at boot, before anything paints.
 */
export function applyAppearance(
  appearance: AppearancePreferences,
  doc: Document = document,
  prefersLight: SchemeQuery = matchMedia(PREFERS_LIGHT),
): void {
  const root = doc.documentElement;
  const apply = (): void => {
    const theme = appearance.theme;
    const scheme: ColorScheme =
      theme === "system" ? (prefersLight.matches ? "light" : "dark") : theme;
    root.dataset.theme = theme;
    root.dataset.density = appearance.density;
    setMeta(doc, "theme-color", THEME_COLORS[scheme]);
    setMeta(doc, "color-scheme", scheme);
  };
  apply();
  prefersLight.addEventListener("change", apply);
  appearance.subscribe(apply);
}

/** Set a `<meta name>` in the head, adding it when the page has none. */
function setMeta(doc: Document, name: string, content: string): void {
  let meta = doc.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = doc.createElement("meta");
    meta.name = name;
    doc.head.append(meta);
  }
  if (meta.content !== content) meta.content = content;
}
