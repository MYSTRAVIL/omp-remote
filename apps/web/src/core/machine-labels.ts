import { z } from "zod";

/** `localStorage` key holding the names given to machines on this device. */
export const MACHINE_LABELS_KEY = "omp-remote.machine-labels";

const StoredLabels = z.record(z.string(), z.string());

/** The slice of `Storage` used here; production passes `localStorage`. */
export interface LabelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Names the user gave machines on THIS device, keyed by machineId. They never
 * leave the browser: the host, the relay and the user's other devices keep the
 * machineId. A missing or malformed stored map reads as "no names", never a
 * crash, so every machine falls back to its default name.
 */
export class MachineLabels {
  readonly #storage: LabelStorage;
  readonly #labels = new Map<string, string>();

  constructor(storage: LabelStorage) {
    this.#storage = storage;
    try {
      const raw = storage.getItem(MACHINE_LABELS_KEY);
      if (raw === null) return;
      const parsed = StoredLabels.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      for (const [machineId, label] of Object.entries(parsed.data)) {
        const name = label.trim();
        if (name) this.#labels.set(machineId, name);
      }
    } catch {
      // Denied storage or malformed JSON: machines keep their default names.
    }
  }

  /** Every name given on this device, keyed by machineId. */
  get names(): ReadonlyMap<string, string> {
    return this.#labels;
  }

  /**
   * Name a machine on this device; a blank name (or its own machineId)
   * restores the default. Returns false when browser storage is unavailable:
   * the name then holds only until the page reloads.
   */
  rename(machineId: string, label: string): boolean {
    const name = label.trim();
    if (name && name !== machineId) this.#labels.set(machineId, name);
    else this.#labels.delete(machineId);
    try {
      this.#storage.setItem(
        MACHINE_LABELS_KEY,
        JSON.stringify(Object.fromEntries(this.#labels)),
      );
      return true;
    } catch {
      return false;
    }
  }
}
