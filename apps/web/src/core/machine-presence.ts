import { z } from "zod";

/** `localStorage` key holding when this device last saw each machine online. */
export const MACHINE_PRESENCE_KEY = "omp-remote.machine-last-seen";

const StoredPresence = z.record(z.string().min(1), z.number());

/** Minute resolution: recording every streamed frame would only rewrite storage. */
const RECORD_EVERY_MS = 60_000;

/** The slice of `Storage` used here; production passes `localStorage`. */
export interface PresenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * When THIS browser last saw each machine online (epoch ms), keyed by
 * machineId: the last relay machine list naming it, or the last frame it sent.
 * The relay never tells a connected phone that a machine left, so this is the
 * latest evidence, not a disconnect time. It never leaves the browser; the
 * user's other devices keep their own.
 */
export class MachinePresence {
  readonly #storage: PresenceStorage;
  readonly #seen = new Map<string, number>();

  constructor(storage: PresenceStorage) {
    this.#storage = storage;
    try {
      const raw = storage.getItem(MACHINE_PRESENCE_KEY);
      if (raw === null) return;
      const parsed = StoredPresence.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      for (const [machineId, at] of Object.entries(parsed.data))
        this.#seen.set(machineId, at);
    } catch {
      // Denied storage or malformed JSON: no machine has been seen yet.
    }
  }

  /** When this browser last saw the machine online, or undefined if it never has. */
  lastSeen(machineId: string): number | undefined {
    return this.#seen.get(machineId);
  }

  /** Note the machines seen online at `now`. */
  observe(machineIds: Iterable<string>, now: number): void {
    let changed = false;
    for (const machineId of machineIds) {
      const last = this.#seen.get(machineId);
      if (last !== undefined && Math.abs(now - last) < RECORD_EVERY_MS)
        continue;
      this.#seen.set(machineId, now);
      changed = true;
    }
    if (changed) this.#persist();
  }

  forget(machineId: string): void {
    if (this.#seen.delete(machineId)) this.#persist();
  }

  #persist(): void {
    try {
      this.#storage.setItem(
        MACHINE_PRESENCE_KEY,
        JSON.stringify(Object.fromEntries(this.#seen)),
      );
    } catch {
      // The in-memory record still serves this page load.
    }
  }
}
