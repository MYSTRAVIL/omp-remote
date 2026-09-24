/// <reference lib="dom" />
import type {
  AppearanceDensity,
  AppearancePreferences,
  AppearanceTheme,
} from "../core/appearance-preferences";
import { type Choice, preferenceDropdown } from "./choices";
import { element, setText, uniqueId } from "./dom";

const THEMES: readonly Choice<AppearanceTheme>[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];
const DENSITIES: readonly Choice<AppearanceDensity>[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

/**
 * Settings > Appearance: the theme and density of this browser. A choice
 * repaints the whole app at once; each dropdown always shows what is saved.
 */
export class AppearanceSettings {
  readonly node = element("section", "settings-section appearance-settings");
  readonly #status = element("p", "field-hint preference-status");
  readonly #syncs: (() => void)[] = [];

  constructor(appearance: AppearancePreferences) {
    this.#status.setAttribute("role", "status");
    const heading = element("h3", "section-title", "Appearance");
    heading.id = uniqueId("settings-section");
    this.node.setAttribute("aria-labelledby", heading.id);
    const theme = preferenceDropdown(
      "Theme",
      THEMES,
      () => appearance.theme,
      (value) => appearance.setTheme(value),
      this.#status,
      "System follows this device's light or dark setting as it changes.",
    );
    const density = preferenceDropdown(
      "Density",
      DENSITIES,
      () => appearance.density,
      (value) => appearance.setDensity(value),
      this.#status,
      "Compact tightens the session list, settings and the conversation.",
    );
    this.#syncs.push(theme.sync, density.sync);
    this.node.append(
      heading,
      element(
        "p",
        "section-copy",
        "These apply to this browser, right away. Your other devices keep their own.",
      ),
      theme.node,
      density.node,
      this.#status,
    );
  }

  /** Settings reopened: the saved choices, and no outcome from last time. */
  reset(): void {
    for (const sync of this.#syncs) sync();
    setText(this.#status, "");
  }
}
