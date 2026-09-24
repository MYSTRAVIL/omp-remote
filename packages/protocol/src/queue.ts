/**
 * A fixed-capacity FIFO queue that evicts the OLDEST item on overflow. This is
 * the backpressure primitive shared by the host-agent uplink and the PWA client
 * (spec §4.1/§4.2/§10): outbound frames buffered while a socket is down or its
 * kernel buffer is full accumulate here and are flushed on (re)connect, but the
 * queue can never grow without bound — a slow or dead peer drops stale frames
 * rather than exhausting memory.
 */
export class BoundedQueue<T> {
  readonly #capacity: number;
  #items: T[] = [];

  /** @param capacity maximum retained items; must be at least 1. */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError(
        `BoundedQueue capacity must be >= 1, got ${capacity}`,
      );
    this.#capacity = capacity;
  }

  /**
   * Append an item. If the queue is at capacity the oldest item is evicted and
   * returned (so callers can observe drops); otherwise returns `undefined`.
   */
  push(item: T): T | undefined {
    this.#items.push(item);
    if (this.#items.length > this.#capacity) return this.#items.shift();
    return undefined;
  }

  /** Return every item in FIFO order and empty the queue. */
  drain(): T[] {
    const out = this.#items;
    this.#items = [];
    return out;
  }

  clear(): void {
    this.#items = [];
  }

  get size(): number {
    return this.#items.length;
  }

  get capacity(): number {
    return this.#capacity;
  }
}
