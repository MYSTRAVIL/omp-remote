/// <reference lib="dom" />
import { element, setText, uniqueId } from "./dom";

/** One option of a dropdown: the value it stands for and the text it shows. */
export interface Choice<V extends string> {
  readonly value: V;
  readonly label: string;
}

export interface DropdownOptions<V extends string> {
  /** The row's visible label; it also names the select for assistive technology. */
  readonly label: string;
  /** The options, in order. */
  readonly choices: readonly Choice<V>[];
  /** The choice shown at first; the first choice when absent. */
  readonly value?: V;
  /** A line under the select, read out with it. */
  readonly hint?: string;
  /** The user picked `value`. Never called for `set` or `setChoices`. */
  readonly onChange?: (value: V) => void;
}

/**
 * A setting row whose control is a native select: the label, the select and
 * a hint under it, as every setting row lays them out. The browser supplies
 * the picker (Android's own sheet), keyboard use and the accessible name.
 */
export interface Dropdown<V extends string> {
  readonly node: HTMLElement;
  readonly label: HTMLLabelElement;
  readonly select: HTMLSelectElement;
  /** The line under the select; empty, and so hidden, until it has text. */
  readonly hint: HTMLElement;
  /** The chosen value; undefined while no offered choice is chosen. */
  readonly value: V | undefined;
  /** Show `value` as chosen, or no choice when it is not offered. */
  set(value: V | undefined): void;
  /** Offer `choices`, keeping the chosen value while it is still offered. */
  setChoices(choices: readonly Choice<V>[]): void;
}

export interface SwitchOptions {
  readonly label: string;
  readonly checked?: boolean;
  /** A line under the row, read out with the switch. */
  readonly hint?: string;
  /** The user turned it on or off. Never called for `set`. */
  readonly onChange?: (on: boolean) => void;
}

/** A setting row whose control is an on/off switch (a checkbox with role=switch). */
export interface Switch {
  readonly node: HTMLElement;
  readonly label: HTMLLabelElement;
  readonly input: HTMLInputElement;
  /** The line under the row; empty, and so hidden, until it has text. */
  readonly hint: HTMLElement;
  /** Show `on` without calling onChange. */
  set(on: boolean): void;
}

/** The shared row: label, control, then a hint read out with the control. */
function settingRow(
  className: string,
  label: string,
  control: HTMLInputElement | HTMLSelectElement,
  hint: string,
): { node: HTMLElement; label: HTMLLabelElement; hint: HTMLElement } {
  const node = element("div", className);
  control.id = uniqueId("setting");
  const caption = element("label", "field-label", label);
  caption.htmlFor = control.id;
  const help = element("p", "field-hint", hint);
  help.id = `${control.id}-hint`;
  control.setAttribute("aria-describedby", help.id);
  node.append(caption, control, help);
  return { node, label: caption, hint: help };
}

/**
 * Every single choice in Settings and New session, as one styled native
 * select. Redraws that offer the same choices touch nothing, so an open
 * picker survives the store's frequent updates.
 */
export function dropdown<V extends string>(
  options: DropdownOptions<V>,
): Dropdown<V> {
  const select = element("select", "select");
  const row = settingRow("field", options.label, select, options.hint ?? "");
  /** The value each drawn option stands for, by its `value` attribute. */
  const offered = new Map<string, V>();
  let drawn: readonly Choice<V>[] = [];
  const chosen = (): V | undefined =>
    select.selectedIndex < 0 ? undefined : offered.get(select.value);
  const set = (value: V | undefined): void => {
    if (value === undefined || !offered.has(value)) select.selectedIndex = -1;
    // Not `select.value`: with nothing chosen it reads "", a real choice's value.
    else if (chosen() !== value) select.value = value;
  };
  const setChoices = (choices: readonly Choice<V>[]): void => {
    if (
      choices.length === drawn.length &&
      choices.every(
        (choice, index) =>
          choice.value === drawn[index]?.value &&
          choice.label === drawn[index]?.label,
      )
    )
      return;
    const keep = chosen();
    drawn = choices;
    offered.clear();
    select.replaceChildren(
      ...choices.map((choice) => {
        offered.set(choice.value, choice.value);
        const option = element("option", "", choice.label);
        option.value = choice.value;
        return option;
      }),
    );
    set(keep);
  };
  setChoices(options.choices);
  set(options.value ?? options.choices[0]?.value);
  select.addEventListener("change", () => {
    const value = chosen();
    if (value !== undefined) options.onChange?.(value);
  });
  return {
    ...row,
    select,
    get value() {
      return chosen();
    },
    set,
    setChoices,
  };
}

/** Every on/off preference in Settings, as one switch. */
export function toggleSwitch(options: SwitchOptions): Switch {
  const input = element("input", "switch");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.checked = options.checked ?? false;
  const row = settingRow(
    "field is-switch",
    options.label,
    input,
    options.hint ?? "",
  );
  input.addEventListener("change", () => options.onChange?.(input.checked));
  return {
    ...row,
    input,
    set(on) {
      input.checked = on;
    },
  };
}

/** A saved choice's outcome, noting when it may not outlast this page load. */
export function savedOutcome(saved: boolean, text: string): string {
  return saved
    ? text
    : `${text} Browser storage is unavailable, so this choice may reset on reload.`;
}

/**
 * A saved preference as a dropdown (Settings > Chat, Appearance): a choice is
 * saved at once and said so in `status`. `sync` shows what is saved, so
 * reopening Settings never shows a stale choice.
 */
export function preferenceDropdown<V extends string>(
  label: string,
  choices: readonly Choice<V>[],
  read: () => V,
  write: (value: V) => boolean,
  status: HTMLElement,
  hint?: string,
): Dropdown<V> & { sync(): void } {
  const control = dropdown({
    label,
    choices,
    value: read(),
    hint,
    onChange: (value) => {
      const name =
        choices.find((choice) => choice.value === value)?.label ?? value;
      setText(
        status,
        savedOutcome(
          write(value),
          `${label} set to ${name.toLowerCase()} in this browser.`,
        ),
      );
    },
  });
  return Object.assign(control, { sync: () => control.set(read()) });
}

/** A saved on/off preference as a switch; otherwise like `preferenceDropdown`. */
export function preferenceSwitch(
  label: string,
  read: () => boolean,
  write: (on: boolean) => boolean,
  status: HTMLElement,
  hint?: string,
): Switch & { sync(): void } {
  const control = toggleSwitch({
    label,
    checked: read(),
    hint,
    onChange: (on) =>
      setText(
        status,
        savedOutcome(
          write(on),
          `${label} is ${on ? "on" : "off"} in this browser.`,
        ),
      ),
  });
  return Object.assign(control, { sync: () => control.set(read()) });
}
