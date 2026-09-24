import { z } from "zod";
import {
  type TokenStorage,
  forgetSessionToken,
  hasRememberedSessionToken,
} from "./auth";

const SavedChoice = z.boolean();

const STORAGE_KEY = "omp-remote.sign-in.keep-signed-in";

/**
 * "Keep me signed in" on this device (Settings > Account). The login screen's
 * "Keep me signed in on this device" starts as this choice, and each sign-in
 * saves what was chosen there. Turning it on applies from the next sign-in;
 * turning it off forgets the remembered sign-in at once, so the next visit
 * starts at the sign-in screen while this tab stays connected until it closes.
 * Listeners hear every change.
 */
export class SignInPreferences {
  readonly #storage: TokenStorage;
  readonly #listeners = new Set<() => void>();
  #keep = false;

  /** `storage` holds the choice and the remembered sign-in it governs. */
  constructor(storage: TokenStorage) {
    this.#storage = storage;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      const saved =
        raw === null ? undefined : SavedChoice.safeParse(JSON.parse(raw));
      // Never chosen here: a device keeping a sign-in chose that at sign-in.
      this.#keep = saved?.success
        ? saved.data
        : hasRememberedSessionToken(storage);
    } catch {
      // Denied storage or malformed JSON must not prevent opening the app.
    }
  }

  get keepSignedIn(): boolean {
    return this.#keep;
  }

  /**
   * Keep this device signed in from the next sign-in on, or stop now: off
   * forgets the remembered sign-in. False when storage is unavailable and the
   * choice lasts only this page load.
   */
  setKeepSignedIn(on: boolean): boolean {
    this.#keep = on;
    for (const listener of this.#listeners) listener();
    try {
      if (!on) forgetSessionToken(this.#storage);
      this.#storage.setItem(STORAGE_KEY, JSON.stringify(on));
      return true;
    } catch {
      return false;
    }
  }

  /** Call `listener` after every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
