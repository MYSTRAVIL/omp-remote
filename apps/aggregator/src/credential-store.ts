import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeFileAtomic } from "./atomic-write";

/**
 * A registered passkey, persisted between server restarts. `publicKey` is the
 * base64url COSE public key returned by `@simplewebauthn`; `counter` is the
 * authenticator's last-seen signature counter (replay defence — must only ever
 * move forward). The epoch-ms dates are optional: a passkey enrolled before they
 * were recorded simply lacks them.
 */
export const StoredCredential = z.object({
  id: z.string(), // base64url credential id
  publicKey: z.string(), // base64url COSE public key
  counter: z.number().int().nonnegative(),
  transports: z.array(z.string()).optional(),
  createdAt: z.number().int().nonnegative().optional(), // registered, epoch ms
  lastUsedAt: z.number().int().nonnegative().optional(), // last login/step-up, epoch ms
});
export type StoredCredential = z.infer<typeof StoredCredential>;

const StoreShape = z.object({
  /** base64url user handle — stable across all of this user's passkeys. */
  userId: z.string(),
  userName: z.string(),
  credentials: z.array(StoredCredential),
  /**
   * Session-token epoch. Only a token signed under the current epoch verifies,
   * so bumping it signs out everywhere. Absent (a store written before epochs
   * existed) means 0.
   */
  tokenEpoch: z.number().int().nonnegative().optional(),
  /**
   * Whether the owner may sign in with the password. On unless turned off; a
   * store written before password sign-in existed has it on.
   */
  passwordSignIn: z.boolean().default(true),
  /**
   * When password sign-in was last turned off, epoch ms: a password session
   * issued before it stays signed out, even once sign-in is back on. Absent:
   * never turned off.
   */
  passwordSignInOffAt: z.number().int().nonnegative().optional(),
});
type StoreShape = z.infer<typeof StoreShape>;

const FILE_MODE = 0o600;

/**
 * On-disk credential store for the single-user access gate. The backing JSON
 * file is written owner-only (mode 0600) so a passkey public key + counter is
 * never world-readable. This holds NO session content and no secret — only
 * public credential material, each passkey's counter and dates, the
 * session-token epoch, and whether password sign-in is on.
 *
 * A change applies in memory the moment it is made — so a check and the change
 * it guards stay atomic — and its mutator resolves once the change is on disk.
 * Writes run one at a time in call order, each carrying the whole state as it
 * is when the write starts. If a write fails, every change not yet on disk is
 * undone, so memory matches what the disk last held again, and each of those
 * changes' mutators rejects.
 */
export class CredentialStore {
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
   * Load the store from `path`, or initialise a fresh empty store (with a new
   * random user handle) if the file does not yet exist. A corrupt file throws
   * rather than silently discarding registered credentials.
   */
  static async load(
    path: string,
    userName = "omp-remote",
  ): Promise<CredentialStore> {
    let raw: string | undefined;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (raw === undefined) {
      const fresh: StoreShape = {
        userId: randomBytes(16).toString("base64url"),
        userName,
        credentials: [],
        passwordSignIn: true,
      };
      const store = new CredentialStore(path, fresh);
      await store.#persist();
      return store;
    }
    const data = StoreShape.parse(JSON.parse(raw));
    return new CredentialStore(path, data);
  }

  get userId(): string {
    return this.#data.userId;
  }
  get userName(): string {
    return this.#data.userName;
  }

  list(): readonly StoredCredential[] {
    return this.#data.credentials;
  }

  get(id: string): StoredCredential | undefined {
    return this.#data.credentials.find((c) => c.id === id);
  }

  /** The current session-token epoch: 0 until the first sign-out-everywhere. */
  get tokenEpoch(): number {
    return this.#data.tokenEpoch ?? 0;
  }

  /** Whether the owner may sign in with the password. */
  get passwordSignIn(): boolean {
    return this.#data.passwordSignIn;
  }

  /** When password sign-in was last turned off (epoch ms), or 0 if never. */
  get passwordSignInOffAt(): number {
    return this.#data.passwordSignInOffAt ?? 0;
  }

  /** Add a newly-registered credential and persist. Rejects a duplicate id. */
  async add(cred: StoredCredential): Promise<void> {
    if (this.get(cred.id) !== undefined)
      throw new Error(`credential ${cred.id} already registered`);
    this.#data.credentials.push(cred);
    await this.#persist();
  }

  /**
   * Record a verified assertion: advance the credential's replay counter, stamp
   * its last use (epoch ms), and persist.
   */
  async recordUse(id: string, counter: number, usedAt: number): Promise<void> {
    const cred = this.get(id);
    if (cred === undefined) throw new Error(`unknown credential ${id}`);
    cred.counter = counter;
    cred.lastUsedAt = usedAt;
    await this.#persist();
  }

  /** Remove a credential and persist. */
  async remove(id: string): Promise<void> {
    const index = this.#data.credentials.findIndex((c) => c.id === id);
    if (index === -1) throw new Error(`unknown credential ${id}`);
    this.#data.credentials.splice(index, 1);
    await this.#persist();
  }

  /** Advance the session-token epoch, invalidating every earlier token, and persist. */
  async bumpTokenEpoch(): Promise<void> {
    this.#data.tokenEpoch = this.tokenEpoch + 1;
    await this.#persist();
  }

  /**
   * Turn password sign-in on or off at `at` (epoch ms), and persist. Turning
   * it off records `at` as {@link passwordSignInOffAt}.
   */
  async setPasswordSignIn(enabled: boolean, at: number): Promise<void> {
    this.#data.passwordSignIn = enabled;
    if (!enabled) this.#data.passwordSignInOffAt = at;
    await this.#persist();
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
      throw new Error("an earlier credential store write failed");
    // Already on disk: a write that started after it was made carried it. Not
    // writing again also keeps a later failure from rejecting a change that landed.
    if (change <= this.#durable) return;
    const through = this.#changes;
    const state = structuredClone(this.#data);
    try {
      // A fresh 0600 file renamed over the old one: a crash mid-write leaves
      // the previous state whole, and a looser mode on the old file goes with
      // it. Nothing can fail once the rename lands, so a failure never leaves
      // a change on disk that memory has undone.
      await writeFileAtomic(
        this.#path,
        JSON.stringify(state, null, 2),
        FILE_MODE,
      );
    } catch (err) {
      // Every change not yet on disk fails with this write: undo them all.
      this.#data = structuredClone(this.#onDisk);
      this.#undone = this.#changes;
      throw err;
    }
    this.#onDisk = state;
    this.#durable = through;
  }
}
