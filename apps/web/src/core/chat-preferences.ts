import { z } from "zod";

const TextSize = z.enum(["small", "default", "large"]);
export type ChatTextSize = z.infer<typeof TextSize>;

const STORAGE_KEY = "omp-remote.chat.preferences";

/** Each field falls back on its own, so one unknown value never resets the rest. */
const StoredChat = z.object({
  autoScroll: z.boolean().catch(true),
  textSize: TextSize.catch("default"),
  timestamps: z.boolean().catch(false),
  thinkingExpanded: z.boolean().catch(false),
  toolOutputExpanded: z.boolean().catch(false),
});
type StoredChat = z.infer<typeof StoredChat>;

/**
 * How every session's conversation reads in this browser. Views subscribe, so
 * a change applies to open sessions at once, without a reload.
 */
export class ChatPreferences {
  #values: StoredChat = StoredChat.parse({});
  readonly #listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const parsed = StoredChat.safeParse(JSON.parse(raw));
      if (parsed.success) this.#values = parsed.data;
    } catch {
      // Denied storage or malformed JSON must not prevent opening the workspace.
    }
  }

  /** Keep a reader at the newest message as content arrives. */
  get autoScroll(): boolean {
    return this.#values.autoScroll;
  }

  get textSize(): ChatTextSize {
    return this.#values.textSize;
  }

  /** Show the host's time on each message that carries one. */
  get timestamps(): boolean {
    return this.#values.timestamps;
  }

  /** Thinking blocks start open. */
  get thinkingExpanded(): boolean {
    return this.#values.thinkingExpanded;
  }

  /** Tool cards start with their output open. */
  get toolOutputExpanded(): boolean {
    return this.#values.toolOutputExpanded;
  }

  setAutoScroll(on: boolean): boolean {
    return this.#commit({ ...this.#values, autoScroll: on });
  }

  setTextSize(size: ChatTextSize): boolean {
    return this.#commit({ ...this.#values, textSize: size });
  }

  setTimestamps(on: boolean): boolean {
    return this.#commit({ ...this.#values, timestamps: on });
  }

  setThinkingExpanded(on: boolean): boolean {
    return this.#commit({ ...this.#values, thinkingExpanded: on });
  }

  setToolOutputExpanded(on: boolean): boolean {
    return this.#commit({ ...this.#values, toolOutputExpanded: on });
  }

  /** Call `listener` after every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Apply at once; false when storage is unavailable and the choice lasts only this page load. */
  #commit(values: StoredChat): boolean {
    this.#values = values;
    for (const listener of this.#listeners) listener();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
      return true;
    } catch {
      return false;
    }
  }
}
