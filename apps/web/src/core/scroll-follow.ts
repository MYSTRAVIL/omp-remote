// Chat scroll-follow: the feed sticks to the newest content only while the
// reader is at the bottom. Any upward move by the reader (wheel, touch,
// keyboard, scrollbar) stops following until they return to the bottom or tap
// "Jump to latest". Our own scrollTop writes never count as reader intent.
// With auto-scroll off the view never follows new content: content that lands
// below a reader at the bottom is flagged as new, and only "Jump to latest"
// moves it. A pure resize still keeps that reader at the bottom.
//
// Opening a chat (first time or coming back) lands on the newest content and
// stays pinned there, whatever the auto-scroll setting, while the replay and
// late layout (images, markdown) settle — until the reader first scrolls,
// wheels, or touches the feed. From then on the rules above apply.
//
// Pure state machine; the view feeds it DOM measurements and applies `pin`.

/** Distance from the bottom that still counts as "at the bottom" (sub-pixel
 *  rounding, a trailing margin). Small on purpose: a reader who moved up a
 *  line is reading, not following. */
export const BOTTOM_SLACK_PX = 24;

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface FollowState {
  /** Auto-scroll: keep a reader who is at the newest content there as more
   *  arrives. Off, the view only moves when the reader asks. */
  readonly autoScroll: boolean;
  /** The reader is at the newest content; with `autoScroll` the view keeps
   *  them there. */
  readonly following: boolean;
  /** Content arrived below the view while not following. */
  readonly unseen: boolean;
  /** Last observed scrollTop (reader or programmatic). */
  readonly lastTop: number;
  /** Content height at the last observation, to detect new content. */
  readonly lastHeight: number;
  /** scrollTop our own last write produced; its scroll event is not intent. */
  readonly expectedTop: number | null;
  /** The view just opened: pin to the newest content on every change until
   *  the reader first moves the feed. */
  readonly landing: boolean;
}

export type FollowEvent =
  /** A scroll event fired on the feed. */
  | { readonly kind: "scroll"; readonly metrics: ScrollMetrics }
  /** Wheel up, a finger dragging the content down, or an upward key, seen
   *  before the resulting scroll event. */
  | { readonly kind: "intentUp"; readonly metrics: ScrollMetrics }
  /** Content or viewport size changed (a redraw, a resize). */
  | { readonly kind: "content"; readonly metrics: ScrollMetrics }
  /** We wrote scrollTop; `metrics` is read back after the write. */
  | { readonly kind: "programmatic"; readonly metrics: ScrollMetrics }
  /** The reader asked for the newest content. */
  | { readonly kind: "jump" }
  /** The reader turned auto-scroll on or off. */
  | { readonly kind: "autoScroll"; readonly on: boolean }
  /** The view opened or came back from hidden. */
  | { readonly kind: "open" }
  /** The reader touched or wheeled the feed, in any direction. */
  | { readonly kind: "interact" };

export const initialFollowState: FollowState = {
  autoScroll: true,
  following: true,
  unseen: false,
  lastTop: 0,
  lastHeight: 0,
  expectedTop: null,
  landing: false,
};

export function atBottom(metrics: ScrollMetrics): boolean {
  return (
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <=
    BOTTOM_SLACK_PX
  );
}

/** Whether the view pins to the bottom after content or size changed: always
 *  while landing; otherwise a following reader stays there with auto-scroll,
 *  and without it while nothing new grew the content, so a pure resize (the
 *  keyboard opening, the composer growing) never drops the newest message
 *  below the fold. Only real new content waits for "Jump to latest". */
export function keepsPinned(
  state: FollowState,
  metrics: ScrollMetrics,
): boolean {
  return (
    state.landing ||
    (state.following &&
      (state.autoScroll || metrics.scrollHeight <= state.lastHeight))
  );
}

export function nextFollow(
  state: FollowState,
  event: FollowEvent,
): FollowState {
  switch (event.kind) {
    case "scroll": {
      const { metrics } = event;
      const top = metrics.scrollTop;
      if (state.expectedTop !== null && Math.abs(top - state.expectedTop) <= 1)
        return { ...state, lastTop: top, expectedTop: null };
      // Moving up is reading, even inside the bottom slack. Compare positions
      // clamped to the current maximum: an iOS rubber-band settling back from
      // past the bottom, or the browser clamping a shrunk transcript, moves
      // scrollTop up without the reader leaving the bottom.
      const max = metrics.scrollHeight - metrics.clientHeight;
      const upward = Math.min(top, max) < Math.min(state.lastTop, max);
      if (upward)
        return {
          ...state,
          following: false,
          lastTop: top,
          expectedTop: null,
          landing: false,
        };
      // Still at the bottom (a clamp, a bounce, a nudge down): the reader has
      // not left the newest content, so landing holds.
      if (atBottom(metrics))
        return {
          ...state,
          following: true,
          unseen: false,
          lastTop: top,
          lastHeight: metrics.scrollHeight,
          expectedTop: null,
        };
      return { ...state, lastTop: top, expectedTop: null, landing: false };
    }
    case "intentUp":
      // Nothing above to move to: the gesture scrolls nothing, so it is not
      // a decision to stop following.
      if (event.metrics.scrollTop <= 0) return state;
      return { ...state, following: false, landing: false };
    case "content": {
      const { metrics } = event;
      // A landing view always follows. Content that fits the view leaves
      // nothing to read above: follow. A following reader stays at the newest
      // content when auto-scroll pinned them there, or when nothing new
      // reached below the view.
      if (
        state.landing ||
        metrics.scrollHeight <= metrics.clientHeight ||
        (state.following && (state.autoScroll || atBottom(metrics)))
      )
        return {
          ...state,
          following: true,
          unseen: false,
          lastHeight: metrics.scrollHeight,
        };
      const grew = metrics.scrollHeight > state.lastHeight;
      return {
        ...state,
        following: false,
        unseen: state.unseen || (grew && !atBottom(metrics)),
        lastHeight: metrics.scrollHeight,
      };
    }
    case "programmatic": {
      // A write that did not move fires no scroll event; expecting one would
      // swallow the reader's next scroll that lands on the same spot. Height
      // is left to the `content` event that follows every write, so content
      // that arrived before a restore still counts as unseen.
      const top = event.metrics.scrollTop;
      return {
        ...state,
        lastTop: top,
        expectedTop: top === state.lastTop ? state.expectedTop : top,
      };
    }
    case "jump":
      return { ...state, following: true, unseen: false };
    case "autoScroll":
      return { ...state, autoScroll: event.on };
    case "open":
      return { ...state, landing: true, following: true, unseen: false };
    case "interact":
      return state.landing ? { ...state, landing: false } : state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** Keys that move a focused scroll container up. */
export function isUpwardKey(key: string, shiftKey: boolean): boolean {
  return (
    key === "ArrowUp" ||
    key === "PageUp" ||
    key === "Home" ||
    (key === " " && shiftKey)
  );
}
