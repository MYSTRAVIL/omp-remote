/// <reference lib="dom" />
import { z } from "zod";
import {
  type CacheStorageLike,
  QUIET_WHILE_OPEN_DEFAULT,
  saveQuietWhileOpen,
} from "./sw-caches";

const STORAGE_KEY = "omp-remote.push.preferences";

/** Each field falls back on its own, so one unknown value never resets the other. */
const StoredPush = z.object({
  enabled: z.boolean().catch(true),
  quietWhileOpen: z.boolean().catch(QUIET_WHILE_OPEN_DEFAULT),
});
type StoredPush = z.infer<typeof StoredPush>;

/**
 * This device's push choices, kept in this browser and never sent anywhere:
 * whether it gets pushes at all, and whether they stay quiet while the app is
 * on screen. The service worker applies the quiet choice on every push but
 * has no localStorage, so the choice is copied into Cache Storage for it at
 * construction and after every change. Listeners hear every change.
 */
export class PushPreferences {
  #values: StoredPush = StoredPush.parse({});
  readonly #listeners = new Set<() => void>();
  /** Where the service worker reads the quiet choice; undefined where there is none. */
  readonly #caches: CacheStorageLike | undefined;
  /** The last copy for the service worker; each copy waits for the one before. */
  #copied = Promise.resolve();

  /** `caches`: where the service worker reads the quiet choice. */
  constructor(caches?: CacheStorageLike) {
    this.#caches = caches;
    this.#values = this.#stored();
    // A choice saved before the worker could read it reaches the worker now.
    this.#copyForWorker();
  }

  /** Push notifications are on for this device. */
  get enabled(): boolean {
    return this.#values.enabled;
  }

  /** The service worker hides pushes while the app is on screen here. */
  get quietWhileOpen(): boolean {
    return this.#values.quietWhileOpen;
  }

  setEnabled(on: boolean): boolean {
    return this.#commit({ ...this.#stored(), enabled: on });
  }

  setQuietWhileOpen(on: boolean): boolean {
    return this.#commit({ ...this.#stored(), quietWhileOpen: on });
  }

  /** Call `listener` after every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * The choices as saved now. Another window of the app may have changed one
   * since this page loaded, so each setter merges into these and changes only
   * its own field. Falls back to this page's copy when storage is unreadable.
   */
  #stored(): StoredPush {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed =
        raw === null ? undefined : StoredPush.safeParse(JSON.parse(raw));
      if (parsed?.success) return parsed.data;
    } catch {
      // Denied storage or malformed JSON must not prevent opening the workspace.
    }
    return this.#values;
  }

  /** Apply at once; false when storage is unavailable and the choice lasts only this page load. */
  #commit(values: StoredPush): boolean {
    this.#values = values;
    for (const listener of this.#listeners) listener();
    this.#copyForWorker();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Copy the quiet choice to where the service worker reads it. Copies run
   * one at a time, each writing the choice as it stands when it runs, so the
   * newest choice is the one left.
   */
  #copyForWorker(): void {
    const caches = this.#caches;
    if (caches === undefined) return;
    this.#copied = this.#copied
      .then(() => saveQuietWhileOpen(caches, this.#values.quietWhileOpen))
      .catch(() => {
        // Unwritable: the worker keeps the copy it has, or the default.
      });
  }
}
