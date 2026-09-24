import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  APPEARANCE_KEY,
  AppearancePreferences,
  type SchemeQuery,
  applyAppearance,
} from "../src/core/appearance-preferences";
import { installSessionHistory } from "../src/core/history-nav";
import { type ControlHandlers, renderTree } from "../src/ui/render";
import { FakeHistory } from "./fixtures/fake-history";

// Register a DOM only for this file so happy-dom's globals never leak into the
// crypto/WebSocket-based suites in the same process.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
// Appearance persists in this device's storage.
beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-density");
});

/** Stands in for `matchMedia("(prefers-color-scheme: light)")`. */
class DeviceScheme implements SchemeQuery {
  matches = false;
  readonly #listeners = new Set<() => void>();
  addEventListener(_type: "change", listener: () => void): void {
    this.#listeners.add(listener);
  }
  /** The device switches between light and dark. */
  set(light: boolean): void {
    this.matches = light;
    for (const listener of this.#listeners) listener();
  }
}

/** What the page tells the browser about itself, and what styles.css keys on. */
function painted() {
  const root = document.documentElement;
  const meta = (name: string): string | undefined =>
    document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
      ?.content;
  return {
    theme: root.dataset.theme,
    density: root.dataset.density,
    themeColor: meta("theme-color"),
    colorScheme: meta("color-scheme"),
  };
}

test("appearance defaults to dark and comfortable, and each choice outlasts a reload", () => {
  const first = new AppearancePreferences();
  expect([first.theme, first.density]).toEqual(["dark", "comfortable"]);

  expect(first.setTheme("light")).toBe(true);
  expect(first.setDensity("compact")).toBe(true);

  const reloaded = new AppearancePreferences();
  expect([reloaded.theme, reloaded.density]).toEqual(["light", "compact"]);
});

test("a malformed stored appearance falls back field by field", () => {
  localStorage.setItem(
    APPEARANCE_KEY,
    JSON.stringify({ theme: "neon", density: "compact" }),
  );
  const partial = new AppearancePreferences();
  expect([partial.theme, partial.density]).toEqual(["dark", "compact"]);

  localStorage.setItem(APPEARANCE_KEY, "{not json");
  const unreadable = new AppearancePreferences();
  expect([unreadable.theme, unreadable.density]).toEqual([
    "dark",
    "comfortable",
  ]);
});

test("the document takes the chosen theme and density at once; System follows the device live", () => {
  const appearance = new AppearancePreferences();
  const device = new DeviceScheme();
  applyAppearance(appearance, document, device);
  expect(painted()).toEqual({
    theme: "dark",
    density: "comfortable",
    themeColor: "#000000",
    colorScheme: "dark",
  });

  appearance.setTheme("light");
  appearance.setDensity("compact");
  expect(painted()).toEqual({
    theme: "light",
    density: "compact",
    themeColor: "#f7f5f0",
    colorScheme: "light",
  });

  // An explicit choice ignores the device; System follows it as it changes.
  device.set(true);
  appearance.setTheme("dark");
  expect(painted().colorScheme).toBe("dark");
  appearance.setTheme("system");
  expect(painted()).toMatchObject({
    theme: "system",
    themeColor: "#f7f5f0",
    colorScheme: "light",
  });
  device.set(false);
  expect(painted()).toMatchObject({
    theme: "system",
    themeColor: "#000000",
    colorScheme: "dark",
  });
});

test("Settings > Appearance repaints at once and saves the choice; its section follows Chat, before About", () => {
  const appearance = new AppearancePreferences();
  applyAppearance(appearance, document, new DeviceScheme());
  const history = new FakeHistory();
  const nav = installSessionHistory({
    history,
    select: () => {},
    onPopState: (handler) => history.onPop(handler),
  });
  const handlers: ControlHandlers = {
    onSelect: (id) => nav.open(id),
    onBack: () => nav.back(),
    onOverlay: (close) => nav.overlay(close),
    onPrompt: async () => true,
    onInterrupt: async () => true,
    onServiceTier: async () => true,
    onSetModel: async () => true,
    onSetThinkingLevel: async () => true,
    onCompact: async () => true,
    onCloseSession: async () => true,
    onUpload: async () => "resource",
    onSpawn: async () => true,
    onCancelSpawn: () => {},
    onInteractionReply: async () => true,
    onRenameMachine: () => true,
    appearance,
  };
  const root = document.createElement("div");
  document.body.append(root);
  renderTree(root, [{ machineId: "m1", label: "m1", projects: [] }], handlers);
  [...root.querySelectorAll("button")]
    .find((node) => node.textContent === "Settings")
    ?.click();
  const settings = root.querySelector<HTMLDialogElement>("dialog[open]");
  if (!settings) throw new Error("Settings did not open");

  const sections = [...settings.querySelectorAll("h3")]
    .filter((node) => node.closest("[hidden]") === null)
    .map((node) => node.textContent);
  expect(sections).toEqual([
    "Machines",
    "Projects",
    "New sessions",
    "Chat",
    "Appearance",
    "About",
  ]);

  const choose = (label: string, text: string): void => {
    const select = [...settings.querySelectorAll("select")].find(
      (node) => node.labels?.[0]?.textContent === label,
    );
    const option = [...(select?.options ?? [])].find(
      (node) => node.textContent === text,
    );
    if (!select || !option) throw new Error(`no "${text}" in "${label}"`);
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
  choose("Theme", "Light");
  choose("Density", "Compact");
  expect(painted()).toMatchObject({
    theme: "light",
    density: "compact",
    themeColor: "#f7f5f0",
  });
  const saved = new AppearancePreferences();
  expect([saved.theme, saved.density]).toEqual(["light", "compact"]);
});
