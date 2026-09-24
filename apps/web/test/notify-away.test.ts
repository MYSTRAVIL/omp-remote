import { expect, test } from "bun:test";
import {
  DEFAULT_AWAY_SEC,
  NOTIFY_AWAY_KEY,
  NotifyAway,
} from "../src/core/notify-away";

/** `localStorage` as a map; `denied` makes every write throw, as a full or blocked store does. */
function memoryStorage(initial: Record<string, string> = {}, denied = false) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (denied) throw new DOMException("quota", "QuotaExceededError");
      items.set(key, value);
    },
  };
}

test("a machine never chosen for waits two minutes; a choice survives a reload", () => {
  const storage = memoryStorage();
  const away = new NotifyAway(storage);
  expect(away.awaySec("m1")).toBe(DEFAULT_AWAY_SEC);
  expect(DEFAULT_AWAY_SEC).toBe(120);
  expect(away.set("m1", 0)).toBe(true);
  expect(new NotifyAway(storage).awaySec("m1")).toBe(0);
  expect(new NotifyAway(storage).awaySec("m2")).toBe(120);
});

test("a damaged saved value resets only its own machine", () => {
  const away = new NotifyAway(
    memoryStorage({
      [NOTIFY_AWAY_KEY]: JSON.stringify({ m1: 300, m2: -5, m3: "60", m4: 1.5 }),
    }),
  );
  expect(["m1", "m2", "m3", "m4"].map((id) => away.awaySec(id))).toEqual([
    300, 120, 120, 120,
  ]);
  expect(
    new NotifyAway(memoryStorage({ [NOTIFY_AWAY_KEY]: "{not json" })).awaySec(
      "m1",
    ),
  ).toBe(120);
});

test("without writable storage a choice holds for this page load only", () => {
  const away = new NotifyAway(memoryStorage({}, true));
  expect(away.set("m1", 600)).toBe(false);
  expect(away.awaySec("m1")).toBe(600);
});
