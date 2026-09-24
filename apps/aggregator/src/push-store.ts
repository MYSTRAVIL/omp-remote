import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeFileAtomic } from "./atomic-write";
import { PushSubscription } from "./vapid";

/**
 * A stored subscription, with the session-token epoch of the sign-in that
 * made it. Absent: made with no auth gate, or stored before epochs were
 * recorded — it stays until the next sign-out-everywhere retires it.
 */
export const StoredPushSubscription = PushSubscription.extend({
  ep: z.number().int().nonnegative().optional(),
});
export type StoredPushSubscription = z.infer<typeof StoredPushSubscription>;

const StoreShape = z.object({
  subscriptions: z.array(StoredPushSubscription),
});
type StoreShape = z.infer<typeof StoreShape>;

const FILE_MODE = 0o600;

/**
 * On-disk store of the PWA's Web Push subscriptions for the single-user
 * aggregator. Written owner-only (mode 0600) because a subscription endpoint +
 * its encryption keys are capabilities to wake the user's device. This holds NO
 * session content — only push routing material (spec §4.3, content-blind §7).
 * Subscriptions are keyed by `endpoint`; re-subscribing the same endpoint
 * replaces rather than duplicates.
 */
export class PushSubscriptionStore {
  readonly #path: string;
  #data: StoreShape;
  /** Settles when the last queued write does; the next write starts after it. */
  #writes: Promise<void> = Promise.resolve();

  private constructor(path: string, data: StoreShape) {
    this.#path = path;
    this.#data = data;
  }

  /**
   * Load the store from `path`, or initialise an empty one if the file does not
   * yet exist. A corrupt file throws rather than silently discarding devices.
   */
  static async load(path: string): Promise<PushSubscriptionStore> {
    let raw: string | undefined;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (raw === undefined) {
      const store = new PushSubscriptionStore(path, { subscriptions: [] });
      await store.#persist();
      return store;
    }
    return new PushSubscriptionStore(path, StoreShape.parse(JSON.parse(raw)));
  }

  list(): readonly StoredPushSubscription[] {
    return this.#data.subscriptions;
  }

  /**
   * Add a subscription made by a sign-in of token epoch `epoch` (none without
   * an auth gate), replacing any existing one with the same endpoint.
   */
  async add(sub: PushSubscription, epoch?: number): Promise<void> {
    this.#data.subscriptions = this.#data.subscriptions.filter(
      (s) => s.endpoint !== sub.endpoint,
    );
    this.#data.subscriptions.push(
      epoch === undefined ? sub : { ...sub, ep: epoch },
    );
    await this.#persist();
  }

  /** Drop a subscription by endpoint (e.g. after the push service reports it gone). */
  async remove(endpoint: string): Promise<void> {
    const before = this.#data.subscriptions.length;
    this.#data.subscriptions = this.#data.subscriptions.filter(
      (s) => s.endpoint !== endpoint,
    );
    if (this.#data.subscriptions.length !== before) await this.#persist();
  }

  /**
   * Drop every subscription made before token epoch `epoch` — untagged ones
   * included — as a sign-out-everywhere does. Gone from memory at once; the
   * returned write makes it durable.
   */
  async retireBefore(epoch: number): Promise<void> {
    const before = this.#data.subscriptions.length;
    this.#data.subscriptions = this.#data.subscriptions.filter(
      (s) => s.ep !== undefined && s.ep >= epoch,
    );
    if (this.#data.subscriptions.length !== before) await this.#persist();
  }

  /**
   * Write the whole store, atomically (see `writeFileAtomic`). Writes run one
   * at a time, each serialising the state as it is when its turn comes, so the
   * last write to land always carries the latest state.
   */
  #persist(): Promise<void> {
    const write = this.#writes.then(() =>
      writeFileAtomic(
        this.#path,
        JSON.stringify(this.#data, null, 2),
        FILE_MODE,
      ),
    );
    this.#writes = write.catch(() => undefined);
    return write;
  }
}
