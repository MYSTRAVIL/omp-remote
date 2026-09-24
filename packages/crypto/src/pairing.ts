import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

export class PairingStore {
  #path: string;
  #data: StoreShape | undefined;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    let parsed: StoreShape | undefined;
    try {
      const raw = await readFile(this.#path, "utf8");
      parsed = StoreShape.parse(JSON.parse(raw));
    } catch {
      parsed = undefined;
    }
    if (!parsed) {
      const identity = await newIdentity();
      parsed = { identity, peers: [] };
      this.#data = parsed;
      await this.#persist();
    } else {
      this.#data = parsed;
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
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, JSON.stringify(this.#require(), null, 2), {
      mode: 0o600,
    });
    await chmod(this.#path, 0o600);
  }
}
