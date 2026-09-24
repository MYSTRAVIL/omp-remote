import { expect, test } from "bun:test";
import { firstTitle } from "../src/index";

test("firstTitle pins the first non-empty name and ignores later re-titles", () => {
  // Nothing yet: no name reported.
  expect(firstTitle(undefined, undefined)).toBeUndefined();
  // omp has not named the session — an empty name does not pin.
  expect(firstTitle(undefined, "")).toBeUndefined();
  // The first real name pins.
  expect(firstTitle(undefined, "First title")).toBe("First title");
  // Once pinned, omp's later re-titles are ignored.
  expect(firstTitle("First title", "A newer title")).toBe("First title");
  // A dropped name after pinning keeps the pin.
  expect(firstTitle("First title", undefined)).toBe("First title");
});
