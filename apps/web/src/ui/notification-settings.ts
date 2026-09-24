/// <reference lib="dom" />
import type { PushEnrolment, PushState } from "../core/push-subscribe";
import { type Switch, preferenceSwitch, toggleSwitch } from "./choices";
import { button, element, setText, uniqueId } from "./dom";

/** The line under the switch: what push really does on this device now. */
function describeState(state: PushState, enabled: boolean): string {
  switch (state.status) {
    case "unsupported":
      return "This browser can't get push notifications here. On iPhone or iPad, add OMP Remote to your Home Screen and open it from there.";
    case "blocked":
      return `Notifications are blocked for OMP Remote. Allow them in this site's browser settings, or in your phone's settings for the installed app, then ${enabled ? "choose Try again" : "turn push notifications on"}.`;
    case "turning-on":
      return "Turning on push notifications…";
    case "turning-off":
      return "Turning off push notifications…";
    case "on":
      return "On. This device gets a notification when a session needs your attention.";
    case "failed":
      return `On, but this device isn't registered for notifications: ${state.problem}.`;
    case "off":
      return state.problem === undefined
        ? "Off. This device gets no push notifications."
        : `Couldn't turn on push notifications: ${state.problem}.`;
  }
}

/**
 * Settings > Notifications: whether this device gets push notifications, and
 * whether they stay quiet while the app is on screen. The switch shows the
 * saved choice and the line under it what push really does here now; the
 * quiet switch waits until push is on. Redrawn while Settings is open, so a
 * registration finishing in the background shows at once.
 */
export class NotificationSettings {
  readonly node = element("section", "settings-section notification-settings");
  readonly #push: PushEnrolment;
  readonly #switch: Switch;
  readonly #retry = button("Try again", "button secondary push-retry");
  readonly #quiet: Switch & { sync(): void };
  readonly #status = element("p", "field-hint preference-status");

  constructor(push: PushEnrolment) {
    this.#push = push;
    const preferences = push.preferences;
    const heading = element("h3", "section-title", "Notifications");
    heading.id = uniqueId("settings-section");
    this.node.setAttribute("aria-labelledby", heading.id);
    this.#status.setAttribute("role", "status");

    this.#switch = toggleSwitch({
      label: "Push notifications",
      onChange: (on) => {
        setText(this.#status, "");
        void push.setEnabled(on);
        this.update();
      },
    });
    // The line under the switch changes as registration goes; say so.
    this.#switch.hint.setAttribute("role", "status");
    this.#retry.addEventListener("click", () => {
      void push.setEnabled(true);
      this.update();
    });
    this.#switch.node.append(this.#retry);

    this.#quiet = preferenceSwitch(
      "Quiet while the app is open",
      () => preferences.quietWhileOpen,
      (on) => preferences.setQuietWhileOpen(on),
      this.#status,
      "OMP Remote hides new notifications while it is on screen on this device. After you switch away, they show as usual.",
    );

    this.node.append(
      heading,
      element(
        "p",
        "section-copy",
        "Each notification names the session that needs you, its machine and what it is waiting for. It is end-to-end encrypted, so the relay passes it on without reading it, and it goes away once the session is answered.",
      ),
      element(
        "p",
        "section-copy",
        "A machine sends one only after you have been away from its keyboard and mouse for a while; set how long for each machine under Machines. You can't choose which kinds of notifications you get yet.",
      ),
      this.#switch.node,
      this.#quiet.node,
      this.#status,
    );
    this.update();
  }

  /** Settings reopened: the saved choices, what push does now, and no outcome from last time. */
  reset(): void {
    this.#quiet.sync();
    this.update();
    setText(this.#status, "");
  }

  /** Show what push does on this device now; Settings calls it on every redraw while open. */
  update(): void {
    const { preferences, state } = this.#push;
    const enabled = preferences.enabled;
    // The saved choice, or the one being made; never "on" where push can't work.
    const on =
      state.status !== "unsupported" &&
      (enabled || state.status === "turning-on");
    this.#switch.input.disabled = state.status === "unsupported";
    this.#switch.set(on);
    this.#quiet.input.disabled = !on;
    const retry =
      enabled && (state.status === "failed" || state.status === "blocked");
    // Hiding the focused Try again would drop focus to the page.
    if (!retry && document.activeElement === this.#retry)
      this.#switch.input.focus();
    this.#retry.hidden = !retry;
    setText(this.#switch.hint, describeState(state, enabled));
  }
}
