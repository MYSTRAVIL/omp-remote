/// <reference lib="dom" />
import type { MachineNode } from "../core/session-tree";
import { timeAgo } from "../core/time-format";
import { type Choice, type Dropdown, dropdown, savedOutcome } from "./choices";
import { button, element, field, setText, syncChildren, uniqueId } from "./dom";
import type { ControlHandlers } from "./render";

/** A row's step: at rest, naming the machine, confirming a forget, forgetting. */
type RowMode = "view" | "rename" | "confirm" | "forgetting";

/** The away times a machine may wait for before it pushes, in seconds. */
const AWAY_CHOICES: readonly Choice<string>[] = [
  { value: "0", label: "Always" },
  { value: "60", label: "1 min" },
  { value: "120", label: "2 min" },
  { value: "300", label: "5 min" },
  { value: "600", label: "10 min" },
  { value: "900", label: "15 min" },
  { value: "1800", label: "30 min" },
  { value: "3600", label: "1 hour" },
];

interface MachineRow {
  readonly machineId: string;
  readonly node: HTMLLIElement;
  readonly name: HTMLElement;
  /** The machine ID, shown before the status once the machine has a name. */
  readonly id: HTMLElement;
  /** "Online · N sessions", or "Last seen" before `seen`. */
  readonly status: HTMLElement;
  /** When this device last saw the machine online, for one that is not online now. */
  readonly seen: HTMLTimeElement;
  readonly actions: HTMLElement;
  readonly rename: HTMLButtonElement;
  readonly forget: HTMLButtonElement;
  readonly renameForm: HTMLFormElement;
  readonly renameInput: HTMLInputElement;
  readonly confirm: HTMLElement;
  readonly question: HTMLElement;
  readonly keep: HTMLButtonElement;
  readonly confirmForget: HTMLButtonElement;
  /** How long the user must be away from the machine before it pushes. */
  readonly away: Dropdown<string>;
  /** The display name last rendered for this machine. */
  label: string;
  mode: RowMode;
}

/**
 * Settings > Machines: every machine in the workspace, each with whether it
 * is online (else when this device last saw it online), a name kept on this
 * device, how long the user must be away from it before it pushes a
 * notification, and a confirmed "Forget on this device". Rows are keyed by
 * machineId and persist across redraws (the store emits on every streamed
 * frame), so a half-typed name and keyboard focus survive live updates.
 */
export class MachineSettings {
  readonly node = element("section", "settings-section");
  readonly #heading = element("h3", "section-title", "Machines");
  readonly #list = element("ul", "settings-machines");
  readonly #empty = element(
    "p",
    "field-hint settings-machines-empty",
    "No machine snapshots received yet.",
  );
  readonly #status = element("p", "field-hint preference-status");
  readonly #rows = new Map<string, MachineRow>();
  #handlers: ControlHandlers;
  /** Called once a machine is forgotten, to drop what else this device keeps for it. */
  readonly #onForgotten: (machineId: string) => void;

  constructor(
    handlers: ControlHandlers,
    onForgotten: (machineId: string) => void,
  ) {
    this.#handlers = handlers;
    this.#onForgotten = onForgotten;
    this.#heading.id = uniqueId("machines");
    // Focus lands here once a forgotten machine's row has gone.
    this.#heading.tabIndex = -1;
    this.#list.setAttribute("aria-labelledby", this.#heading.id);
    this.#status.setAttribute("role", "status");
    this.node.append(
      this.#heading,
      element(
        "p",
        "section-copy",
        "Last seen is when this device last saw a machine online. Your other devices keep their own record.",
      ),
      this.#list,
      this.#empty,
      this.#status,
    );
  }

  update(tree: readonly MachineNode[], handlers: ControlHandlers): void {
    this.#handlers = handlers;
    const canForget = handlers.onForgetMachine !== undefined;
    const notifyAway = handlers.notifyAway;
    const now = Date.now();
    const ids = new Set<string>();
    const rows: HTMLElement[] = [];
    /** `sessions` is the session count of a machine online now; undefined otherwise. */
    const place = (
      machineId: string,
      label: string,
      sessions?: string,
    ): void => {
      ids.add(machineId);
      let row = this.#rows.get(machineId);
      if (!row) {
        row = this.#createRow(machineId);
        this.#rows.set(machineId, row);
      }
      if (row.label !== label) {
        row.label = label;
        setText(row.name, label);
        setText(row.question, `Forget ${label} on this device?`);
        row.rename.setAttribute("aria-label", `Rename ${label}`);
        row.forget.setAttribute("aria-label", `Forget ${label} on this device`);
        row.away.select.setAttribute(
          "aria-label",
          `Notify when away from ${label} for`,
        );
      }
      setText(row.id, label === machineId ? "" : `${machineId} · `);
      const lastSeen =
        sessions === undefined
          ? handlers.machineLastSeen?.(machineId)
          : undefined;
      row.status.classList.toggle("is-online", sessions !== undefined);
      setText(
        row.status,
        sessions !== undefined
          ? `Online · ${sessions}`
          : lastSeen === undefined
            ? "Not seen online on this device yet"
            : "Last seen ",
      );
      row.seen.hidden = lastSeen === undefined;
      if (lastSeen !== undefined) {
        const at = new Date(lastSeen);
        const stamp = at.toISOString();
        if (row.seen.dateTime !== stamp) {
          row.seen.dateTime = stamp;
          row.seen.title = at.toLocaleString();
        }
        setText(row.seen, timeAgo(lastSeen, now));
      }
      row.forget.hidden = !canForget;
      row.away.node.hidden = notifyAway === undefined;
      if (notifyAway !== undefined)
        row.away.set(String(notifyAway.awaySec(machineId)));
      rows.push(row.node);
    };
    for (const machine of tree) {
      const count = machine.projects.reduce(
        (total, project) => total + project.sessions.length,
        0,
      );
      // Cached rows awaiting this load's snapshot, or kept for a machine the
      // relay no longer lists, do not show a machine online.
      place(
        machine.machineId,
        machine.label,
        machine.stale || machine.offline
          ? undefined
          : `${count} ${count === 1 ? "session" : "sessions"}`,
      );
    }
    // Paired here but not online (e.g. retired): still renameable and forgettable.
    for (const [machineId, label] of handlers.pairedMachines?.() ?? []) {
      if (!ids.has(machineId)) place(machineId, label);
    }
    for (const id of this.#rows.keys()) {
      if (!ids.has(id)) this.#rows.delete(id);
    }
    syncChildren(this.#list, rows);
    this.#list.hidden = rows.length === 0;
    this.#empty.hidden = rows.length > 0;
  }

  /** Settings reopened: fold away unfinished renames and forgets and the last outcome. */
  reset(): void {
    this.#fold();
    setText(this.#status, "");
  }

  /** Fold every open rename or forget step back to rest, except `keep`'s. */
  #fold(keep?: MachineRow): void {
    for (const row of this.#rows.values()) {
      if (row !== keep && (row.mode === "rename" || row.mode === "confirm"))
        this.#setMode(row, "view");
    }
  }

  #createRow(machineId: string): MachineRow {
    const node = element("li", "settings-machine");
    const summary = element("div", "settings-machine-summary");
    const copy = element("div", "settings-machine-copy");
    const name = element("span", "settings-machine-name");
    const meta = element("span", "meta");
    const id = element("span", "settings-machine-id");
    const status = element("span", "settings-machine-status");
    const seen = element("time", "settings-machine-seen");
    meta.append(id, status, seen);
    copy.append(name, meta);
    const actions = element("div", "settings-machine-actions");
    const rename = button("Rename", "button secondary");
    const forget = button("Forget", "button secondary");
    actions.append(rename, forget);
    summary.append(copy, actions);

    const renameForm = element("form", "settings-machine-rename");
    const renameInput = element("input", "settings-machine-label");
    renameInput.autocomplete = "off";
    renameInput.spellcheck = false;
    renameInput.maxLength = 64;
    renameInput.placeholder = machineId;
    const cancelRename = button("Cancel", "button secondary");
    const save = button("Save name", "button primary");
    save.type = "submit";
    const renameButtons = element("div", "settings-machine-buttons");
    renameButtons.append(cancelRename, save);
    renameForm.append(
      field(
        "Name on this device",
        renameInput,
        `Stored on this device only. Leave empty to show ${machineId}.`,
      ),
      renameButtons,
    );

    const confirm = element("div", "settings-machine-confirm");
    const question = element("p", "settings-machine-question");
    question.id = uniqueId("forget");
    const detail = element(
      "p",
      "field-hint",
      "This removes the pairing from this browser only. The host keeps running and can be paired again with a new code.",
    );
    detail.id = `${question.id}-detail`;
    confirm.setAttribute("role", "group");
    confirm.setAttribute("aria-labelledby", question.id);
    confirm.setAttribute("aria-describedby", detail.id);
    const keep = button("Cancel", "button secondary");
    const confirmForget = button("Forget machine", "button primary");
    const confirmButtons = element("div", "settings-machine-buttons");
    confirmButtons.append(keep, confirmForget);
    confirm.append(question, detail, confirmButtons);

    const away = dropdown({
      label: "Notify when away for",
      choices: AWAY_CHOICES,
      hint: "Pushes wait until this machine has had no keyboard or mouse input for this long. Machines other than Windows always push.",
      onChange: (value) => this.#setAway(row, value),
    });

    node.append(summary, renameForm, confirm, away.node);
    const row: MachineRow = {
      machineId,
      node,
      name,
      id,
      status,
      seen,
      actions,
      rename,
      forget,
      renameForm,
      renameInput,
      confirm,
      question,
      keep,
      confirmForget,
      away,
      label: "",
      mode: "view",
    };
    this.#setMode(row, "view");

    rename.addEventListener("click", () => {
      this.#fold(row);
      this.#setMode(row, "rename");
      renameInput.value = row.label === machineId ? "" : row.label;
      renameInput.focus();
      renameInput.select();
    });
    cancelRename.addEventListener("click", () => this.#cancel(row));
    renameForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#rename(row);
    });
    forget.addEventListener("click", () => {
      this.#fold(row);
      this.#setMode(row, "confirm");
      keep.focus();
    });
    keep.addEventListener("click", () => this.#cancel(row));
    confirmForget.addEventListener("click", () => void this.#forget(row));
    // Escape backs out of the open step rather than closing all of Settings.
    node.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (row.mode !== "rename" && row.mode !== "confirm") return;
      event.preventDefault();
      this.#cancel(row);
    });
    return row;
  }

  #setMode(row: MachineRow, mode: RowMode): void {
    row.mode = mode;
    row.actions.hidden = mode !== "view";
    row.renameForm.hidden = mode !== "rename";
    row.confirm.hidden = mode !== "confirm" && mode !== "forgetting";
    const busy = mode === "forgetting";
    row.keep.disabled = busy;
    row.confirmForget.disabled = busy;
    if (busy) row.confirm.setAttribute("aria-busy", "true");
    else row.confirm.removeAttribute("aria-busy");
  }

  /** Back out of a rename or a forget, returning focus to the button that opened it. */
  #cancel(row: MachineRow): void {
    const opener = row.mode === "rename" ? row.rename : row.forget;
    this.#setMode(row, "view");
    opener.focus();
  }

  #rename(row: MachineRow): void {
    const name = row.renameInput.value.trim();
    const saved = this.#handlers.onRenameMachine(row.machineId, name);
    const outcome =
      name && name !== row.machineId
        ? `${row.machineId} is named “${name}” on this device.`
        : `${row.machineId} is shown by its machine ID.`;
    setText(
      this.#status,
      saved
        ? outcome
        : `${outcome} Browser storage is unavailable, so the name resets when this page reloads.`,
    );
    this.#setMode(row, "view");
    row.rename.focus();
  }

  /** Save the away time picked for a machine, which tells it at once when it is connected. */
  #setAway(row: MachineRow, value: string): void {
    const notifyAway = this.#handlers.notifyAway;
    if (notifyAway === undefined) return;
    const saved = notifyAway.setAwaySec(row.machineId, Number(value));
    const after = AWAY_CHOICES.find((choice) => choice.value === value)?.label;
    setText(
      this.#status,
      savedOutcome(
        saved,
        value === "0"
          ? `${row.label} pushes whenever a session needs you.`
          : `${row.label} pushes once it has had no keyboard or mouse input for ${after ?? `${value} seconds`}.`,
      ),
    );
  }

  async #forget(row: MachineRow): Promise<void> {
    const forget = this.#handlers.onForgetMachine;
    if (forget === undefined || row.mode !== "confirm") return;
    const label = row.label;
    this.#setMode(row, "forgetting");
    setText(this.#status, `Forgetting ${label}…`);
    let reconnected: boolean;
    try {
      reconnected = await forget(row.machineId);
    } catch {
      setText(this.#status, `Could not forget ${label}. Try again.`);
      this.#setMode(row, "confirm");
      row.confirmForget.focus();
      return;
    }
    this.#onForgotten(row.machineId);
    setText(
      this.#status,
      reconnected
        ? `Forgot ${label} on this device. The host keeps running and can be paired again with a new code.`
        : `Forgot ${label} on this device, but reconnecting to your other machines failed. Reload the page to reconnect.`,
    );
    this.#setMode(row, "view");
    // The row leaves with the machine; keep keyboard focus inside the section.
    if (row.node.isConnected) row.forget.focus();
    else this.#heading.focus();
  }
}
