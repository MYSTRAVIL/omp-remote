import { SealedChannel, type SessionKeys } from "@omp-remote/crypto";
import { RoutedEnvelope, type SealedFrame } from "@omp-remote/protocol";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A phone socket as the relay sees it: the lines the phone sent, and a way to hand it one. */
export interface PhoneLink {
  readonly sent: readonly string[];
  deliver(raw: string): void;
}

/** The route a sealed line is addressed to; `undefined` for clear control or garbage. */
function routeOf(raw: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const env = RoutedEnvelope.safeParse(json);
  return env.success ? env.data.route : undefined;
}

/**
 * The paired host-agent's end of one machine's channel, for tests that play
 * the relay by hand. It is a real responder `SealedChannel`: it acks a phone's
 * hello as the host-agent does, opens only the phone's lines bound to its
 * epoch, and seals lines a phone it acked really accepts. Nothing moves
 * between it and the phone until the test calls `relay()`.
 */
export class FakeAgent {
  /** Every frame the agent opened, in order. */
  readonly frames: SealedFrame[] = [];
  readonly #route: string;
  readonly #channel: SealedChannel;
  #feed: ((bytes: Uint8Array) => void) | undefined;
  /** Lines the agent sealed on its own (acks) that the phone has not been handed. */
  #outbox: string[] = [];
  #link: PhoneLink | undefined;
  /** How many of the link's sent lines the agent has been handed. */
  #read = 0;

  constructor(keys: SessionKeys, route: string) {
    this.#route = route;
    this.#channel = new SealedChannel(
      keys,
      {
        send: (bytes) => {
          this.#outbox.push(dec.decode(bytes));
        },
        onBytes: (cb) => {
          this.#feed = cb;
        },
      },
      route,
      { role: "responder" },
    );
    this.#channel.onFrame((frame) => this.frames.push(frame));
  }

  /** Relay to and from this phone socket from now on: all it sent counts. */
  connect(link: PhoneLink): void {
    this.#link = link;
    this.#read = 0;
  }

  /**
   * Play the relay until both ends are quiet: the phone's sealed lines on this
   * route go to the agent in order, and what the agent seals in reply (an ack)
   * goes back to the phone, whose own answer (a sync) is relayed in turn.
   */
  relay(): void {
    const link = this.#link;
    if (link === undefined) throw new Error("the agent has no phone socket");
    for (;;) {
      const line = link.sent[this.#read];
      if (line !== undefined) {
        this.#read += 1;
        if (routeOf(line) === this.#route) this.#feed?.(enc.encode(line));
        continue;
      }
      const reply = this.#outbox.shift();
      if (reply === undefined) return;
      link.deliver(reply);
    }
  }

  /** Seal `frame` as the agent broadcasts it and return the wire line, undelivered. */
  seal(frame: SealedFrame): string {
    this.#channel.sendFrame(frame);
    const line = this.#outbox.pop();
    if (line === undefined) throw new Error("nothing sealed");
    return line;
  }
}
