// A `system` message is a notice the host injected into the conversation (a
// background job's result, a reminder). The phone shows it as a collapsed
// card: a label from its kind, a one-line preview, and the body underneath.

/** Labels for notice kinds whose humanized name would read wrong. */
const NOTICE_LABELS: Record<string, string> = {
  "async-result": "Background result",
  "mid-run-todo-nudge": "Mid-run todo nudge",
};

/** The card's label: a known kind's name, any other kind humanized
 *  (`context-warning` → "Context warning"), "System" without one. */
export function noticeLabel(kind: string | undefined): string {
  if (kind === undefined) return "System";
  const known = NOTICE_LABELS[kind];
  if (known !== undefined) return known;
  const words = kind.replace(/[-_]+/g, " ").trim();
  if (words === "") return "System";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const WRAPPER = /^<([a-z][a-z0-9-]*)>([\s\S]*)<\/\1>$/;

/** The notice's own text: when the whole text is one XML-style wrapper
 *  (`<system-notice>…</system-notice>`), its trimmed content; otherwise the
 *  text as is. Only that single outer pair goes — a mismatched pair, tags
 *  inside, or a second wrapper of the same name stay as text. */
export function unwrapNotice(text: string): string {
  const trimmed = text.trim();
  const match = WRAPPER.exec(trimmed);
  if (!match) return text;
  const [, name, inner = ""] = match;
  if (inner.includes(`</${name}>`)) return text;
  return inner.trim();
}

/** The first non-empty line of a notice body, trimmed, for the card's
 *  collapsed summary. */
export function noticePreview(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}
