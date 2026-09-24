import { z } from "zod";

/** What to do when a new service worker takes control of the page. */
export type UpdateAction = "reload" | "prompt";

/** Reload into the new build at once, unless that would lose an unsent draft
 *  or tear down an open passkey prompt (the sign-in would fail and need a
 *  second try): then offer the reload and let the user pick the moment. */
export function decideUpdateAction(state: {
  hasDraft: boolean;
  passkeyOpen: boolean;
}): UpdateAction {
  return state.hasDraft || state.passkeyOpen ? "prompt" : "reload";
}

/** `sessionStorage` key set just before an update reload; the next load
 *  consumes it and says which build is now running. */
export const UPDATE_RELOADED_KEY = "omp-remote.update-reloaded";

const Marker = z.literal("1");

/** The slice of `Storage` the marker needs; production passes `sessionStorage`. */
export interface MarkerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Leave the one-shot marker for the load that follows an update reload. */
export function markUpdateReload(storage: MarkerStorage): void {
  try {
    storage.setItem(UPDATE_RELOADED_KEY, "1");
  } catch {
    // Denied storage: the reload still happens, only its toast is lost.
  }
}

/** True once per update reload: reads and removes the marker. */
export function takeUpdateReload(storage: MarkerStorage): boolean {
  try {
    const raw = storage.getItem(UPDATE_RELOADED_KEY);
    if (raw === null) return false;
    storage.removeItem(UPDATE_RELOADED_KEY);
    return Marker.safeParse(raw).success;
  } catch {
    return false;
  }
}

/** `localStorage` key: the builds this browser updated to, newest first. */
export const UPDATE_HISTORY_KEY = "omp-remote.update-history";

/** How many of the latest updates the history keeps (Settings > About). */
export const UPDATE_HISTORY_LIMIT = 10;

const UpdateRecord = z.object({ sha: z.string().min(1), at: z.number() });
/** One update this browser reloaded into: the new build's id, and when (epoch ms). */
export type UpdateRecord = z.infer<typeof UpdateRecord>;

/** The slice of `Storage` the history needs; production passes `localStorage`. */
export interface HistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The builds this browser updated to, newest first. An entry that does not
 * parse is dropped on its own; unreadable storage reads as no history.
 */
export function readUpdateHistory(storage: HistoryStorage): UpdateRecord[] {
  try {
    const raw = storage.getItem(UPDATE_HISTORY_KEY);
    if (raw === null) return [];
    const entries = z.array(z.unknown()).safeParse(JSON.parse(raw));
    if (!entries.success) return [];
    const history: UpdateRecord[] = [];
    for (const entry of entries.data) {
      const parsed = UpdateRecord.safeParse(entry);
      if (parsed.success) history.push(parsed.data);
    }
    return history.slice(0, UPDATE_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** Note that this browser updated to `sha` at `at`, keeping the latest few. */
export function recordUpdate(
  storage: HistoryStorage,
  sha: string,
  at: number,
): void {
  const history = [{ sha, at }, ...readUpdateHistory(storage)].slice(
    0,
    UPDATE_HISTORY_LIMIT,
  );
  try {
    storage.setItem(UPDATE_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Denied storage: the update still shows its toast; only the record is lost.
  }
}
