import {
  type ClientMessage,
  type DownlinkCommand,
  NOTICE_DETAIL_MAX,
  NOTICE_ENVELOPE_MAX,
  NOTICE_TITLE_MAX,
  type NoticeReason,
  type NotifyNotice,
  type Scheduler,
  type SessionMeta,
  clipNoticeText,
  defaultScheduler,
  sealNotice,
} from "@omp-remote/protocol";
import { type AgentDiagnosticSink, noAgentDiagnostic } from "./diagnostics";
import { hostIdleMs } from "./host-idle";
import type { NotifyPolicySource } from "./notify-policy";

/** Shortest wait before looking again whether the user has been away long enough. */
const RECHECK_MIN_MS = 1_000;

/** What a session waits on until the user answers it. */
interface Need {
  reason: NoticeReason;
  /** The notice's line: the last reply, the question, or the tool. */
  detail: string;
  /** The interaction it came from: that interaction's end, or the phone's
   *  reply to it, answers it. `undefined` for an attention. */
  interactionId: string | undefined;
  /** The user was away long enough (or their presence is unknown): the phone
   *  shows it until it is answered. */
  released: boolean;
  /** Its wait while the user was present has been reported. */
  deferReported: boolean;
}

/** What the notifier knows of one session. */
interface Tracked {
  title: string;
  project: string;
  /** The latest assistant reply: an idle notice's line. */
  lastReply: string;
  /** Whether its agent loop runs, per its latest state; `undefined` before one. */
  streaming: boolean | undefined;
  /** The tool started last and not ended since: the one a native approval
   *  (an `attention` that names no tool) holds. */
  runningTool: { callId: string; name: string } | undefined;
  need: Need | undefined;
  /** The need whose notice the phone was last sent; `undefined` when it was
   *  sent none, or a clear since. */
  shown: Need | undefined;
  /** It left the session list (or said `bye`); kept only until the phone has
   *  been told to close its notice. */
  gone: boolean;
}

export interface NotifierConfig {
  /** This machine: every envelope names it, and its seal is bound to it. */
  machineId: string;
  /** Seals the notices: `notifyKey(keys.tx)`; the phone derives it from `rx`. */
  key: Uint8Array;
  /** Hand a serialized `NotifyEnvelope` to the aggregator as a push; `false`
   *  when the link is down (the notifier sends it again on `resume`). */
  send: (notice: string) => boolean;
  /** How long the user must be away before a push. */
  policy: NotifyPolicySource;
  /** Milliseconds since this machine's last keyboard or mouse input, `null`
   *  when unknown; defaults to {@link hostIdleMs}. */
  idleMs?: () => number | null;
  /** Timer source for the presence re-check; injected in tests. */
  scheduler?: Scheduler;
  diagnostic?: AgentDiagnosticSink;
}

/**
 * Decides when the paired phone gets a push, from the same feed the uplink
 * relays. A session needs the user when it settles idle (`attention` idle: the
 * notice shows its last reply), asks a question (`interaction` ask: the first
 * question) or waits on an approval (`interaction` approval or `attention`
 * approval: the tool). Each session holds one need, the latest; a repeat of the
 * same need changes nothing.
 *
 * A need is pushed once the user has been away from this machine for the
 * policy's `awaySec` (no keyboard or mouse input), at once when that is `0` or
 * presence is unknown. While the user is present it waits, and is looked at
 * again when they could first have been away long enough. It ends when it is
 * answered: a user message, the agent loop starting again, the interaction
 * ending or the phone replying to it, the agent moving on past a question or
 * approval, or the session going away. A need that ends before it was pushed
 * is dropped; one that was pushed is followed by a `clear` notice for its
 * session, which closes the phone's notification.
 *
 * Notices are sealed under the notify key and sent in the order decided; the
 * aggregator only carries the opaque envelope. What the link could not carry
 * while down is sent on `resume`.
 */
export class Notifier {
  readonly #cfg: NotifierConfig;
  readonly #idleMs: () => number | null;
  readonly #scheduler: Scheduler;
  readonly #diagnostic: AgentDiagnosticSink;
  readonly #sessions = new Map<string, Tracked>();
  /** Sessions whose delivery waits on the chain; each has at most one. */
  readonly #queued = new Set<string>();
  /** Deliveries, run one at a time in the order they were decided. */
  #chain: Promise<void> = Promise.resolve();
  #cancelRecheck: (() => void) | undefined;
  #unsubscribePolicy: (() => void) | undefined;

  constructor(cfg: NotifierConfig) {
    this.#cfg = cfg;
    this.#idleMs = cfg.idleMs ?? hostIdleMs;
    this.#scheduler = cfg.scheduler ?? defaultScheduler;
    this.#diagnostic = cfg.diagnostic ?? noAgentDiagnostic;
  }

  /** Follow the policy: a changed away time re-checks the waiting needs. */
  start(): void {
    this.#unsubscribePolicy ??= this.#cfg.policy.onChange(() =>
      this.#evaluate(),
    );
  }

  /** Stop following the policy and forget every session. */
  stop(): void {
    this.#unsubscribePolicy?.();
    this.#unsubscribePolicy = undefined;
    this.#cancelRecheck?.();
    this.#cancelRecheck = undefined;
    this.#sessions.clear();
    this.#queued.clear();
  }

  /** One frame of the live feed (never a replay). */
  observe(msg: ClientMessage): void {
    switch (msg.t) {
      case "sessions":
        this.#list(msg.sessions);
        return;
      case "state": {
        const track = this.#track(msg.sessionId);
        if (msg.title.length > 0) track.title = msg.title;
        const resumed = msg.streaming && track.streaming === false;
        track.streaming = msg.streaming;
        // Its loop runs again: someone gave it input.
        if (resumed) this.#answer(msg.sessionId, track);
        return;
      }
      case "msg": {
        const track = this.#track(msg.sessionId);
        if (msg.role === "user") this.#answer(msg.sessionId, track);
        else if (msg.role === "assistant") {
          // A tool-call-only message has no text: the last words stay.
          if (msg.text.length > 0) track.lastReply = msg.text;
          // The agent speaks again: what it asked or waited on was settled.
          if (track.need !== undefined && track.need.reason !== "idle")
            this.#answer(msg.sessionId, track);
        }
        return;
      }
      case "tool": {
        const track = this.#track(msg.sessionId);
        if (msg.phase === "start")
          track.runningTool = { callId: msg.callId, name: msg.name };
        else if (
          msg.phase === "end" &&
          track.runningTool?.callId === msg.callId
        )
          track.runningTool = undefined;
        // A native approval never ends of its own: the tools moving on settle it.
        if (
          track.need?.reason === "approval" &&
          track.need.interactionId === undefined
        )
          this.#answer(msg.sessionId, track);
        return;
      }
      case "attention": {
        const track = this.#track(msg.sessionId);
        if (msg.reason === "idle") {
          // Settled: the next run of its loop is the user's answer.
          track.streaming = false;
          this.#raise(msg.sessionId, track, "idle", track.lastReply);
        } else
          this.#raise(
            msg.sessionId,
            track,
            "approval",
            track.runningTool?.name ?? "",
          );
        return;
      }
      case "interaction": {
        const track = this.#track(msg.sessionId);
        const { payload } = msg;
        if (payload.kind === "ask")
          this.#raise(
            msg.sessionId,
            track,
            "question",
            payload.questions[0]?.question ?? "",
            msg.id,
          );
        else
          this.#raise(
            msg.sessionId,
            track,
            "approval",
            payload.reason
              ? `${payload.tool}: ${payload.reason}`
              : payload.tool,
            msg.id,
          );
        return;
      }
      case "interactionEnd": {
        const track = this.#sessions.get(msg.sessionId);
        if (track !== undefined && track.need?.interactionId === msg.id)
          this.#answer(msg.sessionId, track);
        return;
      }
      case "bye": {
        const track = this.#sessions.get(msg.sessionId);
        if (track !== undefined) this.#leave(msg.sessionId, track);
        return;
      }
      default:
        return;
    }
  }

  /** A command from the phone: a reply answers the interaction it names. */
  command(frame: DownlinkCommand): void {
    if (frame.t !== "interactionReply") return;
    const track = this.#sessions.get(frame.sessionId);
    if (track !== undefined && track.need?.interactionId === frame.id)
      this.#answer(frame.sessionId, track);
  }

  /** The link is up again: send what it could not carry while down. */
  resume(): void {
    for (const [sessionId, track] of this.#sessions)
      this.#sync(sessionId, track);
  }

  /** Resolves once every delivery decided so far has run. */
  async settled(): Promise<void> {
    await this.#chain;
  }

  #track(sessionId: string): Tracked {
    let track = this.#sessions.get(sessionId);
    if (track === undefined) {
      track = {
        title: "",
        project: "",
        lastReply: "",
        streaming: undefined,
        runningTool: undefined,
        need: undefined,
        shown: undefined,
        gone: false,
      };
      this.#sessions.set(sessionId, track);
    }
    return track;
  }

  /** A new session list: take titles and projects, and let go of every
   *  session no longer on it. */
  #list(sessions: readonly SessionMeta[]): void {
    const listed = new Set<string>();
    for (const meta of sessions) {
      listed.add(meta.id);
      const track = this.#track(meta.id);
      track.gone = false;
      if (meta.title.length > 0) track.title = meta.title;
      track.project = meta.project;
    }
    for (const [sessionId, track] of this.#sessions)
      if (!listed.has(sessionId) && !track.gone) this.#leave(sessionId, track);
  }

  #raise(
    sessionId: string,
    track: Tracked,
    reason: NoticeReason,
    detail: string,
    interactionId?: string,
  ): void {
    if (track.gone) return;
    const current = track.need;
    if (
      current !== undefined &&
      current.reason === reason &&
      current.detail === detail &&
      current.interactionId === interactionId
    )
      return;
    track.need = {
      reason,
      detail,
      interactionId,
      released: false,
      deferReported: false,
    };
    this.#evaluate();
    // Still held, it replaces a shown need: that stale notice is cleared.
    this.#sync(sessionId, track);
  }

  #answer(sessionId: string, track: Tracked): void {
    if (track.need === undefined) return;
    track.need = undefined;
    this.#sync(sessionId, track);
  }

  #leave(sessionId: string, track: Tracked): void {
    track.gone = true;
    track.need = undefined;
    this.#sync(sessionId, track);
  }

  /**
   * Release the needs held while the user was present, once they have been
   * away long enough (or presence is unknown, or the policy pushes always).
   * Otherwise look again when they could first have been: idle time only
   * grows while the user stays away.
   */
  #evaluate(): void {
    this.#cancelRecheck?.();
    this.#cancelRecheck = undefined;
    let held = false;
    for (const track of this.#sessions.values())
      if (track.need !== undefined && !track.need.released) held = true;
    if (!held) return;
    const awaySec = this.#cfg.policy.awaySec;
    const idle = this.#idleMs();
    // How much longer the user must stay away: nothing when presence is
    // unknown or the policy pushes always.
    const remaining = idle === null ? 0 : awaySec * 1000 - idle;
    const away = remaining <= 0;
    for (const [sessionId, track] of this.#sessions) {
      const need = track.need;
      if (need === undefined || need.released) continue;
      if (away) {
        need.released = true;
        this.#sync(sessionId, track);
      } else if (!need.deferReported) {
        need.deferReported = true;
        this.#diagnostic({
          event: "notify_push_deferred",
          sessionId,
          reason: need.reason,
          code: "user-present",
          awaySec,
        });
      }
    }
    if (away) return;
    this.#cancelRecheck = this.#scheduler.setTimer(
      () => {
        this.#cancelRecheck = undefined;
        this.#evaluate();
      },
      Math.max(remaining, RECHECK_MIN_MS),
    );
  }

  /** Queue a delivery when the phone shows something other than what it
   *  should; forget a gone session once it shows nothing. */
  #sync(sessionId: string, track: Tracked): void {
    const wanted = track.need?.released ? track.need : undefined;
    if (wanted !== track.shown) this.#schedule(sessionId);
    else if (track.gone) this.#sessions.delete(sessionId);
  }

  #schedule(sessionId: string): void {
    if (this.#queued.has(sessionId)) return;
    this.#queued.add(sessionId);
    this.#chain = this.#chain.then(() => {
      this.#queued.delete(sessionId);
      return this.#deliver(sessionId);
    });
  }

  /** Bring the phone in line with the session: the need to show, else a clear. */
  async #deliver(sessionId: string): Promise<void> {
    const track = this.#sessions.get(sessionId);
    if (track === undefined) return;
    const wanted = track.need?.released ? track.need : undefined;
    if (wanted === track.shown) return;
    const notice: NotifyNotice = wanted
      ? {
          kind: "attention",
          sessionId,
          reason: wanted.reason,
          title: clipNoticeText(track.title, NOTICE_TITLE_MAX),
          project: clipNoticeText(track.project, NOTICE_TITLE_MAX),
          detail: clipNoticeText(wanted.detail, NOTICE_DETAIL_MAX),
        }
      : { kind: "clear", sessionId };
    let sealed: string | undefined;
    try {
      sealed = await this.#seal(notice);
    } catch {
      this.#diagnostic({
        event: "notify_push_failed",
        sessionId,
        code: "seal-failed",
      });
      return;
    }
    // It changed while sealing; the change queued a delivery of its own.
    if (
      this.#sessions.get(sessionId) !== track ||
      (track.need?.released ? track.need : undefined) !== wanted
    )
      return;
    if (sealed === undefined) {
      // Nothing shorter can be sent: give it up rather than retry forever.
      this.#diagnostic({
        event: "notify_push_failed",
        sessionId,
        code: "too-large",
      });
    } else if (!this.#cfg.send(sealed)) return;
    else if (wanted)
      this.#diagnostic({
        event: "notify_push_sent",
        sessionId,
        reason: wanted.reason,
      });
    else this.#diagnostic({ event: "notify_push_cleared", sessionId });
    track.shown = wanted;
    if (track.gone && wanted === undefined) this.#sessions.delete(sessionId);
  }

  /** The notice sealed, cut down until its envelope fits a push payload;
   *  `undefined` when even the barest does not. */
  async #seal(notice: NotifyNotice): Promise<string | undefined> {
    const attempts: NotifyNotice[] =
      notice.kind === "attention"
        ? [
            notice,
            { ...notice, detail: "" },
            { ...notice, detail: "", title: "", project: "" },
          ]
        : [notice];
    for (const attempt of attempts) {
      const envelope = JSON.stringify(
        await sealNotice(this.#cfg.key, this.#cfg.machineId, attempt),
      );
      if (envelope.length <= NOTICE_ENVELOPE_MAX) return envelope;
    }
    return undefined;
  }
}
