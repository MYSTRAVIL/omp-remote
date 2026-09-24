/**
 * Bridges one omp Collab session to the phone: joins the room as a headless
 * guest, translates host frames to omp-remote uplink frames (relayed to the
 * phone via the AgentService registration), and translates the phone's downlink
 * control back into Collab guest frames. This is the per-session engine that
 * replaces the shadow-`ask` bridge path for a Collab-backed session.
 */
import {
  type DownlinkFrame,
  type Scheduler,
  type SessionMeta,
  type UplinkFrame,
  defaultScheduler,
} from "@omp-remote/protocol";
import { type AgentDiagnosticSink, noAgentDiagnostic } from "../diagnostics";
import {
  type CollabCloseCode,
  CollabGuest,
  type GuestSocketFactory,
} from "./guest";
import { CollabHostFrameSchema } from "./schema";
import { CollabTranslator } from "./translate";

/** The slice of AgentService the adapter drives; structural so it can be faked in tests. */
export interface CollabSessionSink {
  registerCollabSession(
    meta: SessionMeta,
    onDownlink: (frame: DownlinkFrame) => void,
  ): { emit(frame: UplinkFrame): void; close(): void };
  /** True when an IPC bridge already owns this session; the controller skips it (fallback wins). */
  hasIpcSession(sessionId: string): boolean;
}

export interface CollabAdapterOptions {
  /** Metadata for the bridged session; `meta.id` routes downlink frames. */
  meta: SessionMeta;
  /** Collab control link for the session's room. */
  link: string;
  service: CollabSessionSink;
  name?: string;
  socketFactory?: GuestSocketFactory;
  /** Reconnect timer source; injectable for deterministic lifecycle tests. */
  scheduler?: Scheduler;
  /** Privacy-safe operational diagnostics. */
  diagnostic?: AgentDiagnosticSink;
}

export class CollabAdapter {
  readonly #meta: SessionMeta;
  readonly #service: CollabSessionSink;
  #guest: CollabGuest | null = null;
  readonly #translator: CollabTranslator;
  #registration: { emit(frame: UplinkFrame): void; close(): void } | null =
    null;
  #stopped = false;
  readonly #diagnostic: AgentDiagnosticSink;
  readonly #link: string;
  readonly #name: string;
  readonly #socketFactory: GuestSocketFactory | undefined;
  readonly #scheduler: Scheduler;
  #retryMs = 500;
  #cancelReconnect: (() => void) | undefined;

  constructor(opts: CollabAdapterOptions) {
    this.#meta = opts.meta;
    this.#service = opts.service;
    this.#translator = new CollabTranslator(opts.meta.id);
    this.#diagnostic = opts.diagnostic ?? noAgentDiagnostic;
    this.#link = opts.link;
    this.#name = opts.name ?? "omp-remote";
    this.#socketFactory = opts.socketFactory;
    this.#scheduler = opts.scheduler ?? defaultScheduler;
  }

  get sessionId(): string {
    return this.#meta.id;
  }

  get pid(): number {
    return this.#meta.pid;
  }

  async start(): Promise<void> {
    if (!this.#registration) {
      this.#registration = this.#service.registerCollabSession(
        this.#meta,
        (frame) => this.#onDownlink(frame),
      );
    }
    await this.#startGuest();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#cancelReconnect?.();
    this.#cancelReconnect = undefined;
    this.#guest?.stop();
    this.#guest = null;
    this.#registration?.close();
    this.#registration = null;
  }

  /** Test/shutdown aid: resolves once the active guest has drained its queued work. */
  settled(): Promise<void> {
    return this.#guest?.settled() ?? Promise.resolve();
  }

  #onHostFrame(raw: unknown): void {
    const parsed = CollabHostFrameSchema.safeParse(raw);
    const registration = this.#registration;
    if (!parsed.success || !registration) return;
    for (const frame of this.#translator.host(parsed.data))
      registration.emit(frame);
  }

  #onDownlink(frame: DownlinkFrame): void {
    const guestFrame = this.#translator.downlink(frame);
    if (guestFrame) this.#guest?.send(guestFrame);
  }

  #onGuestClose(code: CollabCloseCode): void {
    this.#diagnostic({
      event: "collab_session_closed",
      sessionId: this.#meta.id,
      code,
    });
    this.#guest = null;
    this.#scheduleReconnect();
  }

  async #startGuest(): Promise<void> {
    if (this.#stopped) return;
    const guest = new CollabGuest({
      link: this.#link,
      name: this.#name,
      socketFactory: this.#socketFactory,
    });
    this.#guest = guest;
    guest.onFrame = (raw) => this.#onHostFrame(raw);
    guest.onOpen = () => {
      this.#retryMs = 500;
      this.#diagnostic({
        event: "collab_session_opened",
        sessionId: this.#meta.id,
      });
    };
    guest.onClose = (code) => this.#onGuestClose(code);
    await guest.start();
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#cancelReconnect) return;
    const delay = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, 30_000);
    this.#cancelReconnect = this.#scheduler.setTimer(() => {
      this.#cancelReconnect = undefined;
      void this.#startGuest();
    }, delay);
  }
}
