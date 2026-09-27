/**
 * The session notifications the user dismissed while they still said the
 * session waits, which the page reports to each session's machine. A machine
 * sends a clear for every notice it pushed unless told the phone closed it
 * (`noticeSeen`), and a clear finding nothing to close is a push that shows
 * nothing (see `clearSession` in core/sw-push). The service worker sees the
 * dismissal (`reportDismissed`) but holds no sealed channel, so it records it
 * in the prefs cache the page shares; the page tells the machine once its
 * channel is ready, then forgets it.
 */

import type { SealedFrame } from "@omp-remote/protocol";
import { z } from "zod";
import { type CacheStorageLike, PREFS_CACHE } from "./sw-caches";
import { NotificationTarget } from "./sw-push";

/** The dismissals not yet reported: JSON `[{machineId, sessionId}]`, oldest first. */
const DISMISSED_NOTICES_URL = "/__prefs/dismissed-notices";
/**
 * How many dismissals are kept; past it the oldest goes, and its machine
 * then sends a clear that could have been spared. A machine this device no
 * longer pairs with is never told, so its dismissals wait here until pushed out.
 */
export const DISMISSED_NOTICES_MAX = 32;

const StoredDismissals = z.array(NotificationTarget);

/** The machines a report reaches: a `PhoneClient`. */
export interface SeenReceivers {
  /** The machine's channel is ready on this socket (see `PhoneClient.channelReady`). */
  channelReady(machineId: string): boolean;
  channelFor(
    machineId: string,
  ): { sendFrame(frame: SealedFrame): void } | undefined;
}

/**
 * The record, as one context (the page, or the worker) sees it. Each change
 * reads and rewrites it; one context's changes run one at a time, so the
 * worker's dismissals from one "clear all" all land. Storage that can't be
 * read or written loses the change: its machine sends a clear as before.
 */
export class DismissedNotices {
  readonly #caches: CacheStorageLike;
  #queue: Promise<void> = Promise.resolve();

  constructor(caches: CacheStorageLike) {
    this.#caches = caches;
  }

  /** The user dismissed this session's notification: keep it, newest last. */
  record(target: NotificationTarget): Promise<void> {
    return this.#run(async () => {
      const kept = (await this.#read()).filter(
        (entry) =>
          entry.machineId !== target.machineId ||
          entry.sessionId !== target.sessionId,
      );
      kept.push({ machineId: target.machineId, sessionId: target.sessionId });
      await this.#write(kept.slice(-DISMISSED_NOTICES_MAX));
    });
  }

  /** A new notice for the session supersedes its dismissal: drop it. */
  forget(target: NotificationTarget): Promise<void> {
    return this.#run(async () => {
      const saved = await this.#read();
      const kept = saved.filter(
        (entry) =>
          entry.machineId !== target.machineId ||
          entry.sessionId !== target.sessionId,
      );
      if (kept.length !== saved.length) await this.#write(kept);
    });
  }

  /**
   * Tell each machine whose channel is ready now that the user dismissed its
   * session's notification (`noticeSeen`), and forget those dismissals. The
   * rest wait for the next report.
   */
  report(machines: SeenReceivers): Promise<void> {
    return this.#run(async () => {
      const saved = await this.#read();
      const kept: NotificationTarget[] = [];
      for (const entry of saved) {
        const channel = machines.channelReady(entry.machineId)
          ? machines.channelFor(entry.machineId)
          : undefined;
        if (channel === undefined) kept.push(entry);
        else channel.sendFrame({ t: "noticeSeen", sessionId: entry.sessionId });
      }
      if (kept.length !== saved.length) await this.#write(kept);
    });
  }

  #run(change: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(change).catch(() => {
      // Storage the context can't read or write: the change is lost.
    });
    this.#queue = run;
    return run;
  }

  /** The dismissals saved; none when never saved or damaged. */
  async #read(): Promise<NotificationTarget[]> {
    const prefs = await this.#caches.open(PREFS_CACHE);
    const saved = await (await prefs.match(DISMISSED_NOTICES_URL))?.text();
    if (saved === undefined) return [];
    try {
      const parsed = StoredDismissals.safeParse(JSON.parse(saved));
      return parsed.success ? parsed.data : [];
    } catch {
      // Not JSON: a damaged save counts as none.
      return [];
    }
  }

  async #write(dismissals: readonly NotificationTarget[]): Promise<void> {
    const prefs = await this.#caches.open(PREFS_CACHE);
    await prefs.put(
      DISMISSED_NOTICES_URL,
      new Response(JSON.stringify(dismissals)),
    );
  }
}
