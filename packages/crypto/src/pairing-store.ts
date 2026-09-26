import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "@omp-remote/config";
import type { SecretOptions } from "@omp-remote/protocol/ipc";
import { z } from "zod";
import { type Identity, newIdentity } from "./identity";

export interface Peer {
  id: string;
  publicKey: string;
}

const StoreShape = z.object({
  identity: z.object({ publicKey: z.string(), secretKey: z.string() }),
  peers: z.array(z.object({ id: z.string(), publicKey: z.string() })),
});
type StoreShape = z.infer<typeof StoreShape>;

/**
 * This host's long-term X25519 identity and the phones it trusts, in
 * `pairing.json`. The secret key makes it a secret file: written owner-only
 * (see `writeFileAtomic`), and never silently replaced.
 */
export class PairingStore {
  #path: string;
  #opts: SecretOptions;
  #data: StoreShape | undefined;

  /** `opts.onAclFailure` hears when Windows could not make the file owner-only. */
  constructor(path: string, opts: SecretOptions = {}) {
    this.#path = path;
    this.#opts = opts;
  }

  /**
   * Read the store, minting a fresh identity only when the file does not
   * exist. A file that exists but cannot be read or parsed throws: replacing
   * it would silently drop every paired phone.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(`cannot read ${this.#path}`, { cause: err });
      this.#data = { identity: await newIdentity(), peers: [] };
      await this.#persist();
      return;
    }
    try {
      this.#data = StoreShape.parse(JSON.parse(raw));
    } catch (err) {
      throw new Error(`${this.#path} is not a valid pairing store`, {
        cause: err,
      });
    }
  }

  #require(): StoreShape {
    if (!this.#data) throw new Error("PairingStore.load() not called");
    return this.#data;
  }

  self(): Identity {
    return this.#require().identity;
  }
  peers(): Peer[] {
    return [...this.#require().peers];
  }
  peer(id: string): Peer | undefined {
    return this.#require().peers.find((p) => p.id === id);
  }
  async trust(peer: Peer): Promise<void> {
    const data = this.#require();
    const idx = data.peers.findIndex((p) => p.id === peer.id);
    if (idx >= 0) data.peers[idx] = peer;
    else data.peers.push(peer);
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await writeFileAtomic(
      this.#path,
      JSON.stringify(this.#require(), null, 2),
      this.#opts,
    );
  }
}
