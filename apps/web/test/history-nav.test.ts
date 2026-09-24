import { expect, test } from "bun:test";
import {
  type SessionHistory,
  installSessionHistory,
} from "../src/core/history-nav";
import { FakeHistory, pressBack } from "./fixtures/fake-history";

function setup() {
  const history = new FakeHistory();
  /** Every selection applied, in order; the last one is on screen. */
  const selections: (string | undefined)[] = [];
  const nav = installSessionHistory({
    history,
    select: (id) => {
      selections.push(id);
    },
    onPopState: (handler) => history.onPop(handler),
  });
  return { history, nav, selections, selected: () => selections.at(-1) };
}

/** An overlay registered with nav; `closed` counts how often nav closed it. */
function openOverlay(nav: SessionHistory) {
  let closed = 0;
  const entry = nav.overlay(() => {
    closed += 1;
  });
  return { entry, closed: () => closed };
}

test("opening a session pushes a poppable entry and selects it", () => {
  const { history, nav, selected } = setup();
  nav.open("A");
  expect(selected()).toBe("A");
  expect(history.position()).toBe(1);
});

test("back on a session returns to the tree instead of leaving the app", () => {
  const { history, nav, selected } = setup();
  nav.open("A");
  nav.back();
  history.flush();
  expect(selected()).toBeUndefined();
  expect(history.leftApp).toBe(false);
});

test("back on the tree is a no-op, not an app exit", () => {
  const { history, nav, selected } = setup();
  nav.back();
  history.flush();
  expect(selected()).toBeUndefined();
  expect(history.leftApp).toBe(false);
});

test("switching session to session replaces rather than stacks", () => {
  const { history, nav, selected } = setup();
  nav.open("A");
  nav.open("B");
  expect(selected()).toBe("B");
  expect(history.position()).toBe(1);
  nav.back();
  history.flush();
  expect(selected()).toBeUndefined();
});

test("re-opening the current session does not stack history", () => {
  const { history, nav } = setup();
  nav.open("A");
  nav.open("A");
  expect(history.position()).toBe(1);
});

test("back with an overlay open closes it and keeps the session", () => {
  const { history, nav, selected } = setup();
  nav.open("A");
  const viewer = openOverlay(nav);
  pressBack(history);
  expect(viewer.closed()).toBe(1);
  expect(selected()).toBe("A");
  expect(history.position()).toBe(1);
  // The overlay's own late close (a dialog `close` event) pops nothing more.
  viewer.entry.dismiss();
  history.flush();
  expect(history.position()).toBe(1);
  expect(selected()).toBe("A");
});

test("dismissing an overlay pops exactly its own entry", () => {
  const { history, nav, selected } = setup();
  nav.open("A");
  const viewer = openOverlay(nav);
  expect(history.position()).toBe(2);
  viewer.entry.dismiss();
  viewer.entry.dismiss();
  history.flush();
  expect(history.position()).toBe(1);
  expect(selected()).toBe("A");
  expect(viewer.closed()).toBe(0);
});

test("opening a session right after an overlay closes itself lands on that session", () => {
  const { history, nav, selected } = setup();
  nav.open("A");
  openOverlay(nav).entry.dismiss();
  nav.open("B"); // before the dismissal's popstate arrives
  history.flush();
  expect(selected()).toBe("B");
  expect(history.position()).toBe(1);
  nav.back();
  history.flush();
  expect(selected()).toBeUndefined();
  expect(history.leftApp).toBe(false);
  history.forward();
  history.flush();
  expect(selected()).toBe("B");
});

test("going back right after an overlay closes itself still reaches the tree", () => {
  const { history, nav, selected } = setup();
  nav.open("A");
  openOverlay(nav).entry.dismiss();
  nav.back(); // before the dismissal's popstate arrives
  history.flush();
  expect(selected()).toBeUndefined();
  expect(history.position()).toBe(0);
  expect(history.leftApp).toBe(false);
});

test("opening a session with an overlay still up closes it and keeps the tree one back away", () => {
  const { history, nav, selected } = setup();
  const settings = openOverlay(nav); // e.g. settings open while a spawn waits
  nav.open("B"); // the spawned session reports in
  expect(settings.closed()).toBe(1);
  history.flush();
  expect(selected()).toBe("B");
  expect(history.position()).toBe(1);
  // The dialog's own `close` event arrives late: nothing more to pop.
  settings.entry.dismiss();
  history.flush();
  expect(history.position()).toBe(1);
  nav.back();
  history.flush();
  expect(selected()).toBeUndefined();
  expect(history.leftApp).toBe(false);
});

test("an overlay opened on the tree closes on back without leaving the app", () => {
  const { history, nav, selected } = setup();
  const settings = openOverlay(nav);
  pressBack(history);
  expect(settings.closed()).toBe(1);
  expect(selected()).toBeUndefined();
  expect(history.position()).toBe(0);
  expect(history.leftApp).toBe(false);
});

test("stacked overlays close one per back, top first", () => {
  const { history, nav, selected } = setup();
  nav.open("A");
  const viewer = openOverlay(nav);
  const menu = openOverlay(nav);
  pressBack(history);
  expect([viewer.closed(), menu.closed()]).toEqual([0, 1]);
  // The menu's own late close (its popover toggle) leaves the viewer's entry.
  menu.entry.dismiss();
  history.flush();
  expect(history.position()).toBe(2);
  pressBack(history);
  expect([viewer.closed(), menu.closed()]).toEqual([1, 1]);
  expect(selected()).toBe("A");
  expect(history.position()).toBe(1);
});

test("an overlay opened while a dismissal is in flight gets its entry after it", () => {
  const { history, nav, selected } = setup();
  nav.open("A");
  openOverlay(nav).entry.dismiss();
  const next = openOverlay(nav); // before the dismissal's popstate arrives
  history.flush();
  expect(history.position()).toBe(2);
  pressBack(history);
  expect(next.closed()).toBe(1);
  expect(selected()).toBe("A");
  expect(history.position()).toBe(1);
});

test("forward onto a dismissed overlay's entry pops back without closing the open one", () => {
  const { history, nav, selected } = setup();
  nav.open("A");
  const viewer = openOverlay(nav);
  openOverlay(nav).entry.dismiss();
  history.flush();
  history.forward();
  history.flush();
  expect(viewer.closed()).toBe(0);
  expect(selected()).toBe("A");
  expect(history.position()).toBe(2);
  pressBack(history);
  expect(viewer.closed()).toBe(1);
  expect(history.position()).toBe(1);
});

test("jumping back past an open overlay to the tree shows the tree, and nav keeps working", () => {
  const { history, nav, selected } = setup();
  nav.open("A");
  const viewer = openOverlay(nav);
  history.go(-2);
  history.flush();
  expect(viewer.closed()).toBe(1);
  expect(selected()).toBeUndefined();
  // The rail "Sessions" button, now on the tree, stays put.
  nav.back();
  history.flush();
  expect(history.leftApp).toBe(false);
  nav.open("B");
  history.flush();
  expect(selected()).toBe("B");
  expect(history.position()).toBe(1);
});

test("forward onto a closed overlay's entry after a session switch keeps the new session", () => {
  const { history, nav, selections } = setup();
  nav.open("A");
  openOverlay(nav);
  pressBack(history); // closes it; its entry stays forward of A's
  nav.open("B"); // replaces A's entry in place, under that stale entry
  history.forward();
  history.flush();
  // Never even briefly back on A (which would redraw it and clear its
  // attention flag): the stray is popped and B's entry decides.
  expect(selections).toEqual(["A", "B"]);
  expect(history.position()).toBe(1);
});
