/// <reference lib="dom" />
import type {
  Dot,
  ModeFrame,
  ModeOpts,
  OrbFrame,
  OrbSize,
  OrbState,
} from "thinking-orbs/engine";
import {
  MODE_FRAMES,
  finalizeFrame,
  paintFrame,
  paintLines,
  resolvePreset,
} from "thinking-orbs/engine";
import type { TranscriptState } from "../core/transcript";

// A framework-free driver for the `thinking-orbs` engine: it owns one
// `<canvas>`, resolves a (state, size) preset once, and paints the mode's
// geometry on a shared `performance.now()` clock so every mounted orb stays in
// phase. This is the vanilla equivalent of the library's React component —
// same DPR cap, offscreen/hidden-tab pausing, and reduced-motion static frame —
// kept in the app so both the sessions list and the composer strip (and, later,
// the wallpaper) share one implementation.

/** Per-state default accessible label; `breathing` reads as "Thinking…". */
const LABELS: Record<OrbState, string> = {
  working: "Working…",
  searching: "Searching…",
  solving: "Solving…",
  listening: "Listening…",
  connecting: "Connecting…",
  weaving: "Weaving…",
  composing: "Composing…",
  breathing: "Thinking…",
  shaping: "Shaping…",
};

export interface OrbViewOptions {
  /** Tuned size preset in CSS px (64 chat-avatar, 20 inline). @default 64 */
  size?: OrbSize;
  /** Initial state; `null` renders nothing (canvas hidden). @default null */
  state?: OrbState | null;
  /** Dark substrate → light ink. The app is dark. @default true */
  dark?: boolean;
  /** Fixed aria-label override; otherwise the per-state default is used. */
  label?: string;
  /** Extra class applied to the canvas element. */
  className?: string;
  /** Morph duration in ms between states (and on fade in/out). @default 380 */
  transitionMs?: number;
}

interface OrbLayer {
  frameFn: ModeFrame;
  opts: ModeOpts;
  speed: number;
}

const EMPTY_FRAME: OrbFrame = { dots: [], lines: [] };

/** Linear interpolation. */
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Sort a copy of the dots by their angle around the centre. */
function byAngle(dots: Dot[], cx: number, cy: number): Dot[] {
  return [...dots].sort(
    (p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx),
  );
}

/** A phantom dot at the centre (alpha 0) so count deltas emerge/collapse there. */
function seed(ref: Dot | undefined, cx: number, cy: number): Dot {
  return {
    x: cx,
    y: cy,
    z: ref?.z ?? 0,
    r: (ref?.r ?? 1) * 0.3,
    white: ref?.white ?? 0.5,
    a: 0,
  };
}

/** Interpolate one matched pair; a missing side is the centre seed. */
function morphDot(
  a: Dot | undefined,
  b: Dot | undefined,
  e: number,
  cx: number,
  cy: number,
): Dot {
  const from = a ?? seed(b, cx, cy);
  const to = b ?? seed(a, cx, cy);
  return {
    x: mix(from.x, to.x, e),
    y: mix(from.y, to.y, e),
    z: mix(from.z, to.z, e),
    r: mix(from.r, to.r, e),
    white: mix(from.white, to.white, e),
    a: mix(from.a ?? 1, to.a ?? 1, e),
  };
}

/**
 * Morph one dot cloud into another. Both are sorted by angle so a dot travels
 * the short way to its counterpart; the larger count sets the sample size, so a
 * sparser cloud splits to fill — or collapses from — the denser one, and any
 * leftover dots emerge from / sink into the centre.
 */
function morphFrame(from: Dot[], to: Dot[], e: number, size: number): OrbFrame {
  const k = Math.max(from.length, to.length);
  if (k === 0) return EMPTY_FRAME;
  const cx = size / 2;
  const cy = size / 2;
  const a = byAngle(from, cx, cy);
  const b = byAngle(to, cx, cy);
  const dots: Dot[] = [];
  for (let i = 0; i < k; i++) {
    const da = a[Math.floor((i * a.length) / k)];
    const db = b[Math.floor((i * b.length) / k)];
    dots.push(morphDot(da, db, e, cx, cy));
  }
  return finalizeFrame(dots, []);
}

/**
 * One animated orb bound to a canvas. Construct once, then push state with
 * {@link setState}; `null` fades it out. A state change morphs — the outgoing
 * dot cloud reshapes into the incoming one — rather than hard-cutting. Call
 * {@link dispose} before dropping the node so the rAF loop and observers are
 * released.
 */
export class OrbView {
  readonly node: HTMLCanvasElement = document.createElement("canvas");
  readonly #ctx: CanvasRenderingContext2D | null;
  readonly #size: OrbSize;
  readonly #dark: boolean;
  readonly #dpr: number;
  readonly #label: string | undefined;
  readonly #transitionMs: number;
  readonly #io: IntersectionObserver | null;
  readonly #reduceMq: MediaQueryList | null;
  #state: OrbState | null = null;
  /** The incoming state's render, or null while fading out to nothing. */
  #current: OrbLayer | null = null;
  /** The outgoing state's render while a crossfade is in flight. */
  #previous: OrbLayer | null = null;
  /** `performance.now()` when the current crossfade began; 0 once settled. */
  #transitionStart = 0;
  #raf = 0;
  #running = false;
  #visible = true;
  #reduced = false;

  readonly #onVisibility = (): void => this.#syncRunning();
  readonly #onReduce = (e: MediaQueryListEvent): void => {
    this.#reduced = e.matches;
    // A crossfade is motion: reduced-motion users get the settled frame at once.
    this.#previous = null;
    this.#transitionStart = 0;
    this.#stop();
    if (this.#reduced) this.#renderStatic();
    else this.#restart();
  };

  constructor(options: OrbViewOptions = {}) {
    this.#size = options.size ?? 64;
    this.#dark = options.dark ?? true;
    this.#label = options.label;
    this.#transitionMs = options.transitionMs ?? 380;
    this.#dpr = Math.min(
      2,
      (typeof devicePixelRatio !== "undefined" && devicePixelRatio) || 1,
    );

    const canvas = this.node;
    canvas.width = Math.round(this.#size * this.#dpr);
    canvas.height = Math.round(this.#size * this.#dpr);
    canvas.style.width = `${this.#size}px`;
    canvas.style.height = `${this.#size}px`;
    canvas.style.display = "none";
    canvas.setAttribute("role", "img");
    if (options.className) canvas.className = options.className;
    this.#ctx = canvas.getContext("2d");

    this.#reduceMq =
      typeof matchMedia !== "undefined"
        ? matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    this.#reduced = this.#reduceMq?.matches ?? false;
    this.#reduceMq?.addEventListener("change", this.#onReduce);

    // Pause offscreen orbs so a long session list costs only what's visible.
    this.#io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            const entry = entries[0];
            if (entry) this.#visible = entry.isIntersecting;
            this.#syncRunning();
          })
        : null;
    this.#io?.observe(canvas);

    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", this.#onVisibility);

    this.setState(options.state ?? null);
  }

  /** Switch the animation; `null` fades out. Crossfades from the current state. */
  setState(state: OrbState | null): void {
    if (state === this.#state) return;
    this.#state = state;

    let next: OrbLayer | null = null;
    if (state !== null) {
      const { mode, speed, opts } = resolvePreset(state, this.#size);
      next = { frameFn: MODE_FRAMES[mode], opts, speed };
      this.node.style.display = "block";
    }
    this.node.setAttribute(
      "aria-label",
      state === null ? "Idle" : (this.#label ?? LABELS[state]),
    );

    if (this.#reduced) {
      // Instant swap under reduced motion.
      this.#previous = null;
      this.#current = next;
      this.#transitionStart = 0;
      this.#stop();
      if (next) this.#renderStatic();
      else {
        this.#clear();
        this.node.style.display = "none";
      }
      return;
    }

    this.#previous = this.#current;
    this.#current = next;
    this.#transitionStart = performance.now();
    this.#restart();
  }

  dispose(): void {
    this.#stop();
    this.#io?.disconnect();
    this.#reduceMq?.removeEventListener("change", this.#onReduce);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.#onVisibility);
  }

  #restart(): void {
    this.#stop();
    if (this.#reduced) return;
    // Draw one frame immediately so a pause never blanks the canvas mid-fade.
    if (this.#current || this.#previous) this.#render(performance.now() / 1000);
    this.#syncRunning();
  }

  #syncRunning(): void {
    if (this.#reduced) return;
    const hidden =
      typeof document !== "undefined" && document.visibilityState === "hidden";
    const wants =
      (this.#current !== null || this.#previous !== null) &&
      this.#visible &&
      !hidden;
    if (wants) this.#start();
    else this.#stop();
  }

  #start(): void {
    if (this.#running || (!this.#current && !this.#previous)) return;
    this.#running = true;
    const loop = (): void => {
      if (!this.#running) return;
      this.#render(performance.now() / 1000);
      if (this.#running) this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
  }

  #stop(): void {
    this.#running = false;
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  /** Paint one frame: the current geometry, or a dot-morph mid-transition. */
  #render(nowSec: number): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#size, this.#size);

    const cur = this.#current;
    if (this.#transitionStart === 0) {
      // Settled: paint the current state at full fidelity (lines included).
      if (cur)
        paintFrame(
          ctx,
          cur.frameFn(this.#size, nowSec * cur.speed, cur.opts),
          this.#dark,
        );
      return;
    }

    const p = Math.min(
      1,
      (performance.now() - this.#transitionStart) / this.#transitionMs,
    );
    const e = p * p * (3 - 2 * p); // smoothstep
    const prev = this.#previous;
    const from = prev
      ? prev.frameFn(this.#size, nowSec * prev.speed, prev.opts)
      : EMPTY_FRAME;
    const to = cur
      ? cur.frameFn(this.#size, nowSec * cur.speed, cur.opts)
      : EMPTY_FRAME;
    // The connecting web's line segments have no dot correspondence — crossfade
    // them under the morphing dots.
    if (from.lines.length) {
      ctx.globalAlpha = 1 - e;
      paintLines(ctx, from.lines, this.#dark);
    }
    if (to.lines.length) {
      ctx.globalAlpha = e;
      paintLines(ctx, to.lines, this.#dark);
    }
    ctx.globalAlpha = 1;
    paintFrame(ctx, morphFrame(from.dots, to.dots, e, this.#size), this.#dark);

    if (p >= 1) {
      this.#transitionStart = 0;
      this.#previous = null;
      if (!this.#current) {
        this.node.style.display = "none";
        this.#stop();
      }
    }
  }

  /** Reduced-motion: one settled, representative frame of the current layer. */
  #renderStatic(): void {
    const ctx = this.#ctx;
    const cur = this.#current;
    if (!ctx || !cur) return;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#size, this.#size);
    ctx.globalAlpha = 1;
    paintFrame(ctx, cur.frameFn(this.#size, 0.6, cur.opts), this.#dark);
  }

  #clear(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#size, this.#size);
  }
}

/**
 * The activity a session's orb reflects, richest first. omp's wire model gives
 * us: `streaming` (agent producing output), running async jobs/subagents, a
 * tool call in flight, a streaming assistant message, a `needsAttention` flag,
 * and an `ended` terminal — `sessionActivity` collapses those to one verb.
 */
type SessionActivity =
  | "delegating"
  | "tooling"
  | "composing"
  | "working"
  | "awaiting"
  | "idle"
  | "ended";

interface SessionSignals {
  ended: boolean;
  streaming: boolean;
  needsAttention: boolean;
  /** Async jobs / subagents are running (`JobsFrame.running`). */
  jobsRunning: boolean;
  /** A tool call is mid-flight (its `end` phase has not landed). */
  toolRunning: boolean;
  /** An assistant message block is still streaming its text. */
  composing: boolean;
}

/** Read the live transcript into signals; tool/text only count while streaming. */
function transcriptSignals(
  transcript: TranscriptState | undefined,
  needsAttention: boolean,
): SessionSignals {
  const streaming = transcript?.footer?.streaming ?? false;
  const jobsRunning = (transcript?.jobs?.running.length ?? 0) > 0;
  let toolRunning = false;
  let composing = false;
  if (transcript && streaming) {
    for (const entry of transcript.entries) {
      if (entry.kind === "tool" && !entry.done) toolRunning = true;
      else if (
        entry.kind === "message" &&
        entry.streaming &&
        entry.role === "assistant"
      )
        composing = true;
    }
  }
  return {
    ended: transcript?.ended ?? false,
    streaming,
    needsAttention,
    jobsRunning,
    toolRunning,
    composing,
  };
}

/** Reduce the signals to one activity; more specific work outranks the rest. */
function sessionActivity(signals: SessionSignals): SessionActivity {
  if (signals.ended) return "ended";
  if (signals.needsAttention) return "awaiting";
  if (signals.jobsRunning) return "delegating";
  if (signals.toolRunning) return "tooling";
  if (signals.composing) return "composing";
  if (signals.streaming) return "working";
  return "idle";
}

/**
 * Activity → orb state — the single mapping both placements use; retune here.
 * `ended` maps to `null` (no orb).
 *
 * TODO(astra/fable): produce a custom error/question orb. `awaiting` (a pending
 * ask or approval) and failures (`controlError`, a failed tool) currently reuse
 * `listening` / have no dedicated mark; both want a distinct alert-style orb.
 */
const ACTIVITY_ORB: Record<SessionActivity, OrbState | null> = {
  delegating: "weaving",
  tooling: "searching",
  composing: "composing",
  working: "working",
  awaiting: "listening",
  idle: "breathing",
  ended: null,
};

/**
 * Resolve a session's orb from its live transcript and attention flag; `null`
 * renders no orb. Shared by the sessions list and the in-session strip.
 */
export function orbStateFor(
  transcript: TranscriptState | undefined,
  needsAttention: boolean,
): OrbState | null {
  return ACTIVITY_ORB[
    sessionActivity(transcriptSignals(transcript, needsAttention))
  ];
}

/**
 * The ambient border-pulse a resting session shows in the list — the successor
 * to the old red "needs attention" square. Only resting sessions pulse; while
 * the agent is actively streaming the orb already carries that, so this returns
 * `null`. Priority: a pending decision (you must answer) outranks a landed
 * error, which outranks a plain finished/ended turn.
 *
 * - `question` (amber): a pending ask or approval is waiting on you.
 * - `error` (red): the session came to rest on a `controlError`.
 * - `done` (green): the agent finished a turn (attention flag) or the session ended.
 */
export type SessionPulse = "question" | "error" | "done";

export function sessionPulseFor(
  transcript: TranscriptState | undefined,
  needsAttention: boolean,
  pending: boolean,
): SessionPulse | null {
  if (transcript?.footer?.streaming === true) return null;
  if (pending) return "question";
  const last = transcript?.entries.at(-1);
  if (
    last?.kind === "message" &&
    last.role === "system" &&
    last.msgId.startsWith("control-error:")
  )
    return "error";
  if (transcript?.ended === true) return "done";
  // A bare attention flag means the agent finished a turn and wants a look.
  if (needsAttention) return "done";
  return null;
}
