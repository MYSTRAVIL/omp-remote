import { NotifyPolicyFrame } from "@omp-remote/protocol";
import { z } from "zod";

/** `localStorage` key holding each machine's away time: JSON `{[machineId]: awaySec}`. */
export const NOTIFY_AWAY_KEY = "omp-remote.notify.away";
/** A machine's away time until one is chosen on this device, as the agent's own default. */
export const DEFAULT_AWAY_SEC = 120;

/** Each value is checked on its own, so one damaged entry never resets the others. */
const StoredAway = z.record(z.string(), z.unknown());
const AwaySec = NotifyPolicyFrame.shape.awaySec;

/** The slice of `Storage` used here; production passes `localStorage`. */
export interface AwayStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * How long the user must be away from each machine (no keyboard or mouse
 * input) before it pushes a notification, chosen on THIS device (Settings >
 * Machines) and sent to the machine on every connect as `notifyPolicy`. A
 * machine never chosen for, or whose saved value is damaged, gets the default.
 */
export class NotifyAway {
  readonly #storage: AwayStorage;
  readonly #away = new Map<string, number>();

  constructor(storage: AwayStorage) {
    this.#storage = storage;
    try {
      const raw = storage.getItem(NOTIFY_AWAY_KEY);
      if (raw === null) return;
      const parsed = StoredAway.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      for (const [machineId, value] of Object.entries(parsed.data)) {
        const awaySec = AwaySec.safeParse(value);
        if (awaySec.success) this.#away.set(machineId, awaySec.data);
      }
    } catch {
      // Denied storage or malformed JSON: every machine gets the default.
    }
  }

  /** Seconds away from `machineId` before it pushes; `0` pushes always. */
  awaySec(machineId: string): number {
    return this.#away.get(machineId) ?? DEFAULT_AWAY_SEC;
  }

  /**
   * Choose `machineId`'s away time. Returns false when browser storage is
   * unavailable: the choice then holds only until the page reloads.
   */
  set(machineId: string, awaySec: number): boolean {
    this.#away.set(machineId, AwaySec.parse(awaySec));
    try {
      this.#storage.setItem(
        NOTIFY_AWAY_KEY,
        JSON.stringify(Object.fromEntries(this.#away)),
      );
      return true;
    } catch {
      return false;
    }
  }
}
