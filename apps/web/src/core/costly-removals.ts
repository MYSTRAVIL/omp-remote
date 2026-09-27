/**
 * The clears that left none of this app's notifications showing with no
 * window of it on screen, counted over the last day so the service worker
 * spends no more of Chromium's silent-push budget than a day earns (see
 * `clearSession` in core/sw-push). The record lives in the prefs cache the
 * page shares, so it survives the worker being stopped between pushes.
 */

import { z } from "zod";
import { type CacheStorageLike, PREFS_CACHE } from "./sw-caches";

/**
 * How many clears a day may leave no notification showing with no window on
 * screen; past it a clear leaves one saying its session no longer waits.
 * Chromium charges such a push 2 from the site's budget, which earns at most
 * 12 a day (a site at full engagement) in chunks that expire after 4 days,
 * and once it is spent shows its own "This site has been updated in the
 * background" notification (`kMaximumHourlyBudget`, `kBudgetDurationInDays`
 * in chrome/browser/push_messaging/budget_database.cc). Five stays under the
 * six a day that earns, so the budget never runs out at full engagement.
 */
export const COSTLY_REMOVALS_PER_DAY = 5;

/** How long a costly removal counts against the cap. */
const COUNTED_FOR_MS = 24 * 60 * 60 * 1000;

/** The costly removals counted: JSON `[epochMs]`, oldest first, at most the cap. */
const COSTLY_REMOVALS_URL = "/__prefs/costly-removals";

const StoredRemovals = z.array(z.number());

/**
 * The count, as the worker sees it. Each clear runs its removal through
 * `remove`, one at a time, so two clears landing together neither lose a
 * count nor both see the other's notification still showing.
 */
export class CostlyRemovals {
  readonly #caches: CacheStorageLike;
  #queue: Promise<void> = Promise.resolve();

  constructor(caches: CacheStorageLike) {
    this.#caches = caches;
  }

  /**
   * Run one clear's `removal` once every earlier one has finished. It is told
   * whether fewer than {@link COSTLY_REMOVALS_PER_DAY} costly removals were
   * counted in the day up to `now`, and resolves true when it made one, which
   * is then counted at `now`. Storage that can't be read counts as the cap
   * reached, so a clear leaves a notification as it did before the count; a
   * damaged record counts as none. A count that can't be written is lost.
   */
  remove(
    now: number,
    removal: (underCap: boolean) => Promise<boolean>,
  ): Promise<void> {
    const run = this.#queue.then(async () => {
      const counted = await this.#read(now).catch(() => undefined);
      const costly = await removal(
        counted !== undefined && counted.length < COSTLY_REMOVALS_PER_DAY,
      );
      if (!costly || counted === undefined) return;
      counted.push(now);
      await this.#write(counted.slice(-COSTLY_REMOVALS_PER_DAY)).catch(() => {
        // Storage the worker can't write: this removal goes uncounted.
      });
    });
    this.#queue = run.catch(() => {
      // The removal failed: its push fails, and the next clear still runs.
    });
    return run;
  }

  /** The costly removals counted in the day up to `now`. */
  async #read(now: number): Promise<number[]> {
    const prefs = await this.#caches.open(PREFS_CACHE);
    const saved = await (await prefs.match(COSTLY_REMOVALS_URL))?.text();
    if (saved === undefined) return [];
    try {
      const parsed = StoredRemovals.safeParse(JSON.parse(saved));
      if (!parsed.success) return [];
      return parsed.data.filter((at) => at > now - COUNTED_FOR_MS);
    } catch {
      // Not JSON: a damaged save counts as none.
      return [];
    }
  }

  async #write(removals: readonly number[]): Promise<void> {
    const prefs = await this.#caches.open(PREFS_CACHE);
    await prefs.put(
      COSTLY_REMOVALS_URL,
      new Response(JSON.stringify(removals)),
    );
  }
}
