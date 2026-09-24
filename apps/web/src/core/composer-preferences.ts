import { z } from "zod";

const SendMode = z.enum(["followUp", "steer"]);
export type ComposerSendMode = z.infer<typeof SendMode>;

const STORAGE_KEY = "omp-remote.composer.send-mode";

/** One workspace-owned choice; drafts and pairing data never enter this key. */
export class ComposerPreferences {
  #mode: ComposerSendMode = "followUp";

  constructor() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const parsed = SendMode.safeParse(JSON.parse(raw));
      if (parsed.success) this.#mode = parsed.data;
    } catch {
      // Denied storage or malformed JSON must not prevent opening the workspace.
    }
  }

  get mode(): ComposerSendMode {
    return this.#mode;
  }

  setMode(mode: ComposerSendMode): boolean {
    this.#mode = mode;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(mode));
      return true;
    } catch {
      // Keep the current choice in memory even when persistence is unavailable.
      return false;
    }
  }
}
