import { describe, expect, test } from "bun:test";
import {
  type FollowEvent,
  type FollowState,
  type ScrollMetrics,
  initialFollowState,
  keepsPinned,
  nextFollow,
} from "../src/core/scroll-follow";

const VIEW = 600;
const at = (scrollTop: number, scrollHeight: number): ScrollMetrics => ({
  scrollTop,
  scrollHeight,
  clientHeight: VIEW,
});
const run = (state: FollowState, ...events: FollowEvent[]): FollowState =>
  events.reduce(nextFollow, state);

/** Following at the bottom of a 2000 px transcript, as after a first draw. */
const pinned = run(initialFollowState, {
  kind: "programmatic",
  metrics: at(1400, 2000),
});

describe("scroll follow", () => {
  test("a reader who scrolls up mid-stream is not pulled back down", () => {
    const reading = run(
      pinned,
      { kind: "scroll", metrics: at(1400, 2000) }, // our own pin's event
      { kind: "scroll", metrics: at(1350, 2000) }, // reader moves up 50 px
    );
    expect(reading.following).toBe(false);
    // The stream keeps growing the transcript; the view must stay put.
    const streamed = run(
      reading,
      { kind: "content", metrics: at(1350, 2400) },
      { kind: "content", metrics: at(1350, 2900) },
    );
    expect(streamed.following).toBe(false);
    expect(streamed.unseen).toBe(true);
  });

  test("with auto-scroll off, content growing below a reader at the bottom leaves the view put; Jump to latest still goes there", () => {
    const off = run(pinned, { kind: "autoScroll", on: false });
    const grown = run(off, { kind: "content", metrics: at(1400, 2600) });
    expect(grown.following).toBe(false);
    expect(grown.unseen).toBe(true);
    const jumped = run(grown, { kind: "jump" });
    expect(jumped.following).toBe(true);
    expect(jumped.unseen).toBe(false);
    // Turned back on, a reader at the bottom is kept there again.
    const on = run(
      jumped,
      { kind: "programmatic", metrics: at(2000, 2600) },
      { kind: "autoScroll", on: true },
      { kind: "content", metrics: at(2000, 3000) },
    );
    expect(on.following).toBe(true);
  });

  test("an upward gesture stops following before its scroll event lands", () => {
    // A redraw can run between the wheel/touch/key and the scroll event.
    const state = run(pinned, {
      kind: "intentUp",
      metrics: at(1400, 2000),
    });
    expect(state.following).toBe(false);
  });

  test("an upward gesture with nothing above does not stop following", () => {
    const short = run(initialFollowState, {
      kind: "intentUp",
      metrics: at(0, 300),
    });
    expect(short.following).toBe(true);
  });

  test("returning to the bottom resumes following and clears the indicator", () => {
    const away = run(
      pinned,
      { kind: "scroll", metrics: at(900, 2000) },
      { kind: "content", metrics: at(900, 2600) },
    );
    expect(away.unseen).toBe(true);
    const back = run(away, { kind: "scroll", metrics: at(1990, 2600) });
    expect(back.following).toBe(true);
    expect(back.unseen).toBe(false);
  });

  test("scrolling down short of the bottom does not resume following", () => {
    const state = run(
      pinned,
      { kind: "scroll", metrics: at(500, 2000) },
      { kind: "scroll", metrics: at(1000, 2000) },
    );
    expect(state.following).toBe(false);
  });

  test("jump to latest resumes following", () => {
    const away = run(
      pinned,
      { kind: "scroll", metrics: at(500, 2000) },
      { kind: "content", metrics: at(500, 2500) },
    );
    const jumped = run(away, { kind: "jump" });
    expect(jumped.following).toBe(true);
    expect(jumped.unseen).toBe(false);
  });

  test("our own pin's scroll event does not undo the reader's upward gesture", () => {
    const state = run(
      pinned,
      // A redraw pins to the new bottom...
      { kind: "content", metrics: at(1400, 2600) },
      { kind: "programmatic", metrics: at(2000, 2600) },
      // ...the reader wheels up before the pin's scroll event is dispatched...
      { kind: "intentUp", metrics: at(2000, 2600) },
      // ...and the pin's event, still at the bottom, must not re-follow.
      { kind: "scroll", metrics: at(2000, 2600) },
      { kind: "content", metrics: at(2000, 3000) },
    );
    expect(state.following).toBe(false);
    expect(state.unseen).toBe(true);
  });

  test("a reader scroll right after our write is still seen as intent", () => {
    const state = run(
      pinned,
      { kind: "content", metrics: at(1400, 2600) },
      { kind: "programmatic", metrics: at(2000, 2600) },
      // The reader flicked up before our write's scroll event was dispatched;
      // the coalesced event reports the reader's position.
      { kind: "scroll", metrics: at(1700, 2600) },
    );
    expect(state.following).toBe(false);
  });

  test("a slow move up inside the bottom slack still stops following", () => {
    const settled = run(pinned, { kind: "scroll", metrics: at(1400, 2000) });
    // A slow touch or trackpad scroll: small steps, each within 24 px.
    const touch = run(
      settled,
      { kind: "intentUp", metrics: at(1400, 2000) },
      { kind: "scroll", metrics: at(1390, 2000) },
    );
    expect(touch.following).toBe(false);
    // A scrollbar drag sends no gesture event, only scroll events.
    const drag = run(settled, { kind: "scroll", metrics: at(1390, 2000) });
    expect(drag.following).toBe(false);
  });

  test("a shrinking transcript at the bottom keeps following", () => {
    const state = run(
      pinned,
      { kind: "content", metrics: at(1400, 2000) },
      { kind: "scroll", metrics: at(1400, 2000) },
      // The browser clamps scrollTop to the new, shorter bottom.
      { kind: "scroll", metrics: at(1200, 1800) },
    );
    expect(state.following).toBe(true);
  });

  test("a bounce settling back from past the bottom keeps following", () => {
    // iOS reports scrollTop beyond the maximum (1400) while it rubber-bands.
    const state = run(
      pinned,
      { kind: "scroll", metrics: at(1400, 2000) },
      { kind: "scroll", metrics: at(1440, 2000) },
      { kind: "scroll", metrics: at(1410, 2000) },
      { kind: "scroll", metrics: at(1400, 2000) },
    );
    expect(state.following).toBe(true);
  });

  test("content that arrived before a restore is still flagged as new", () => {
    const away = run(
      pinned,
      { kind: "content", metrics: at(1400, 2000) },
      { kind: "scroll", metrics: at(500, 2000) },
    );
    // The session was in the background; on return we restore the place.
    const restored = run(
      away,
      { kind: "programmatic", metrics: at(500, 2600) },
      { kind: "content", metrics: at(500, 2600) },
    );
    expect(restored.following).toBe(false);
    expect(restored.unseen).toBe(true);
  });

  test("content that fits the view resumes following", () => {
    const away = run(pinned, { kind: "scroll", metrics: at(500, 2000) });
    const reset = run(away, { kind: "content", metrics: at(0, 400) });
    expect(reset.following).toBe(true);
    expect(reset.unseen).toBe(false);
  });

  describe("landing on open", () => {
    /** What the view does on a redraw or resize: pin when the state says so,
     *  then report the content. Returns the state and where the view is. */
    const redraw = (
      state: FollowState,
      top: number,
      height: number,
    ): { state: FollowState; top: number } => {
      const pin = keepsPinned(state, at(top, height));
      const landed = pin ? height - VIEW : top;
      const next = run(
        state,
        ...(pin
          ? [{ kind: "programmatic", metrics: at(landed, height) } as const]
          : []),
        { kind: "content", metrics: at(landed, height) },
      );
      return { state: next, top: landed };
    };

    test("reopening a chat the reader had scrolled up in lands at the bottom", () => {
      const reading = run(pinned, { kind: "scroll", metrics: at(300, 2000) });
      expect(reading.following).toBe(false);
      // Hidden, then shown again with more content.
      const opened = run(reading, { kind: "open" });
      const view = redraw(opened, 300, 2600);
      expect(view.top).toBe(2600 - VIEW);
      expect(view.state.following).toBe(true);
      expect(view.state.unseen).toBe(false);
    });

    test("with auto-scroll off, a replay arriving in two batches lands at the bottom", () => {
      const off = run(
        initialFollowState,
        { kind: "autoScroll", on: false },
        { kind: "open" },
      );
      const first = redraw(off, 0, 1500);
      expect(first.top).toBe(1500 - VIEW);
      const second = redraw(first.state, first.top, 4000);
      expect(second.top).toBe(4000 - VIEW);
      // Late layout (an image decoding) is re-pinned too.
      const late = redraw(second.state, second.top, 4300);
      expect(late.top).toBe(4300 - VIEW);
      expect(late.state.following).toBe(true);
    });

    test("the reader scrolling during landing ends it; the view then keeps their place", () => {
      const off = run(
        initialFollowState,
        { kind: "autoScroll", on: false },
        { kind: "open" },
      );
      const landed = redraw(off, 0, 2000);
      const reading = run(landed.state, {
        kind: "scroll",
        metrics: at(900, 2000),
      });
      expect(reading.landing).toBe(false);
      const grown = redraw(reading, 900, 2600);
      expect(grown.top).toBe(900);
      expect(grown.state.following).toBe(false);
      expect(grown.state.unseen).toBe(true);
    });

    test("a touch or wheel ends landing; auto-scroll off then leaves new content below", () => {
      const off = run(
        initialFollowState,
        { kind: "autoScroll", on: false },
        { kind: "open" },
      );
      const landed = redraw(off, 0, 2000);
      const touched = run(landed.state, { kind: "interact" });
      const grown = redraw(touched, landed.top, 2600);
      expect(grown.top).toBe(landed.top);
      expect(grown.state.unseen).toBe(true);
    });

    test("our own pin's scroll event and a clamp at the bottom keep landing", () => {
      const opened = run(
        initialFollowState,
        { kind: "autoScroll", on: false },
        { kind: "open" },
      );
      const landed = redraw(opened, 0, 2000);
      const settled = run(
        landed.state,
        { kind: "scroll", metrics: at(1400, 2000) }, // our pin's event
        { kind: "scroll", metrics: at(1200, 1800) }, // browser clamp
      );
      expect(settled.landing).toBe(true);
      expect(redraw(settled, 1200, 2500).top).toBe(2500 - VIEW);
    });
  });
});
