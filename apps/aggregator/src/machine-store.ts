import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MachineId } from "@omp-remote/config";
import { z } from "zod";
import { writeFileAtomic } from "./atomic-write";

/**
 * A machine allowed to dial `/agent`: its id, the hash of the token that
 * authenticates it (and of a renewal not yet used, if any), and when it joined
 * and was last seen (epoch ms). The plaintext token is never stored.
 */
export const MachineRecord = z.object({
  machineId: MachineId,
  /** base64url SHA-256 of the machine's token: 32 bytes, 43 characters. */
  tokenHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /**
   * base64url SHA-256 of a re-pair's token that has not dialled `/agent` yet.
   * It authenticates beside `tokenHash`, which it replaces on first use.
   */
  renewalHash: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  joinedAt: z.number().int(),
  lastSeenAt: z.number().int().optional(),
});
export type MachineRecord = z.infer<typeof MachineRecord>;

const StoreShape = z.object({ machines: z.array(MachineRecord) });
type StoreShape = z.infer<typeof StoreShape>;

const FILE_MODE = 0o600;
const TOKEN_BYTES = 32;

/**
 * The stored form of a token: its SHA-256. `issue` and `authenticate` must
 * hash alike, or no issued token would ever authenticate.
 */
function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * On-disk registry of the machines that may dial `/agent`, each bound to one
 * token. Pairing issues the token; the owner can revoke it. The backing JSON
 * file is written owner-only (mode 0600) and holds only token hashes.
 *
 * A change applies in memory at once — so `authenticate` sees an issue or a
 * revoke the moment it is made — and its mutator resolves once the change is
 * on disk. Writes run one at a time in call order, each carrying the whole
 * state as it is when the write starts. If a write fails, every change not yet
 * on disk is undone, so memory matches what the disk last held, and each of
 * those changes' mutators rejects.
 */
export class MachineStore {
  readonly #path: string;
  /** The live state, changes applied. */
  #data: StoreShape;
  /** The state the last good write put on disk: what a failed write rolls back to. */
  #onDisk: StoreShape;
  /** Changes made so far, numbered from 1. */
  #changes = 0;
  /** The last change a good write carried to disk. */
  #durable = 0;
  /** The last change a failed write undid. */
  #undone = 0;
  /** Settles when the last queued write does; the next write starts after it. */
  #writes: Promise<void> = Promise.resolve();

  private constructor(path: string, data: StoreShape) {
    this.#path = path;
    this.#data = data;
    this.#onDisk = structuredClone(data);
  }

  /**
   * Load the store from `path`; a missing file is an empty store (written on
   * the first issue). A corrupt file throws rather than silently dropping
   * every machine's token.
   */
  static async load(path: string): Promise<MachineStore> {
    let raw: string | undefined;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const data =
      raw === undefined ? { machines: [] } : StoreShape.parse(JSON.parse(raw));
    return new MachineStore(path, data);
  }

  /**
   * Mint a fresh 32-byte token for `machineId`, replacing any earlier one and
   * any pending renewal (which stop authenticating at once), and persist.
   * Resolves to the plaintext token, the only time it exists outside the
   * machine that holds it. A re-issue keeps the machine's `joinedAt`.
   */
  async issue(machineId: string, now: number): Promise<string> {
    const id = MachineId.parse(machineId);
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const hash = tokenHash(token).toString("base64url");
    const existing = this.#data.machines.find((m) => m.machineId === id);
    if (existing === undefined)
      this.#data.machines.push({
        machineId: id,
        tokenHash: hash,
        joinedAt: now,
      });
    else {
      existing.tokenHash = hash;
      existing.renewalHash = undefined;
    }
    await this.#persist();
    return token;
  }

  /**
   * Mint a renewal token for existing `machineId` and persist its hash beside
   * the current token's. Both authenticate until the renewal's first use
   * retires the current one (see {@link adopt}), so a re-pair its host never
   * completes leaves the machine's token working. A newer renewal voids an
   * unused one. Resolves to the plaintext token; rejects for an unknown machine.
   */
  async renew(machineId: string): Promise<string> {
    const machine = this.#data.machines.find((m) => m.machineId === machineId);
    if (machine === undefined) throw new Error(`unknown machine ${machineId}`);
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    machine.renewalHash = tokenHash(token).toString("base64url");
    await this.#persist();
    return token;
  }

  /**
   * If `token` is `machineId`'s pending renewal, make it the machine's only
   * token — the one it renewed stops authenticating — and persist. Resolves to
   * whether it was; any other token changes nothing.
   */
  async adopt(machineId: string, token: string): Promise<boolean> {
    const machine = this.#data.machines.find((m) => m.machineId === machineId);
    const renewal = machine?.renewalHash;
    if (machine === undefined || renewal === undefined) return false;
    if (!timingSafeEqual(Buffer.from(renewal, "base64url"), tokenHash(token)))
      return false;
    machine.tokenHash = renewal;
    machine.renewalHash = undefined;
    await this.#persist();
    return true;
  }

  /**
   * The machineId `token` is bound to, as its token or its pending renewal, or
   * undefined. The presented token's hash is compared against every stored
   * hash in constant time, with no early exit, so the answer's timing says
   * nothing about which (if any) matched.
   */
  authenticate(token: string): string | undefined {
    const presented = tokenHash(token);
    let bound: string | undefined;
    for (const machine of this.#data.machines) {
      for (const hash of [machine.tokenHash, machine.renewalHash]) {
        if (hash === undefined) continue;
        if (timingSafeEqual(Buffer.from(hash, "base64url"), presented))
          bound = machine.machineId;
      }
    }
    return bound;
  }

  /**
   * Forget `machineId` and its token, and persist. Resolves to whether it was
   * known; an unknown machine changes nothing.
   */
  async revoke(machineId: string): Promise<boolean> {
    const index = this.#data.machines.findIndex(
      (m) => m.machineId === machineId,
    );
    if (index === -1) return false;
    this.#data.machines.splice(index, 1);
    await this.#persist();
    return true;
  }

  list(): readonly MachineRecord[] {
    return this.#data.machines;
  }

  /**
   * Record that `machineId` was seen at `now`. In memory only: the next issue
   * or revoke carries it to disk.
   */
  touch(machineId: string, now: number): void {
    const machine = this.#data.machines.find((m) => m.machineId === machineId);
    if (machine !== undefined) machine.lastSeenAt = now;
  }

  /**
   * Make the change just applied to `#data` durable: queue a write, resolving
   * once this change is on disk — possibly carried there by an earlier write
   * that started after it was made.
   */
  #persist(): Promise<void> {
    this.#changes += 1;
    const change = this.#changes;
    const write = this.#writes.then(() => this.#write(change));
    this.#writes = write.catch(() => undefined);
    return write;
  }

  async #write(change: number): Promise<void> {
    if (change <= this.#undone)
      throw new Error("an earlier machine store write failed");
    if (change <= this.#durable) return;
    const through = this.#changes;
    const state = structuredClone(this.#data);
    try {
      await writeFileAtomic(
        this.#path,
        JSON.stringify(state, null, 2),
        FILE_MODE,
      );
    } catch (err) {
      this.#data = structuredClone(this.#onDisk);
      this.#undone = this.#changes;
      throw err;
    }
    this.#onDisk = state;
    this.#durable = through;
  }
}
