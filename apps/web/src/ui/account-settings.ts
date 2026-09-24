/// <reference lib="dom" />
import {
  AccountError,
  type AccountFailure,
  type FreshCheck,
  type Passkey,
  type RelayMachine,
} from "../core/auth";
import { capabilities } from "../core/capabilities";
import { timeAgo } from "../core/time-format";
import { savedOutcome, toggleSwitch } from "./choices";
import { button, element, field, setText, syncChildren, uniqueId } from "./dom";
import type { ControlHandlers } from "./render";

/** What a refused account request, or an unfinished passkey check, means here. */
const FAILURE_TEXT: Record<AccountFailure, string> = {
  "signed-out": "Your sign-in on this device has ended. Sign in again.",
  "passkey-check-incomplete":
    "The passkey check didn't finish. Nothing was changed.",
  "passkey-check-failed": "Passkey check failed. Nothing was changed.",
  "password-required": "This change needs your password. Nothing was changed.",
  "wrong-password": "Wrong password. Nothing was changed.",
  throttled: "Too many attempts. Nothing was changed.",
  "passkey-session-required":
    "Sign in with a passkey to turn password sign-in off.",
  "not-found": "That passkey was already revoked.",
  "last-passkey": "You can't remove your only passkey.",
  "credential-limit": "This server already has as many passkeys as it allows.",
};

/** Failures after which nothing changed, so the same step can be tried again. */
const RETRYABLE: Record<string, true> = {
  unknown: true,
  "passkey-check-failed": true,
  "passkey-check-incomplete": true,
  "password-required": true,
  "wrong-password": true,
  throttled: true,
};

/** What `error` means here, with a lockout's wait in seconds. */
function failureText(error: unknown, fallback: string): string {
  if (!(error instanceof AccountError)) return fallback;
  if (error.failure === "throttled" && error.retryAfterSec !== undefined)
    return `Too many attempts. Try again in ${error.retryAfterSec} s.`;
  return FAILURE_TEXT[error.failure];
}

/** When a passkey was registered, in the reader's locale: "Sep 7, 2026". */
const registeredOn = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

/** A confirm step's state: folded away, asking, or waiting on the request. */
type StepMode = "view" | "confirm" | "working";

/**
 * A confirm step: the question, what happens, the password (after a password
 * sign-in, as the change's fresh check), then Cancel beside the action.
 */
interface ConfirmStep {
  readonly node: HTMLElement;
  readonly question: HTMLElement;
  readonly detail: HTMLElement;
  readonly password: HTMLInputElement;
  readonly passwordField: HTMLElement;
  readonly cancel: HTMLButtonElement;
  readonly go: HTMLButtonElement;
  mode: StepMode;
}

/** One registered passkey, with its Revoke and the step that confirms it. */
interface PasskeyRow {
  readonly node: HTMLLIElement;
  readonly name: HTMLElement;
  /** "This device", on the passkey this device signed in with. */
  readonly device: HTMLElement;
  /** When it was registered and last used. */
  readonly meta: HTMLElement;
  readonly actions: HTMLElement;
  readonly revoke: HTMLButtonElement;
  readonly step: ConfirmStep;
  passkey: Passkey;
  /** How sentences name it: "passkey" and the start of its ID. */
  label: string;
}

/** One machine the relay lets connect, with its Revoke and confirm step. */
interface MachineRow {
  readonly node: HTMLLIElement;
  readonly name: HTMLElement;
  /** Online, or when it was last seen. */
  readonly meta: HTMLElement;
  readonly actions: HTMLElement;
  readonly revoke: HTMLButtonElement;
  readonly step: ConfirmStep;
  machine: RelayMachine;
}

function confirmStep(action: string): ConfirmStep {
  const node = element("div", "settings-machine-confirm");
  const question = element("p", "settings-machine-question");
  question.id = uniqueId("confirm");
  const detail = element("p", "field-hint");
  detail.id = `${question.id}-detail`;
  node.setAttribute("role", "group");
  node.setAttribute("aria-labelledby", question.id);
  node.setAttribute("aria-describedby", detail.id);
  const password = document.createElement("input");
  password.type = "password";
  password.autocomplete = "current-password";
  password.autocapitalize = "off";
  password.spellcheck = false;
  const passwordField = field("Your password", password);
  passwordField.hidden = true;
  const cancel = button("Cancel", "button secondary");
  const go = button(action, "button primary");
  const buttons = element("div", "settings-machine-buttons");
  buttons.append(cancel, go);
  node.append(question, detail, passwordField, buttons);
  return {
    node,
    question,
    detail,
    password,
    passwordField,
    cancel,
    go,
    mode: "view",
  };
}

/** A passkey date as a `<time>`, or "unknown" when the relay has none. */
function passkeyDate(at: number | null, text: (at: number) => string): Node {
  const moment = new Date(at ?? Number.NaN);
  if (at === null || Number.isNaN(moment.getTime()))
    return document.createTextNode("unknown");
  const time = element("time", "", text(at));
  time.dateTime = moment.toISOString();
  time.title = moment.toLocaleString();
  return time;
}

/**
 * Settings > Account: signing this browser out, whether this device keeps its
 * sign-in, the passkeys that can sign in (each revocable after a fresh check,
 * except the only one) and adding one, the machines that can connect (each
 * revocable after a fresh check), whether the password signs in, and signing
 * out everywhere. A fresh check is a passkey prompt after a passkey sign-in,
 * the password after a password sign-in. The lists are fetched each time
 * Settings opens. One account request runs at a time: the passkey prompt of a
 * second would cancel the first.
 */
export class AccountSettings {
  readonly node = element("section", "settings-section account-settings");
  /** Said once, on a plain-HTTP page: what the browser turns off there. */
  readonly #insecure = element("div", "settings-notice account-insecure");
  /** "Keep me signed in"; hidden without a sign-in to keep (tests, previews). */
  readonly #keep = element("div", "account-keep");
  readonly #keepSwitch = toggleSwitch({
    label: "Keep me signed in",
    hint: "Turning this on applies the next time you sign in. Turning it off forgets this device's sign-in now; this tab stays signed in until you close it.",
    onChange: (on) => {
      const signIn = this.#handlers.signIn;
      if (signIn === undefined) return;
      setText(
        this.#keepStatus,
        savedOutcome(
          signIn.setKeepSignedIn(on),
          on
            ? "Keep me signed in is on. It applies the next time you sign in on this device."
            : "Keep me signed in is off. This device forgot its sign-in; this tab stays signed in until you close it.",
        ),
      );
    },
  });
  readonly #keepStatus = element("p", "field-hint preference-status");
  /** Passkeys, machines and Sign out everywhere; hidden without a relay account. */
  readonly #relay = element("div", "account-relay");
  /**
   * The Passkeys heading, copy, list and status: hidden when the server offers
   * no passkeys and none are registered, as there is nothing to list or do.
   */
  readonly #passkeys = element("div", "account-passkeys");
  readonly #passkeysHeading = element("h4", "settings-subtitle", "Passkeys");
  readonly #list = element("ul", "settings-machines settings-passkeys");
  readonly #onlyOne = element(
    "p",
    "field-hint account-only-passkey",
    "You can't remove your only passkey.",
  );
  readonly #passkeysStatus = element("p", "field-hint preference-status");
  readonly #retry = button("Try again", "button secondary account-retry");
  readonly #rows = new Map<string, PasskeyRow>();
  /** "Add a passkey": shown while the relay and this browser both do passkeys. */
  readonly #add = element("div", "account-add-passkey");
  readonly #addButton = button("Add a passkey", "button secondary");
  readonly #addStep = confirmStep("Add passkey");
  /** "Password sign-in": shown while the relay offers passkeys too. */
  readonly #password = element("div", "account-password-sign-in");
  readonly #passwordSwitch = toggleSwitch({
    label: "Password sign-in",
    hint: "Turning it off leaves passkeys as the only way to sign in. It needs a passkey sign-in and at least one passkey.",
    onChange: (on) => void this.#setPasswordSignIn(on),
  });
  readonly #passwordStatus = element("p", "field-hint preference-status");
  /** The relay's password sign-in setting, as last read or set. */
  #passwordOn = true;
  readonly #machinesHeading = element(
    "h4",
    "settings-subtitle",
    "Machines on this server",
  );
  readonly #machineList = element("ul", "settings-machines account-machines");
  readonly #machinesStatus = element("p", "field-hint preference-status");
  readonly #machineRows = new Map<string, MachineRow>();
  readonly #everywhere = button(
    "Sign out everywhere, including this device",
    "button secondary",
  );
  readonly #everywhereStep = confirmStep("Sign out everywhere");
  readonly #everywhereStatus = element("p", "field-hint preference-status");
  #handlers: ControlHandlers;
  /** Bumped by each list request; an answer to an older one is dropped. */
  #loads = 0;
  /** An account request is in flight; every other account action waits. */
  #busy = false;

  constructor(handlers: ControlHandlers) {
    this.#handlers = handlers;
    const heading = element("h3", "section-title", "Account");
    heading.id = uniqueId("settings-section");
    this.node.setAttribute("aria-labelledby", heading.id);
    const signOut = button("Sign out", "button secondary");
    signOut.addEventListener("click", () => this.#handlers.onSignOut?.());
    this.#buildInsecure();
    this.#buildKeep();
    this.#buildRelay();
    this.node.append(
      heading,
      this.#insecure,
      element(
        "p",
        "section-copy",
        "Signing out returns this browser to the sign-in screen and clears a remembered sign-in. Machines paired here stay paired.",
      ),
      signOut,
      this.#keep,
      this.#relay,
    );
    this.update(handlers);
  }

  /** Show what this device's handlers support; Settings calls it on every redraw. */
  update(handlers: ControlHandlers): void {
    this.#handlers = handlers;
    // Local dev has no sign-in, so nothing here applies there.
    this.node.hidden = handlers.onSignOut === undefined;
    this.#keep.hidden = handlers.signIn === undefined;
    this.#relay.hidden = handlers.account === undefined;
  }

  /**
   * Settings reopened: the saved choice, fresh lists, and nothing half-done
   * or reported from last time. A request still in flight keeps its step and
   * reports when it settles.
   */
  reset(): void {
    this.#keepSwitch.set(this.#handlers.signIn?.keepSignedIn ?? false);
    setText(this.#keepStatus, "");
    if (this.#busy) return;
    this.#fold();
    setText(this.#passkeysStatus, "");
    setText(this.#machinesStatus, "");
    setText(this.#passwordStatus, "");
    setText(this.#everywhereStatus, "");
    void this.#load();
  }

  #buildInsecure(): void {
    this.#insecure.setAttribute("role", "note");
    const how = element("p", "field-hint");
    how.append(
      "How to turn on HTTPS: the HTTPS section of ",
      element("code", "", "docs/SELF-HOSTING.md"),
      " in the omp-remote repository.",
    );
    this.#insecure.append(
      element(
        "p",
        "section-copy",
        "Served over HTTP: push, install and passkeys are off.",
      ),
      how,
    );
    this.#insecure.hidden = capabilities().secure;
  }

  #buildKeep(): void {
    this.#keepStatus.setAttribute("role", "status");
    this.#keep.append(this.#keepSwitch.node, this.#keepStatus);
    this.#keepSwitch.set(this.#handlers.signIn?.keepSignedIn ?? false);
  }

  /** How this device's fresh check goes, said at the end of a step's detail. */
  #askText(): string {
    return this.#handlers.account?.method === "password"
      ? "Enter your password to confirm."
      : "You'll be asked for a passkey first.";
  }

  /** What the status says while the fresh check runs. */
  #waitText(): string {
    return this.#handlers.account?.method === "password"
      ? "Checking your password…"
      : "Waiting for passkey…";
  }

  /**
   * The fresh check `step` carries: the password typed there after a password
   * sign-in, else a passkey prompt. None yet while the password is empty.
   */
  #check(step: ConfirmStep): FreshCheck | undefined {
    if (this.#handlers.account?.method !== "password")
      return { kind: "passkey" };
    if (step.password.value.length === 0) {
      step.password.focus();
      return undefined;
    }
    return { kind: "password", password: step.password.value };
  }

  /** Wire `step` to open from `opener`, fold back on Cancel or Escape, and run `go`. */
  #wireStep(
    step: ConfirmStep,
    opener: HTMLButtonElement,
    shown: HTMLElement,
    go: () => void,
  ): void {
    this.#setStep(step, shown, "view");
    opener.addEventListener("click", () => {
      this.#fold();
      this.#setStep(step, shown, "confirm");
      step.cancel.focus();
    });
    step.cancel.addEventListener("click", () => {
      this.#setStep(step, shown, "view");
      opener.focus();
    });
    step.go.addEventListener("click", go);
    // Enter in the password field confirms, as the action button does.
    step.password.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || step.mode !== "confirm") return;
      event.preventDefault();
      go();
    });
    // Escape backs out of the open step rather than closing all of Settings.
    step.node.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || step.mode !== "confirm") return;
      event.preventDefault();
      this.#setStep(step, shown, "view");
      opener.focus();
    });
  }

  #buildRelay(): void {
    this.#passkeysHeading.id = uniqueId("passkeys");
    // Focus lands here once a revoked passkey's row has gone.
    this.#passkeysHeading.tabIndex = -1;
    this.#list.setAttribute("aria-labelledby", this.#passkeysHeading.id);
    this.#list.hidden = true;
    this.#onlyOne.id = uniqueId("only-passkey");
    this.#onlyOne.hidden = true;
    this.#passkeysStatus.setAttribute("role", "status");
    this.#retry.hidden = true;
    this.#retry.addEventListener("click", () => void this.#load());

    const add = this.#addStep;
    setText(add.question, "Add a passkey on this device?");
    this.#wireStep(add, this.#addButton, this.#addButton, () => {
      void this.#addPasskey();
    });
    this.#add.append(this.#addButton, add.node);
    this.#add.hidden = true;

    this.#passwordStatus.setAttribute("role", "status");
    this.#password.append(this.#passwordSwitch.node, this.#passwordStatus);
    this.#password.hidden = true;

    this.#machinesHeading.id = uniqueId("machines");
    this.#machinesHeading.tabIndex = -1;
    this.#machineList.setAttribute("aria-labelledby", this.#machinesHeading.id);
    this.#machineList.hidden = true;
    this.#machinesStatus.setAttribute("role", "status");

    const everywhereHeading = element(
      "h4",
      "settings-subtitle",
      "Sign out everywhere",
    );
    const step = this.#everywhereStep;
    setText(step.question, "Sign out on every device, including this one?");
    this.#wireStep(step, this.#everywhere, this.#everywhere, () => {
      void this.#signOutEverywhere();
    });
    this.#everywhereStatus.setAttribute("role", "status");

    this.#passkeys.append(
      this.#passkeysHeading,
      element(
        "p",
        "section-copy",
        "These passkeys can sign in to your workspace. Revoking one signs out any device that signed in with it.",
      ),
      this.#list,
      this.#onlyOne,
      this.#passkeysStatus,
    );
    this.#relay.append(
      this.#passkeys,
      this.#retry,
      this.#add,
      this.#password,
      this.#machinesHeading,
      element(
        "p",
        "section-copy",
        "These machines can connect to this server. A revoked machine has to join again to come back.",
      ),
      this.#machineList,
      this.#machinesStatus,
      everywhereHeading,
      element(
        "p",
        "section-copy",
        "Ends every sign-in, on this device and all your others. Paired machines stay paired.",
      ),
      this.#everywhere,
      step.node,
      this.#everywhereStatus,
    );
  }

  /** Fetch the sign-in methods, the passkeys and the machines, saying so while they load. */
  async #load(): Promise<void> {
    const account = this.#handlers.account;
    if (account === undefined) return;
    this.#loads += 1;
    const load = this.#loads;
    // Hiding the focused Try again would drop focus to the page.
    if (document.activeElement === this.#retry) this.#passkeysHeading.focus();
    this.#retry.hidden = true;
    this.#list.setAttribute("aria-busy", "true");
    this.#machineList.setAttribute("aria-busy", "true");
    setText(this.#passkeysStatus, "Loading passkeys…");
    setText(this.#machinesStatus, "Loading machines…");
    const [methods, passkeys, machines] = await Promise.allSettled([
      account.methods(),
      account.passkeys(),
      account.machines(),
    ]);
    if (load !== this.#loads) return;
    this.#list.removeAttribute("aria-busy");
    this.#machineList.removeAttribute("aria-busy");
    for (const answer of [methods, passkeys, machines])
      if (
        answer.status === "rejected" &&
        answer.reason instanceof AccountError &&
        answer.reason.failure === "signed-out"
      ) {
        // The relay refuses this token now: drop it and return to sign-in.
        this.#handlers.onSignOut?.(FAILURE_TEXT["signed-out"]);
        return;
      }
    if (passkeys.status === "fulfilled") {
      this.#render(passkeys.value);
      setText(this.#passkeysStatus, "");
    } else {
      setText(this.#passkeysStatus, "Couldn't load your passkeys.");
      this.#retry.hidden = false;
    }
    if (machines.status === "fulfilled") {
      this.#renderMachines(machines.value);
      setText(this.#machinesStatus, "");
    } else {
      setText(this.#machinesStatus, "Couldn't load the machines.");
      this.#retry.hidden = false;
    }
    const offersPasskeys =
      methods.status === "fulfilled" && methods.value.passkey;
    this.#add.hidden = !(offersPasskeys && account.passkeyAvailable);
    // Without passkeys the password is the only sign-in, so it stays on.
    this.#password.hidden = !offersPasskeys;
    this.#passkeys.hidden =
      methods.status === "fulfilled" &&
      !methods.value.passkey &&
      passkeys.status === "fulfilled" &&
      passkeys.value.length === 0;
    if (methods.status === "fulfilled")
      this.#passwordOn = methods.value.password;
    this.#passwordSwitch.set(this.#passwordOn);
    this.#syncControls();
  }

  /** Show `passkeys`, keeping each row (and its focus) that stays. */
  #render(passkeys: readonly Passkey[]): void {
    const now = Date.now();
    const rows: HTMLLIElement[] = [];
    const ids = new Set<string>();
    for (const passkey of passkeys) {
      ids.add(passkey.id);
      let row = this.#rows.get(passkey.id);
      if (!row) {
        row = this.#createRow(passkey);
        this.#rows.set(passkey.id, row);
      }
      row.passkey = passkey;
      this.#draw(row, now);
      rows.push(row.node);
    }
    for (const id of this.#rows.keys()) if (!ids.has(id)) this.#rows.delete(id);
    syncChildren(this.#list, rows);
    this.#list.hidden = rows.length === 0;
    this.#syncControls();
  }

  #draw(row: PasskeyRow, now: number): void {
    const { passkey } = row;
    // Passkeys have no names; the start of the ID tells them apart.
    const id = passkey.id.slice(0, 8);
    const label = `passkey ${id}`;
    row.label = label;
    setText(row.name, `Passkey ${id}`);
    row.device.hidden = !passkey.current;
    row.meta.replaceChildren(
      "Created ",
      passkeyDate(passkey.createdAt, (at) => registeredOn.format(at)),
      " · Last used ",
      passkeyDate(passkey.lastUsedAt, (at) => timeAgo(at, now)),
    );
    row.revoke.setAttribute(
      "aria-label",
      passkey.current
        ? `Revoke ${label}, this device's passkey`
        : `Revoke ${label}`,
    );
    setText(
      row.step.question,
      passkey.current ? "Revoke this device's passkey?" : `Revoke ${label}?`,
    );
  }

  #createRow(passkey: Passkey): PasskeyRow {
    const node = element("li", "settings-machine settings-passkey");
    const summary = element("div", "settings-machine-summary");
    const copy = element("div", "settings-machine-copy");
    const title = element("span", "settings-passkey-title");
    const name = element("span", "settings-machine-name");
    const device = element(
      "span",
      "eyebrow settings-passkey-device",
      "This device",
    );
    title.append(name, device);
    const meta = element("span", "meta");
    copy.append(title, meta);
    const actions = element("div", "settings-machine-actions");
    const revoke = button("Revoke", "button secondary");
    actions.append(revoke);
    summary.append(copy, actions);
    const step = confirmStep("Revoke passkey");
    node.append(summary, step.node);
    const row: PasskeyRow = {
      node,
      name,
      device,
      meta,
      actions,
      revoke,
      step,
      passkey,
      label: "",
    };
    this.#wireStep(step, revoke, actions, () => void this.#revoke(row));
    return row;
  }

  /** Show `machines`, keeping each row (and its focus) that stays. */
  #renderMachines(machines: readonly RelayMachine[]): void {
    const now = Date.now();
    const rows: HTMLLIElement[] = [];
    const ids = new Set<string>();
    for (const machine of machines) {
      ids.add(machine.machineId);
      let row = this.#machineRows.get(machine.machineId);
      if (!row) {
        row = this.#createMachineRow(machine);
        this.#machineRows.set(machine.machineId, row);
      }
      row.machine = machine;
      setText(row.name, machine.machineId);
      row.meta.replaceChildren(
        machine.online
          ? "Online"
          : machine.lastSeenAt === undefined
            ? "Never seen"
            : `Last seen ${timeAgo(machine.lastSeenAt, now)}`,
        " · Joined ",
        passkeyDate(machine.joinedAt, (at) => registeredOn.format(at)),
      );
      rows.push(row.node);
    }
    for (const id of this.#machineRows.keys())
      if (!ids.has(id)) this.#machineRows.delete(id);
    syncChildren(this.#machineList, rows);
    this.#machineList.hidden = rows.length === 0;
    if (rows.length === 0)
      setText(this.#machinesStatus, "No machines have joined this server.");
    this.#syncControls();
  }

  #createMachineRow(machine: RelayMachine): MachineRow {
    const node = element("li", "settings-machine");
    const summary = element("div", "settings-machine-summary");
    const copy = element("div", "settings-machine-copy");
    const name = element("span", "settings-machine-name");
    const meta = element("span", "meta");
    copy.append(name, meta);
    const actions = element("div", "settings-machine-actions");
    const revoke = button("Revoke", "button secondary");
    revoke.setAttribute("aria-label", `Revoke ${machine.machineId}`);
    actions.append(revoke);
    summary.append(copy, actions);
    const step = confirmStep("Revoke machine");
    setText(step.question, `Revoke ${machine.machineId}?`);
    node.append(summary, step.node);
    const row: MachineRow = {
      node,
      name,
      meta,
      actions,
      revoke,
      step,
      machine,
    };
    this.#wireStep(step, revoke, actions, () => void this.#revokeMachine(row));
    return row;
  }

  /** Show `step` at `mode`; `opener` shows only while the step is folded away. */
  #setStep(step: ConfirmStep, opener: HTMLElement, mode: StepMode): void {
    step.mode = mode;
    opener.hidden = mode !== "view";
    step.node.hidden = mode === "view";
    const working = mode === "working";
    step.cancel.disabled = working;
    step.go.disabled = working;
    step.password.disabled = working;
    if (working) step.node.setAttribute("aria-busy", "true");
    else step.node.removeAttribute("aria-busy");
    if (mode === "view") step.password.value = "";
    if (mode !== "confirm") return;
    // Opened: say how this device's fresh check goes, and ask for the
    // password when that is it.
    step.passwordField.hidden = this.#handlers.account?.method !== "password";
    const detail = this.#stepDetail(step);
    setText(step.detail, `${detail} ${this.#askText()}`);
  }

  /** What `step` does, before how its fresh check goes. */
  #stepDetail(step: ConfirmStep): string {
    if (step === this.#everywhereStep)
      return "Every device returns to the sign-in screen, this one too.";
    if (step === this.#addStep)
      return "Your device then asks you to create the passkey.";
    for (const row of this.#rows.values())
      if (row.step === step)
        return row.passkey.current
          ? "This device is signed out, and this passkey can't sign in again."
          : "It can't sign in again, and any device signed in with it is signed out.";
    return "It can't connect to this server until it joins again.";
  }

  /** Fold every step still asking back to rest. */
  #fold(): void {
    for (const row of this.#rows.values())
      if (row.step.mode === "confirm")
        this.#setStep(row.step, row.actions, "view");
    for (const row of this.#machineRows.values())
      if (row.step.mode === "confirm")
        this.#setStep(row.step, row.actions, "view");
    if (this.#everywhereStep.mode === "confirm")
      this.#setStep(this.#everywhereStep, this.#everywhere, "view");
    if (this.#addStep.mode === "confirm")
      this.#setStep(this.#addStep, this.#addButton, "view");
  }

  /**
   * Revoke only with no request in flight, and never the only passkey.
   * Password sign-in turns off only from a passkey sign-in with a passkey.
   */
  #syncControls(): void {
    const only = this.#rows.size === 1;
    for (const row of this.#rows.values()) {
      row.revoke.disabled = this.#busy || only;
      if (only) row.revoke.setAttribute("aria-describedby", this.#onlyOne.id);
      else row.revoke.removeAttribute("aria-describedby");
    }
    for (const row of this.#machineRows.values())
      row.revoke.disabled = this.#busy;
    this.#onlyOne.hidden = !only;
    this.#everywhere.disabled = this.#busy;
    this.#addButton.disabled = this.#busy;
    const passkeySignIn = this.#handlers.account?.method !== "password";
    this.#passwordSwitch.input.disabled =
      this.#busy ||
      (this.#passwordOn && (!passkeySignIn || this.#rows.size === 0));
  }

  /** Start an account request from `step`: its fresh check, or undefined to wait. */
  #begin(step: ConfirmStep, shown: HTMLElement): FreshCheck | undefined {
    if (
      this.#handlers.account === undefined ||
      step.mode !== "confirm" ||
      this.#busy
    )
      return undefined;
    const check = this.#check(step);
    if (check === undefined) return undefined;
    this.#busy = true;
    this.#setStep(step, shown, "working");
    this.#syncControls();
    return check;
  }

  /** A request from `step` failed with nothing changed: ask again. */
  #askAgain(step: ConfirmStep, shown: HTMLElement): void {
    this.#setStep(step, shown, "confirm");
    this.#syncControls();
    if (step.passwordField.hidden) step.go.focus();
    else step.password.focus();
  }

  async #revoke(row: PasskeyRow): Promise<void> {
    const account = this.#handlers.account;
    const check = this.#begin(row.step, row.actions);
    if (account === undefined || check === undefined) return;
    setText(this.#passkeysStatus, this.#waitText());
    let failure: AccountFailure | "unknown" | undefined;
    try {
      const { signedOut } = await account.revokePasskey(row.passkey.id, check);
      if (signedOut) {
        // It was this device's own passkey: the relay ended this sign-in too.
        this.#handlers.onSignOut?.(
          "This device's passkey was revoked, so this device is signed out.",
        );
        return;
      }
      setText(this.#passkeysStatus, `Revoked ${row.label}.`);
    } catch (error) {
      failure = error instanceof AccountError ? error.failure : "unknown";
      if (failure === "signed-out") {
        this.#busy = false;
        this.#handlers.onSignOut?.(FAILURE_TEXT["signed-out"]);
        return;
      }
      setText(
        this.#passkeysStatus,
        failureText(error, "Couldn't revoke the passkey. Try again."),
      );
    } finally {
      this.#busy = false;
    }
    if (failure !== undefined && RETRYABLE[failure]) {
      this.#askAgain(row.step, row.actions);
      return;
    }
    this.#setStep(row.step, row.actions, "view");
    if (failure === undefined || failure === "not-found") {
      // Gone from the relay, so gone from the list.
      this.#render(
        [...this.#rows.values()]
          .map((other) => other.passkey)
          .filter((passkey) => passkey.id !== row.passkey.id),
      );
    } else if (failure === "last-passkey") {
      // The list was out of date: the relay has only this one left.
      this.#render([row.passkey]);
    } else this.#syncControls();
    // Keep keyboard focus inside the section once the row has gone.
    if (row.node.isConnected && !row.revoke.disabled) row.revoke.focus();
    else this.#passkeysHeading.focus();
  }

  async #revokeMachine(row: MachineRow): Promise<void> {
    const account = this.#handlers.account;
    const check = this.#begin(row.step, row.actions);
    if (account === undefined || check === undefined) return;
    setText(this.#machinesStatus, this.#waitText());
    const { machineId } = row.machine;
    let failure: AccountFailure | "unknown" | undefined;
    try {
      await account.revokeMachine(machineId, check);
      setText(this.#machinesStatus, `Revoked ${machineId}.`);
    } catch (error) {
      failure = error instanceof AccountError ? error.failure : "unknown";
      if (failure === "signed-out") {
        this.#busy = false;
        this.#handlers.onSignOut?.(FAILURE_TEXT["signed-out"]);
        return;
      }
      setText(
        this.#machinesStatus,
        failure === "not-found"
          ? `${machineId} was already revoked.`
          : failureText(error, "Couldn't revoke the machine. Try again."),
      );
    } finally {
      this.#busy = false;
    }
    if (failure !== undefined && RETRYABLE[failure]) {
      this.#askAgain(row.step, row.actions);
      return;
    }
    this.#setStep(row.step, row.actions, "view");
    if (failure === undefined || failure === "not-found")
      this.#renderMachines(
        [...this.#machineRows.values()]
          .map((other) => other.machine)
          .filter((machine) => machine.machineId !== machineId),
      );
    else this.#syncControls();
    this.#machinesHeading.focus();
  }

  async #addPasskey(): Promise<void> {
    const account = this.#handlers.account;
    const step = this.#addStep;
    const check = this.#begin(step, this.#addButton);
    if (account === undefined || check === undefined) return;
    setText(this.#passkeysStatus, this.#waitText());
    let failure: AccountFailure | "unknown" | undefined;
    try {
      const { verified } = await account.addPasskey(check);
      if (!verified) failure = "unknown";
      setText(
        this.#passkeysStatus,
        verified ? "Passkey added." : "Couldn't add the passkey. Try again.",
      );
    } catch (error) {
      failure = error instanceof AccountError ? error.failure : "unknown";
      if (failure === "signed-out") {
        this.#busy = false;
        this.#handlers.onSignOut?.(FAILURE_TEXT["signed-out"]);
        return;
      }
      setText(
        this.#passkeysStatus,
        failureText(error, "Couldn't add the passkey. Try again."),
      );
    } finally {
      this.#busy = false;
    }
    if (failure !== undefined && RETRYABLE[failure]) {
      this.#askAgain(step, this.#addButton);
      return;
    }
    this.#setStep(step, this.#addButton, "view");
    this.#addButton.focus();
    // The new passkey joins the list.
    if (failure === undefined) void this.#load();
    else this.#syncControls();
  }

  /**
   * Turn password sign-in on or off from its switch. Only a passkey sign-in
   * reaches this with the switch enabled, so the fresh check is a passkey.
   */
  async #setPasswordSignIn(on: boolean): Promise<void> {
    const account = this.#handlers.account;
    if (account === undefined || this.#busy) {
      this.#passwordSwitch.set(this.#passwordOn);
      return;
    }
    this.#busy = true;
    this.#syncControls();
    setText(this.#passwordStatus, this.#waitText());
    try {
      this.#passwordOn = await account.setPasswordSignIn(on, {
        kind: "passkey",
      });
      setText(
        this.#passwordStatus,
        this.#passwordOn
          ? "Password sign-in is on."
          : "Password sign-in is off. Devices signed in with the password are signed out.",
      );
    } catch (error) {
      if (error instanceof AccountError && error.failure === "signed-out") {
        this.#busy = false;
        this.#handlers.onSignOut?.(FAILURE_TEXT["signed-out"]);
        return;
      }
      setText(
        this.#passwordStatus,
        failureText(error, "Couldn't change password sign-in. Try again."),
      );
    } finally {
      this.#busy = false;
    }
    this.#passwordSwitch.set(this.#passwordOn);
    this.#syncControls();
  }

  async #signOutEverywhere(): Promise<void> {
    const account = this.#handlers.account;
    const step = this.#everywhereStep;
    const check = this.#begin(step, this.#everywhere);
    if (account === undefined || check === undefined) return;
    setText(this.#everywhereStatus, this.#waitText());
    try {
      await account.signOutEverywhere(check);
    } catch (error) {
      this.#busy = false;
      if (error instanceof AccountError && error.failure === "signed-out") {
        // Already ended elsewhere: drop the stale token and return to sign-in.
        this.#handlers.onSignOut?.(FAILURE_TEXT["signed-out"]);
        return;
      }
      setText(
        this.#everywhereStatus,
        failureText(error, "Couldn't sign out everywhere. Try again."),
      );
      this.#askAgain(step, this.#everywhere);
      return;
    }
    this.#busy = false;
    this.#handlers.onSignOut?.("Signed out everywhere, including this device.");
  }
}
