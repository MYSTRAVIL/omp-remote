import type { HistoryLike } from "../../src/core/history-nav";

/**
 * A history stack that, like a browser, only queues traversals (back, forward,
 * go): `flush` delivers them as popstates. A push or replace while one is
 * queued would land on the entry about to be popped, so the fake refuses it.
 */
export class FakeHistory implements HistoryLike {
  #stack: unknown[] = [null];
  #index = 0;
  #traversals: number[] = [];
  #pop: (state: unknown) => void = () => {};
  leftApp = false;

  pushState(data: unknown): void {
    this.#assertSettled();
    this.#stack = this.#stack.slice(0, this.#index + 1);
    this.#stack.push(data);
    this.#index += 1;
  }
  replaceState(data: unknown): void {
    this.#assertSettled();
    this.#stack[this.#index] = data;
  }
  back(): void {
    this.go(-1);
  }
  forward(): void {
    this.go(1);
  }
  go(delta: number): void {
    this.#traversals.push(delta);
  }
  /** Deliver queued traversals in order, including any a handler queues. */
  flush(): void {
    let delta = this.#traversals.shift();
    while (delta !== undefined) {
      this.#traverse(delta);
      delta = this.#traversals.shift();
    }
  }
  onPop(handler: (state: unknown) => void): void {
    this.#pop = handler;
  }
  /** Entries behind the current one: 0 on the tree, 1 on a session. */
  position(): number {
    return this.#index;
  }
  #traverse(delta: number): void {
    const target = this.#index + delta;
    if (target < 0) {
      // The base entry is the tree; a real browser here leaves the app.
      this.leftApp = true;
      return;
    }
    if (target >= this.#stack.length) return;
    this.#index = target;
    this.#pop(this.#stack[target]);
  }
  #assertSettled(): void {
    if (this.#traversals.length > 0)
      throw new Error("history written while a traversal is in flight");
  }
}

/** The user's back gesture. */
export function pressBack(history: FakeHistory): void {
  history.back();
  history.flush();
}
