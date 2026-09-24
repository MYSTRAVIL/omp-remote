import { createHash, randomUUID } from "node:crypto";
import {
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_CHUNK_BYTES,
  type ResourceChunkFrame,
  type ResourceInitFrame,
} from "@omp-remote/protocol";

export type ResourceErrorCode =
  | "too-large"
  | "integrity"
  | "expired"
  | "unsupported"
  | "internal";

/** A fully assembled attachment, ready to wrap as model image content. */
export interface AssembledResource {
  mimeType: string;
  /** Base64 of the complete bytes. */
  data: string;
}

export interface ResourceAssemblerCallbacks {
  onProgress(transferId: string, received: number): void;
  onReady(transferId: string, resourceId: string): void;
  onError(transferId: string, code: ResourceErrorCode): void;
}

interface PendingTransfer {
  meta: ResourceInitFrame;
  chunks: (Uint8Array | undefined)[];
  received: number;
  bytes: number;
  createdAt: number;
}

/** Abandoned transfers are pruned once this old (opportunistically, on the next init). */
const TRANSFER_TTL_MS = 5 * 60_000;

/**
 * Reassembles a phone's chunked, sealed attachment upload into one verified
 * resource. Bounds come from the protocol (whole-resource + per-chunk size);
 * integrity is checked against the announced SHA-256 and byte count, so a
 * corrupted or reordered stream can never yield a resource. Pure and clockless —
 * the caller supplies `now`, so tests stay timer-free; a fresh `init`
 * opportunistically expires stale transfers rather than a wall-clock timer.
 *
 * Only images are accepted at the model boundary today; the transfer path itself
 * is content-type agnostic, so lifting that gate is the only change needed when
 * omp accepts other attachment types.
 */
export class ResourceAssembler {
  readonly #cbs: ResourceAssemblerCallbacks;
  readonly #now: () => number;
  readonly #pending = new Map<string, PendingTransfer>();
  readonly #resources = new Map<string, AssembledResource>();

  constructor(cbs: ResourceAssemblerCallbacks, now: () => number = Date.now) {
    this.#cbs = cbs;
    this.#now = now;
  }

  init(frame: ResourceInitFrame): void {
    this.#pruneStale();
    // Images only at the model boundary; the transfer stays type-agnostic.
    if (!frame.mimeType.startsWith("image/")) {
      this.#cbs.onError(frame.transferId, "unsupported");
      return;
    }
    if (frame.size < 0 || frame.size > MAX_RESOURCE_BYTES) {
      this.#cbs.onError(frame.transferId, "too-large");
      return;
    }
    const maxChunks =
      Math.ceil(MAX_RESOURCE_BYTES / MAX_RESOURCE_CHUNK_BYTES) + 1;
    if (frame.totalChunks < 1 || frame.totalChunks > maxChunks) {
      this.#cbs.onError(frame.transferId, "too-large");
      return;
    }
    this.#pending.set(frame.transferId, {
      meta: frame,
      chunks: new Array<Uint8Array | undefined>(frame.totalChunks).fill(
        undefined,
      ),
      received: 0,
      bytes: 0,
      createdAt: this.#now(),
    });
  }

  chunk(frame: ResourceChunkFrame): void {
    const transfer = this.#pending.get(frame.transferId);
    if (!transfer) return; // unknown or already-settled transfer: ignore
    if (frame.index < 0 || frame.index >= transfer.chunks.length) {
      this.#fail(frame.transferId, "internal");
      return;
    }
    if (transfer.chunks[frame.index] !== undefined) return; // duplicate chunk
    // Buffer.from is lenient on malformed base64; the SHA-256 check below is the
    // real integrity gate, so a bad decode can never pass as a valid resource.
    const bytes = Buffer.from(frame.data, "base64");
    if (bytes.length > MAX_RESOURCE_CHUNK_BYTES) {
      this.#fail(frame.transferId, "too-large");
      return;
    }
    transfer.chunks[frame.index] = bytes;
    transfer.received += 1;
    transfer.bytes += bytes.length;
    if (transfer.bytes > MAX_RESOURCE_BYTES) {
      this.#fail(frame.transferId, "too-large");
      return;
    }
    this.#cbs.onProgress(frame.transferId, transfer.received);
    if (transfer.received === transfer.chunks.length)
      this.#finish(frame.transferId, transfer);
  }

  abort(transferId: string): void {
    this.#pending.delete(transferId);
  }

  /**
   * Resolve resource ids to their assembled resources, in order. Returns the
   * missing ids instead when any is not ready, so the caller refuses the send
   * rather than silently dropping an attachment.
   */
  resolve(
    ids: readonly string[],
  ):
    | { ok: true; resources: AssembledResource[] }
    | { ok: false; missing: string[] } {
    const resources: AssembledResource[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const resource = this.#resources.get(id);
      if (resource) resources.push(resource);
      else missing.push(id);
    }
    return missing.length === 0
      ? { ok: true, resources }
      : { ok: false, missing };
  }

  /** Drop a resolved resource once its prompt has consumed it. */
  release(id: string): void {
    this.#resources.delete(id);
  }

  #finish(transferId: string, transfer: PendingTransfer): void {
    this.#pending.delete(transferId);
    if (transfer.bytes !== transfer.meta.size) {
      this.#cbs.onError(transferId, "integrity");
      return;
    }
    const full = new Uint8Array(transfer.bytes);
    let offset = 0;
    for (const chunk of transfer.chunks) {
      if (!chunk) {
        this.#cbs.onError(transferId, "internal");
        return;
      }
      full.set(chunk, offset);
      offset += chunk.length;
    }
    const digest = createHash("sha256").update(full).digest("hex");
    if (digest !== transfer.meta.sha256.toLowerCase()) {
      this.#cbs.onError(transferId, "integrity");
      return;
    }
    const resourceId = randomUUID();
    this.#resources.set(resourceId, {
      mimeType: transfer.meta.mimeType,
      data: Buffer.from(full).toString("base64"),
    });
    this.#cbs.onReady(transferId, resourceId);
  }

  #fail(transferId: string, code: ResourceErrorCode): void {
    this.#pending.delete(transferId);
    this.#cbs.onError(transferId, code);
  }

  #pruneStale(): void {
    const cutoff = this.#now() - TRANSFER_TTL_MS;
    for (const [id, transfer] of this.#pending) {
      if (transfer.createdAt < cutoff) {
        this.#pending.delete(id);
        this.#cbs.onError(id, "expired");
      }
    }
  }
}
