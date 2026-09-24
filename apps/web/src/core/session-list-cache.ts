import type { SessionMeta } from "@omp-remote/protocol";
import { z } from "zod";

export const SESSION_LIST_KEY = "omp-remote.session-list";

/** The row fields a cold load paints before the live snapshot arrives. */
const CachedSession = z.object({
  id: z.string().min(1),
  title: z.string(),
  project: z.string(),
  cwd: z.string(),
  model: z.string(),
  startedAt: z.number(),
});
const StoredList = z.array(
  z.object({
    machineId: z.string().min(1),
    sessions: z.array(CachedSession),
  }),
);

export type CachedMachine = z.infer<typeof StoredList>[number];

/** The slice of `Storage` the cache needs; reached lazily so denied storage only loses the cache. */
export interface SessionListStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The last session list this device showed, per machine, so a cold load can
 * paint titled rows at once instead of an empty tree. It holds only row labels
 * (ids, titles, project paths, model, start time), never transcript content.
 * It is kept only for a remembered sign-in: sign-out and a sign-in the user
 * chose not to remember clear it. "Forget on this device" drops that machine's
 * entry through the store's next write.
 */
export class SessionListCache {
  readonly #storage: SessionListStorage;
  /** The last serialized list written, to skip identical writes. */
  #serialized: string | undefined;
  #persist = true;

  constructor(storage: SessionListStorage) {
    this.#storage = storage;
  }

  /** Keep the list on this device (a remembered sign-in) or not; turning it
   *  off also removes what is stored. */
  persist(on: boolean): void {
    this.#persist = on;
    if (!on) this.clear();
  }

  /** The cached list, or empty when absent, malformed or unreadable. */
  load(): CachedMachine[] {
    try {
      const raw = this.#storage.getItem(SESSION_LIST_KEY);
      if (raw === null) return [];
      const parsed = StoredList.safeParse(JSON.parse(raw));
      if (!parsed.success) return [];
      this.#serialized = raw;
      return parsed.data;
    } catch {
      return [];
    }
  }

  /** Replace the cached list with what the tree now shows. */
  save(
    machines: readonly { machineId: string; sessions: SessionMeta[] }[],
  ): void {
    if (!this.#persist) return;
    const list: CachedMachine[] = machines.map((machine) => ({
      machineId: machine.machineId,
      sessions: machine.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        project: s.project,
        cwd: s.cwd,
        model: s.model,
        startedAt: s.startedAt,
      })),
    }));
    const serialized = JSON.stringify(list);
    if (serialized === this.#serialized) return;
    try {
      this.#storage.setItem(SESSION_LIST_KEY, serialized);
      this.#serialized = serialized;
    } catch {
      // Denied or full storage: the next load simply starts without a cache.
    }
  }

  clear(): void {
    this.#serialized = undefined;
    try {
      this.#storage.removeItem(SESSION_LIST_KEY);
    } catch {
      // Nothing more to do; the entry is unreadable anyway.
    }
  }
}
