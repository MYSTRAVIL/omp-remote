import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PushPreferences } from "../src/core/push-preferences";
import { readQuietWhileOpen } from "../src/core/sw-caches";
import { fakeCaches } from "./fixtures/fake-push";

// Register a DOM only for this file (for localStorage) so happy-dom's globals
// never leak into the crypto/WebSocket-based suites in the same process.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => localStorage.clear());

const PREFERENCES_KEY = "omp-remote.push.preferences";

test("push starts on, and quiet while the app is open", () => {
  const prefs = new PushPreferences();
  expect(prefs.enabled).toBe(true);
  expect(prefs.quietWhileOpen).toBe(true);
});

test("both choices survive a reload", () => {
  const prefs = new PushPreferences();
  expect(prefs.setQuietWhileOpen(false)).toBe(true);
  prefs.setEnabled(false);

  const reloaded = new PushPreferences();
  expect(reloaded.enabled).toBe(false);
  expect(reloaded.quietWhileOpen).toBe(false);
});

test("a damaged saved value keeps what parses and defaults the rest", () => {
  localStorage.setItem(
    PREFERENCES_KEY,
    JSON.stringify({ enabled: false, quietWhileOpen: 7 }),
  );
  const prefs = new PushPreferences();
  expect(prefs.enabled).toBe(false);
  expect(prefs.quietWhileOpen).toBe(true);

  localStorage.setItem(PREFERENCES_KEY, "{not json");
  expect(new PushPreferences().enabled).toBe(true);
});

test("the service worker reads the quiet choice saved before this page load, and each change after", async () => {
  // Saved by an earlier page load, where no worker copy was made.
  new PushPreferences().setQuietWhileOpen(false);
  const worker = fakeCaches();
  const booted = worker.written();
  const prefs = new PushPreferences(worker.caches);
  await booted;
  expect(await readQuietWhileOpen(worker.caches)).toBe(false);

  const changed = worker.written();
  prefs.setQuietWhileOpen(true);
  await changed;
  expect(await readQuietWhileOpen(worker.caches)).toBe(true);
});

test("a change in one window keeps the other choice another window saved since", () => {
  const stale = new PushPreferences();
  new PushPreferences().setQuietWhileOpen(false);

  stale.setEnabled(false);

  const reloaded = new PushPreferences();
  expect(reloaded.enabled).toBe(false);
  expect(reloaded.quietWhileOpen).toBe(false);
});
