import type { ByteSink } from "./sealed-channel";

/**
 * A content-blind relay: forwards raw bytes between two endpoints of the same
 * route verbatim, recording what it sees. It never parses or decrypts — the
 * test double for the VPS aggregator's routing role.
 */
export class BlindRelay {
  observed: Uint8Array[] = [];
  #sinks = new Map<string, RelaySink[]>();

  endpoint(route: string): ByteSink {
    const sink = new RelaySink(this, route);
    const list = this.#sinks.get(route) ?? [];
    list.push(sink);
    this.#sinks.set(route, list);
    return sink;
  }

  forward(from: RelaySink, route: string, bytes: Uint8Array): void {
    this.observed.push(bytes);
    for (const s of this.#sinks.get(route) ?? [])
      if (s !== from) s.deliver(bytes);
  }
}

export class RelaySink implements ByteSink {
  #relay: BlindRelay;
  #route: string;
  #cbs: ((b: Uint8Array) => void)[] = [];

  constructor(relay: BlindRelay, route: string) {
    this.#relay = relay;
    this.#route = route;
  }
  send(bytes: Uint8Array): void {
    this.#relay.forward(this, this.#route, bytes);
  }
  onBytes(cb: (b: Uint8Array) => void): void {
    this.#cbs.push(cb);
  }
  deliver(bytes: Uint8Array): void {
    for (const cb of this.#cbs) cb(bytes);
  }
}
