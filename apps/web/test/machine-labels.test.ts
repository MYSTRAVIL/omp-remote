import { expect, test } from "bun:test";
import { MACHINE_LABELS_KEY, MachineLabels } from "../src/core/machine-labels";
import { AppStore } from "../src/core/store";

/** A Map-backed `localStorage` stand-in that outlives any one reader. */
function storage(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
} {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

test("a name given on this device survives a reload and shows in the tree; an empty name restores the machine ID", () => {
  const browser = storage();
  expect(new MachineLabels(browser).rename("m1", "  Desk  ")).toBe(true);

  // A fresh read of storage, as on the next page load.
  const store = new AppStore();
  store.setMachineList(["m1", "m2"]);
  store.setMachineLabels(new MachineLabels(browser).names);
  expect(store.tree().map((m) => [m.machineId, m.label])).toEqual([
    ["m1", "Desk"],
    ["m2", "m2"],
  ]);

  new MachineLabels(browser).rename("m1", "");
  store.setMachineLabels(new MachineLabels(browser).names);
  expect(store.tree().map((m) => m.label)).toEqual(["m1", "m2"]);
});

test("unreadable stored names fall back to machine IDs", () => {
  for (const raw of [
    "not json",
    JSON.stringify(["Desk"]),
    JSON.stringify({ m1: 5 }),
  ]) {
    const labels = new MachineLabels({
      getItem: (key) => (key === MACHINE_LABELS_KEY ? raw : null),
      setItem: () => {},
    });
    const store = new AppStore();
    store.setMachineList(["m1"]);
    store.setMachineLabels(labels.names);
    expect(store.tree().map((m) => m.label)).toEqual(["m1"]);
  }
});
