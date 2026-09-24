import { sha256 } from "@noble/hashes/sha2.js";
import {
  type DownlinkFrame,
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_CHUNK_BYTES,
  type UplinkFrame,
} from "@omp-remote/protocol";
import { toBase64 } from "./base64";
import { randomId } from "./ids";

/** Sends a sealed downlink frame to a machine; returns false when no channel exists. */
export type UploadFrameSink = (
  machineId: string,
  frame: DownlinkFrame,
) => boolean;

interface PendingUpload {
  resolve: (resourceId: string) => void;
  reject: (error: Error) => void;
  onProgress: (fraction: number) => void;
  total: number;
  cancelTimer: () => void;
}

/** SHA-256 as lowercase hex. Pure JS, so it works on plain-HTTP origins without `crypto.subtle`. */
export function sha256Hex(buffer: ArrayBuffer): string {
  const digest = sha256(new Uint8Array(buffer));
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Drives a phone-side chunked image upload: hashes the file, announces it with
 * `resourceInit`, streams `resourceChunk`s, and resolves with the host resource
 * id once `resourceReady` lands (or rejects on `resourceError`). Upload frames
 * ride the sealed channel directly — they are inert data, not state-changing, so
 * they bypass the passkey gate; the prompt that references the resulting id is
 * the gated action. Correlated by a per-transfer id, so many uploads coexist.
 *
 * A transfer that goes silent — e.g. the host bridge dropped mid-upload — rejects
 * with `timeout` after `timeoutMs` of no `resourceReady`/`resourceProgress`
 * instead of hanging forever; each progress frame re-arms the deadline.
 */
export class AttachmentUploader {
  readonly #send: UploadFrameSink;
  readonly #pending = new Map<string, PendingUpload>();
  readonly #timeoutMs: number;

  constructor(send: UploadFrameSink, timeoutMs = 45_000) {
    this.#send = send;
    this.#timeoutMs = timeoutMs;
  }

  #arm(transferId: string): () => void {
    const handle = setTimeout(() => {
      const pending = this.#pending.get(transferId);
      if (!pending) return;
      this.#pending.delete(transferId);
      pending.reject(new Error("timeout"));
    }, this.#timeoutMs);
    return () => clearTimeout(handle);
  }

  async upload(
    machineId: string,
    sessionId: string,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<string> {
    if (!file.type.startsWith("image/")) throw new Error("unsupported");
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.length > MAX_RESOURCE_BYTES) throw new Error("too-large");
    const sha256 = await sha256Hex(buffer);
    const total = Math.max(
      1,
      Math.ceil(bytes.length / MAX_RESOURCE_CHUNK_BYTES),
    );
    const transferId = randomId();
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    this.#pending.set(transferId, {
      resolve,
      reject,
      onProgress,
      total,
      cancelTimer: this.#arm(transferId),
    });
    const announced = this.#send(machineId, {
      t: "resourceInit",
      sessionId,
      transferId,
      name: file.name,
      mimeType: file.type,
      size: bytes.length,
      totalChunks: total,
      sha256,
    });
    if (!announced) {
      this.#pending.get(transferId)?.cancelTimer();
      this.#pending.delete(transferId);
      throw new Error("send-failed");
    }
    for (let index = 0; index < total; index++) {
      const start = index * MAX_RESOURCE_CHUNK_BYTES;
      const slice = bytes.subarray(start, start + MAX_RESOURCE_CHUNK_BYTES);
      this.#send(machineId, {
        t: "resourceChunk",
        sessionId,
        transferId,
        index,
        data: toBase64(slice),
      });
    }
    return promise;
  }

  /** Route an inbound resource frame to its waiting upload; unknown ids are ignored. */
  handleFrame(frame: UplinkFrame): void {
    if (
      frame.t !== "resourceProgress" &&
      frame.t !== "resourceReady" &&
      frame.t !== "resourceError"
    )
      return;
    const pending = this.#pending.get(frame.transferId);
    if (!pending) return;
    if (frame.t === "resourceProgress") {
      pending.cancelTimer();
      pending.cancelTimer = this.#arm(frame.transferId);
      pending.onProgress(Math.min(1, frame.received / pending.total));
      return;
    }
    pending.cancelTimer();
    this.#pending.delete(frame.transferId);
    if (frame.t === "resourceReady") pending.resolve(frame.resourceId);
    else pending.reject(new Error(frame.code));
  }
}
