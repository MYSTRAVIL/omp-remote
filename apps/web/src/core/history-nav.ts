/// <reference lib="dom" />
// History-backed session navigation. The PWA renders the sessions tree and a
// single open session from in-app state alone — nothing touches the browser
// history — so on a session the Android/browser back gesture finds no entry to
// pop and leaves the app entirely.
//
// The fix keeps a two-level history: the tree (home) and at most one "a session
// is open" entry. Opening a session from the tree pushes that entry; switching
// session→session replaces it, matching the app's flat tree↔detail shape, so
// the tree is always exactly one back away and only the tree exits the app.
// The selection mirrors the tree/session entry history is on: whatever lands
// there — our own back, the gesture, a multi-step jump, forward — sets it, so
// the view shown always matches what the next back will do.
//
// Overlays (image viewer, dialogs, model drawer, send menu) stack above that:
// each open overlay owns exactly one entry, tagged with its depth above the
// tree/session entry and carrying that entry's session id. Back pops the top
// overlay's entry and closes it without touching the selection; an overlay
// that closes itself (Close, Escape, backdrop) calls `dismiss`, which pops its
// entry with one `history.back()`. Landing on an overlay entry never changes
// the selection either: it is an open overlay's own, or a stray (forward onto
// a dismissed overlay's entry) that is popped straight back off, and the entry
// below it decides.
//
// `history.back()` is asynchronous: a push or replace made before its popstate
// arrives lands on the entry being popped. So history is only written while
// settled — no back() of ours in flight and no entry left above the open
// overlays — and an open/back/overlay requested meanwhile is held, in order,
// until the popstate lands. A session transition with overlays open closes
// them first and pops their entries (one back() at a time), then applies the
// push/replace, so the tree stays exactly one back away. We only back() off an
// overlay entry or a session entry, and each always sits on an entry of ours
// (a session entry is only ever pushed from the tree's), so the awaited
// popstate always arrives and a held request never waits forever.

/** The slice of `History` used here, narrowed so a fake can drive the tests. */
export interface HistoryLike {
  pushState(data: unknown, unused: string): void;
  replaceState(data: unknown, unused: string): void;
  back(): void;
}

export interface SessionHistoryDeps {
  history: HistoryLike;
  /** Apply a selection; undefined shows the tree. Only this module selects. */
  select(sessionId: string | undefined): void;
  /** Subscribe to browser back/forward with the target entry's raw state. */
  onPopState(handler: (state: unknown) => void): void;
}

/** The history entry an open overlay holds. */
export interface OverlayEntry {
  /**
   * The overlay closed itself (Close, Escape, backdrop, Cancel): pop its entry.
   * A no-op once back or a navigation has closed it, and on repeat calls.
   */
  dismiss(): void;
}

export interface SessionHistory {
  /** Open a session, adding (or replacing) the single detail entry. */
  open(sessionId: string): void;
  /** Pop the detail entry back to the tree; a no-op when already on the tree. */
  back(): void;
  /**
   * Give a just-opened overlay its own entry so back runs `close` instead of
   * leaving the view. A navigation away runs `close` too; calling `dismiss`
   * from inside it is harmless.
   */
  overlay(close: () => void): OverlayEntry;
}

interface NavEntry {
  sessionId?: string;
  /** An overlay entry's depth above its tree/session entry (1 = lowest). */
  overlay?: number;
}

/** Recover a session id from an untrusted history entry state. */
function sessionIdOf(state: unknown): string | undefined {
  if (state === null || typeof state !== "object") return undefined;
  const id = (state as NavEntry).sessionId;
  return typeof id === "string" ? id : undefined;
}

/** An untrusted entry state's overlay depth; 0 for a tree/session entry. */
function overlayDepthOf(state: unknown): number {
  if (state === null || typeof state !== "object") return 0;
  const depth = (state as NavEntry).overlay;
  return typeof depth === "number" && Number.isInteger(depth) && depth > 0
    ? depth
    : 0;
}

interface OverlaySlot {
  readonly close: () => void;
  /** `queued` while its entry waits for history to settle. */
  status: "queued" | "open" | "closed";
}

/**
 * Wire selection to browser history and return the navigation verbs the app
 * calls in place of selecting directly. Installs a `popstate` handler and
 * normalises the boot entry, so a reload's stale state can't drive the first
 * back into a phantom session.
 */
export function installSessionHistory(
  deps: SessionHistoryDeps,
): SessionHistory {
  const { history } = deps;
  /** Open overlays, bottom first; slot i owns the entry at depth i + 1. */
  const slots: OverlaySlot[] = [];
  /**
   * The session of the tree/session entry history is on (undefined: the tree),
   * as last written or landed on. Pushes and pops go by it, never by a view
   * state, and the selection mirrors it.
   */
  let session: string | undefined;
  /** The current entry's overlay depth, as last written or landed on. */
  let depth = 0;
  /** Our back() awaits its popstate. */
  let traversing = false;
  /** Requests made while unsettled, run in order once history settles. */
  const held: (() => void)[] = [];

  const settled = (): boolean => !traversing && depth === slots.length;

  /** Close the overlays at stack index `from` and above, top first. */
  const closeFrom = (from: number): void => {
    const closing = slots.splice(from).reverse();
    for (const slot of closing) slot.status = "closed";
    for (const slot of closing) slot.close();
  };

  /** Pop entries left above the open overlays, then run held requests. */
  const pump = (): void => {
    while (!traversing) {
      if (depth > slots.length) {
        traversing = true;
        history.back();
        return;
      }
      const next = held.shift();
      if (next === undefined) return;
      next();
    }
  };

  /** Close every overlay and pop their entries, then re-run `retry` first. */
  const clearOverlays = (retry: () => void): void => {
    closeFrom(0);
    held.unshift(retry);
    pump();
  };

  const open = (sessionId: string): void => {
    if (!settled()) {
      held.push(() => open(sessionId));
      return;
    }
    if (session === sessionId) return;
    // Overlays belong to the view being left.
    if (slots.length > 0) {
      clearOverlays(() => open(sessionId));
      return;
    }
    const entry: NavEntry = { sessionId };
    // Tree → session opens a poppable entry; session → session replaces it so
    // the tree stays exactly one back away.
    if (session === undefined) history.pushState(entry, "");
    else history.replaceState(entry, "");
    session = sessionId;
    deps.select(sessionId);
  };

  const back = (): void => {
    if (!settled()) {
      held.push(back);
      return;
    }
    if (slots.length > 0) {
      clearOverlays(back);
      return;
    }
    // Already on the tree (e.g. the rail "Sessions" button): stay put rather
    // than popping the tree's own entry and leaving the app.
    if (session === undefined) return;
    traversing = true;
    history.back();
  };

  const overlay = (close: () => void): OverlayEntry => {
    const slot: OverlaySlot = { close, status: "queued" };
    const push = (): void => {
      if (slot.status !== "queued") return; // dismissed before its turn
      slot.status = "open";
      slots.push(slot);
      depth = slots.length;
      const entry: NavEntry = { sessionId: session, overlay: depth };
      history.pushState(entry, "");
    };
    if (settled()) push();
    else held.push(push);
    return {
      dismiss() {
        const wasOpen = slot.status === "open";
        slot.status = "closed";
        if (!wasOpen) return;
        // Overlay entries are interchangeable, so one back() retires this
        // slot's entry even when it sits below another open overlay.
        slots.splice(slots.indexOf(slot), 1);
        pump();
      },
    };
  };

  history.replaceState({} satisfies NavEntry, "");
  deps.onPopState((state) => {
    traversing = false;
    depth = overlayDepthOf(state);
    // Overlays whose entries were popped close: a back gesture closes the top.
    closeFrom(depth);
    // A tree/session entry sets the selection, whatever traversed to it; an
    // overlay entry keeps it (a stray one is popped next, and the entry below
    // it decides).
    const id = sessionIdOf(state);
    if (depth === 0 && id !== session) {
      session = id;
      deps.select(id);
    }
    pump();
  });
  return { open, back, overlay };
}
