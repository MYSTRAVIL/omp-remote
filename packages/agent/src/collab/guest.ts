/**
 * Headless Collab guest transport. Joins a room over the relay, performs the
 * `hello` handshake, and pumps sealed frames: inbound sealed payloads are
 * decrypted and surfaced as raw JSON (the adapter Zod-parses them), outbound
 * guest frames are sealed and enveloped. A thin wrapper over the proven wire
 * primitives; higher-level translation/lifecycle lives in the adapter.
 *
 * The socket is abstracted behind {@link GuestSocket} so the adapter can be
 * unit-tested without a real network, mirroring the uplink's socket seam.
 */
import { COLLAB_PROTO, type GuestFrame } from "@oh-my-pi/pi-wire";
import {
  type ParsedLink,
  importRoomKey,
  open,
  packEnvelope,
  parseCollabLink,
  seal,
  unpackEnvelope,
} from "./wire";

/** Transport seam: a binary WebSocket to the relay. The default wraps `WebSocket`. */
export interface GuestSocket {
  send(data: Uint8Array): void;
  close(): void;
  onOpen(cb: () => void): void;
  onClose(cb: (reason: string) => void): void;
  onMessage(cb: (data: unknown) => void): void;
  onError(cb: () => void): void;
}

export type GuestSocketFactory = (wsUrl: string) => GuestSocket;
export type CollabCloseCode = "transport-closed" | "decrypt-failed";

const browserGuestSocket: GuestSocketFactory = (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(1000),
    onOpen: (cb) => ws.addEventListener("open", () => cb(), { once: true }),
    onClose: (cb) =>
      ws.addEventListener("close", (ev) => cb(ev.reason || `code ${ev.code}`), {
        once: true,
      }),
    onMessage: (cb) => ws.addEventListener("message", (ev) => cb(ev.data)),
    onError: (cb) => ws.addEventListener("error", () => cb(), { once: true }),
  };
};

export interface CollabGuestOptions {
  /** Collab control or view link. */
  link: string;
  /** Display name the host shows for this participant. */
  name?: string;
  /** Join read-only even if the link carries a write token. */
  readOnly?: boolean;
  socketFactory?: GuestSocketFactory;
}

export class CollabGuest {
  /** A decrypted inbound host frame as raw JSON; the adapter validates it. */
  onFrame?: (frame: unknown, fromPeer: number) => void;
  /** Terminal close (relay drop, room closed, or bad key). */
  onClose?: (code: CollabCloseCode) => void;
  onOpen?: () => void;

  readonly #link: ParsedLink;
  readonly #name: string;
  readonly #writeToken?: Uint8Array;
  readonly #factory: GuestSocketFactory;
  #socket: GuestSocket | null = null;
  #key: CryptoKey | null = null;
  #sendChain: Promise<void> = Promise.resolve();
  #recvChain: Promise<void> = Promise.resolve();
  #closed = false;
  /** Settles `true` once `hello` is on the wire, `false` if the guest closes
   *  first. Queued frames wait on it: a WebSocket throws on `send` while it is
   *  still connecting, and nothing may precede `hello`. */
  readonly #ready = Promise.withResolvers<boolean>();
  #handshake: Promise<void> = Promise.resolve();

  constructor(opts: CollabGuestOptions) {
    this.#link = parseCollabLink(opts.link);
    this.#name = opts.name ?? "omp-remote";
    this.#writeToken = opts.readOnly ? undefined : this.#link.writeToken;
    this.#factory = opts.socketFactory ?? browserGuestSocket;
  }

  get canWrite(): boolean {
    return this.#writeToken !== undefined;
  }

  async start(): Promise<void> {
    this.#key = await importRoomKey(this.#link.key);
    const socket = this.#factory(`${this.#link.wsUrl}?role=guest`);
    this.#socket = socket;
    socket.onOpen(() => {
      const hello: GuestFrame = {
        t: "hello",
        proto: COLLAB_PROTO,
        name: this.#name,
      };
      if (this.#writeToken)
        hello.writeToken = Buffer.from(this.#writeToken).toString("base64url");
      this.#handshake = this.#sealAndSend(hello).then(() => {
        this.#ready.resolve(!this.#closed);
      });
      this.onOpen?.();
    });
    socket.onMessage((data) => {
      this.#recvChain = this.#recvChain.then(() => this.#onMessage(data));
    });
    socket.onClose(() => this.#fail("transport-closed"));
    socket.onError(() => {});
  }

  /**
   * Seal and send a guest frame. Sends are serialized so they hit the wire in
   * order, and wait for the handshake, so a frame queued while the socket is
   * connecting goes out after `hello` instead of throwing.
   */
  send(frame: GuestFrame): void {
    this.#sendChain = this.#sendChain.then(async () => {
      if (await this.#ready.promise) await this.#sealAndSend(frame);
    });
  }

  /** Never rejects: a socket that refuses a frame closes the guest instead. */
  async #sealAndSend(frame: GuestFrame): Promise<void> {
    const key = this.#key;
    if (this.#closed || !key) return;
    try {
      const payload = await seal(key, frame);
      // Re-read after the await: the guest may have closed meanwhile.
      const socket = this.#socket;
      if (this.#closed || !socket) return;
      socket.send(packEnvelope(0, payload));
    } catch {
      this.#fail("transport-closed");
    }
  }

  /**
   * Resolves once all queued sends and receives have settled (test/shutdown
   * aid). Sends queued before the handshake settle only once the socket opens
   * or the guest closes, so call `stop()` first when shutting down unopened.
   */
  settled(): Promise<void> {
    return Promise.allSettled([
      this.#handshake,
      this.#sendChain,
      this.#recvChain,
    ]).then(() => undefined);
  }

  stop(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready.resolve(false);
    this.#socket?.close();
    this.#socket = null;
  }

  async #onMessage(data: unknown): Promise<void> {
    if (typeof data === "string") return; // relay control (e.g. room-closed) arrives via onClose too
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Uint8Array
          ? data
          : null;
    if (!bytes || !this.#key) return;
    const env = unpackEnvelope(bytes);
    if (!env) return;
    let frame: unknown;
    try {
      frame = await open(this.#key, env.payload);
    } catch {
      this.#fail("decrypt-failed");
      return;
    }
    if (!this.#closed) this.onFrame?.(frame, env.peerId);
  }

  #fail(code: CollabCloseCode): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready.resolve(false);
    this.#socket?.close();
    this.#socket = null;
    this.onClose?.(code);
  }
}
