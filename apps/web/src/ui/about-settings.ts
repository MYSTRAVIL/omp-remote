/// <reference lib="dom" />
import type { RelayState } from "../core/client";
import type { MachineNode } from "../core/session-tree";
import { timeAgo } from "../core/time-format";
import { button, element, icon, setText, syncChildren, uniqueId } from "./dom";
import type { ControlHandlers } from "./render";

const RELAY_LABELS: Record<RelayState, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  offline: "Offline",
};

/** When an update landed, in the reader's locale: date and time. */
const updatedAt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** One machine under Connection: its name, then online or when last seen. */
interface MachineLine {
  readonly name: HTMLElement;
  readonly status: HTMLElement;
  /** "Online", "Last seen " before `seen`, or never seen. */
  readonly text: HTMLElement;
  readonly seen: HTMLTimeElement;
}

/**
 * Settings > About: which build this is, the way to how this browser's data
 * is protected, the link to the relay and to each paired machine, and the
 * updates this browser took. The connection lines redraw while Settings is
 * open, so they stay live.
 */
export class AboutSettings {
  readonly node = element("section", "settings-section about-settings");
  readonly #build = element("p", "section-copy about-build");
  readonly #connection = element("dl", "about-connection");
  readonly #relayName = element("dt", "about-connection-name", "Relay");
  readonly #relayStatus = element("dd", "about-connection-status");
  readonly #machines = new Map<string, MachineLine>();
  readonly #machinesEmpty = element("p", "field-hint", "No machines yet.");
  readonly #updates = element("ol", "about-updates");
  readonly #updatesEmpty = element(
    "p",
    "field-hint",
    "No updates recorded in this browser yet.",
  );

  /** `onProtection` opens "How your data is protected". */
  constructor(onProtection: () => void) {
    const heading = element("h3", "section-title", "About");
    heading.id = uniqueId("settings-section");
    this.node.setAttribute("aria-labelledby", heading.id);
    const protection = button(
      "How your data is protected",
      "button secondary settings-link",
    );
    protection.append(icon("chevron"));
    protection.addEventListener("click", onProtection);
    const connection = element("h4", "settings-subtitle", "Connection");
    connection.id = uniqueId("about-connection");
    this.#connection.setAttribute("aria-labelledby", connection.id);
    const updates = element("h4", "settings-subtitle", "Recent updates");
    updates.id = uniqueId("about-updates");
    this.#updates.setAttribute("aria-labelledby", updates.id);
    this.node.append(
      heading,
      this.#build,
      protection,
      connection,
      element(
        "p",
        "section-copy",
        "Last seen is when this device last saw a machine online.",
      ),
      this.#connection,
      this.#machinesEmpty,
      updates,
      element(
        "p",
        "section-copy",
        "Builds this browser updated to, newest first.",
      ),
      this.#updates,
      this.#updatesEmpty,
    );
  }

  /**
   * Settings opened: this build and the updates this browser took, which
   * change only from one page load to the next.
   */
  reset(handlers: ControlHandlers): void {
    const build = handlers.build;
    this.#build.hidden = build === undefined;
    setText(this.#build, build === undefined ? "" : `Build ${build.id}`);
    const history = build?.updates() ?? [];
    this.#updates.replaceChildren(
      ...history.map(({ sha, at }) => {
        const moment = new Date(at);
        const time = element(
          "time",
          "about-update-time",
          updatedAt.format(moment),
        );
        time.dateTime = moment.toISOString();
        const item = element("li", "about-update");
        item.append(element("span", "about-update-build", sha), time);
        return item;
      }),
    );
    this.#updates.hidden = history.length === 0;
    this.#updatesEmpty.hidden = history.length > 0;
  }

  /**
   * The relay link and each machine, from live state. A machine counts as
   * online only while the relay link is up: the tree keeps the last machine
   * list through a drop.
   */
  update(tree: readonly MachineNode[], handlers: ControlHandlers): void {
    const relay = handlers.relayState?.();
    const lines: HTMLElement[] = [];
    if (relay !== undefined) {
      setText(this.#relayStatus, RELAY_LABELS[relay]);
      this.#relayStatus.classList.toggle("is-online", relay === "connected");
      lines.push(this.#relayName, this.#relayStatus);
    }
    const reachable = relay === undefined || relay === "connected";
    const now = Date.now();
    const placed = new Set<string>();
    const place = (machineId: string, label: string, online: boolean): void => {
      placed.add(machineId);
      let line = this.#machines.get(machineId);
      if (!line) {
        line = this.#createLine();
        this.#machines.set(machineId, line);
      }
      setText(line.name, label);
      const lastSeen = online
        ? undefined
        : handlers.machineLastSeen?.(machineId);
      line.status.classList.toggle("is-online", online);
      setText(
        line.text,
        online
          ? "Online"
          : lastSeen === undefined
            ? "Not seen online on this device yet"
            : "Last seen ",
      );
      line.seen.hidden = lastSeen === undefined;
      if (lastSeen === undefined) {
        // Nothing from a last-seen line lingers once the machine is online.
        setText(line.seen, "");
      } else {
        const at = new Date(lastSeen);
        const stamp = at.toISOString();
        if (line.seen.dateTime !== stamp) {
          line.seen.dateTime = stamp;
          line.seen.title = at.toLocaleString();
        }
        setText(line.seen, timeAgo(lastSeen, now));
      }
      lines.push(line.name, line.status);
    };
    // Cached rows awaiting this load's snapshot, or kept for a machine the
    // relay no longer lists, do not show a machine online.
    for (const machine of tree)
      place(
        machine.machineId,
        machine.label,
        reachable && !machine.stale && !machine.offline,
      );
    // Paired here but not listed by the relay: offline.
    for (const [machineId, label] of handlers.pairedMachines?.() ?? [])
      if (!placed.has(machineId)) place(machineId, label, false);
    for (const machineId of this.#machines.keys())
      if (!placed.has(machineId)) this.#machines.delete(machineId);
    syncChildren(this.#connection, lines);
    this.#connection.hidden = lines.length === 0;
    this.#machinesEmpty.hidden = placed.size > 0;
  }

  #createLine(): MachineLine {
    const name = element("dt", "about-connection-name");
    const status = element("dd", "about-connection-status");
    const text = element("span", "");
    const seen = element("time", "");
    status.append(text, seen);
    return { name, status, text, seen };
  }
}
