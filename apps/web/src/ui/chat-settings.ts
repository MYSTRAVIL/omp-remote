/// <reference lib="dom" />
import type {
  ChatPreferences,
  ChatTextSize,
  ChatToolGrouping,
} from "../core/chat-preferences";
import { type Choice, preferenceDropdown, preferenceSwitch } from "./choices";
import { element, setText, uniqueId } from "./dom";

const TEXT_SIZES: readonly Choice<ChatTextSize>[] = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
];

const TOOL_GROUPINGS: readonly Choice<ChatToolGrouping>[] = [
  { value: "off", label: "Off" },
  { value: "2", label: "2 or more" },
  { value: "3", label: "3 or more" },
  { value: "5", label: "5 or more" },
  { value: "10", label: "10 or more" },
];

/**
 * Settings > Chat: how every session's conversation reads in this browser.
 * A choice applies to open sessions at once; each control always shows what
 * is saved, so reopening Settings never shows a stale choice.
 */
export class ChatSettings {
  readonly node = element("section", "settings-section chat-settings");
  readonly #status = element("p", "field-hint preference-status");
  /** Each control's way to show what is saved. */
  readonly #syncs: (() => void)[] = [];

  constructor(chat: ChatPreferences) {
    this.#status.setAttribute("role", "status");
    const heading = element("h3", "section-title", "Chat");
    heading.id = uniqueId("settings-section");
    this.node.setAttribute("aria-labelledby", heading.id);
    const controls = [
      preferenceSwitch(
        "Auto-scroll",
        () => chat.autoScroll,
        (on) => chat.setAutoScroll(on),
        this.#status,
        "Off keeps your place when new messages arrive. Jump to latest still takes you to the end.",
      ),
      preferenceDropdown(
        "Text size",
        TEXT_SIZES,
        () => chat.textSize,
        (size) => chat.setTextSize(size),
        this.#status,
      ),
      preferenceSwitch(
        "Timestamps",
        () => chat.timestamps,
        (on) => chat.setTimestamps(on),
        this.#status,
        "Each message shows the time its host reported. Messages from hosts that report none show no time.",
      ),
      preferenceSwitch(
        "Expand thinking",
        () => chat.thinkingExpanded,
        (on) => chat.setThinkingExpanded(on),
        this.#status,
        "New thinking blocks start open.",
      ),
      preferenceSwitch(
        "Expand tool output",
        () => chat.toolOutputExpanded,
        (on) => chat.setToolOutputExpanded(on),
        this.#status,
        "New tool cards start open.",
      ),
      preferenceDropdown(
        "Group tool calls",
        TOOL_GROUPINGS,
        () => chat.toolGrouping,
        (grouping) => chat.setToolGrouping(grouping),
        this.#status,
        'Consecutive tool calls fold into one line, such as "17 tool calls". A message from you or the assistant ends a group.',
      ),
    ];
    for (const control of controls) this.#syncs.push(control.sync);
    this.node.append(
      heading,
      element(
        "p",
        "section-copy",
        "These apply to every session in this browser, right away. A thinking block or tool card you opened or closed yourself stays as you left it.",
      ),
      ...controls.map((control) => control.node),
      this.#status,
    );
  }

  /** Settings reopened: the saved choices, and no outcome from last time. */
  reset(): void {
    for (const sync of this.#syncs) sync();
    setText(this.#status, "");
  }
}
