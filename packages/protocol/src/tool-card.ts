/**
 * What a phone tool card shows, derived alike by every host emitter (the
 * bridge's IPC feed and its restart backfill, the Collab translator), so a
 * card reads the same live, after a reconnect and in either mode.
 *
 * Its `title` is one line naming the call: the model's stated intent, else
 * the call's key argument. Its `preview`, the body the card opens to, holds
 * that argument whole and, once the call has output, the head of it. Both are
 * bounded: the host-agent keeps each card's last frame and sends it again in
 * every phone's replay.
 */
import { parseXdevWrite } from "./xdev";

/** Longest card title, in characters. */
export const TOOL_TITLE_MAX = 200;
/** The key argument's share of a card body. */
const ARGUMENT_CHARS = 500;
const ARGUMENT_LINES = 12;
/** The output's share of a card body. */
const OUTPUT_CHARS = 1500;
const OUTPUT_LINES = 30;
/** Longest card body, in characters: the argument, a blank line, the output. */
export const TOOL_PREVIEW_MAX = ARGUMENT_CHARS + 2 + OUTPUT_CHARS;

/** Argument keys that name what a call acts on, most telling first. */
const KEY_ARGUMENTS = [
  "command",
  "cmd",
  "script",
  "code",
  "pattern",
  "query",
  "url",
  "path",
  "file",
  "filePath",
  "file_path",
  "input",
  "prompt",
  "task",
  "text",
  "name",
];

/** A tool call as its card names and describes it, from what its start
 *  carries; the end of a call carries no arguments to derive it again. */
export interface ToolCard {
  /** The card's label: the tool, or the device an `xd://` write runs. */
  name: string;
  /** One line naming the call: its intent, else its key argument. */
  title: string;
  /** The key argument whole, within bounds: the body until output comes. */
  argument: string;
  /** The file the call names (its `path` or `file`), as given; "" when none. */
  file: string;
}

/** Cut `text` to `length` characters without splitting a surrogate pair. */
function cutAt(text: string, length: number): string {
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

/** Whitespace collapsed to single spaces, cut to a title's length. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TOOL_TITLE_MAX
    ? `${cutAt(flat, TOOL_TITLE_MAX - 1)}\u2026`
    : flat;
}

/**
 * `text` in at most `maxChars` characters and `maxLines` lines: line endings
 * unified, trailing blank space dropped, and "…" where it was cut (on a line
 * of its own when whole lines were left out).
 */
function clip(text: string, maxChars: number, maxLines: number): string {
  const all = text.replace(/\r\n?/g, "\n").trimEnd();
  let end = all.length;
  let at = -1;
  for (let line = 1; line <= maxLines; line++) {
    at = all.indexOf("\n", at + 1);
    if (at === -1) break;
    if (line === maxLines) end = at;
  }
  const limit = maxChars - 2;
  const midLine = end > limit;
  if (midLine) end = limit;
  if (end === all.length) return all;
  const head = cutAt(all, end).trimEnd();
  return midLine ? `${head}\u2026` : `${head}\n\u2026`;
}

/** A call's arguments by name; undefined unless they are a JSON object.
 *  Tool arguments are arbitrary per-tool JSON: every read checks its type. */
function argumentMap(args: unknown): Map<string, unknown> | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return undefined;
  return new Map<string, unknown>(Object.entries(args));
}

/** The argument that says most about a call, whole: the first key argument
 *  set, else the arguments as compact JSON (long strings cut); "" for none. */
function keyArgument(args: unknown): string {
  if (typeof args === "string") return args;
  const values = argumentMap(args);
  if (values === undefined || values.size === 0) return "";
  for (const key of KEY_ARGUMENTS) {
    const value = values.get(key);
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return JSON.stringify(args, (_key: string, value: unknown) =>
    typeof value === "string" && value.length > 120
      ? `${value.slice(0, 120)}\u2026`
      : value,
  );
}

/** The text of a tool's output: a string, a content array (a stored result
 *  message's), or a result's `content`; images and other blocks add none. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  const content =
    typeof output === "object" && output !== null && "content" in output
      ? output.content
      : output;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content)
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    )
      texts.push(block.text);
  return texts.join("\n");
}

/**
 * Name and describe a call from its start: the tool (for an `xd://` write,
 * the device, summarized by its own decoded arguments), its intent, its
 * arguments.
 */
export function describeToolCall(
  toolName: string,
  args: unknown,
  intent?: string,
): ToolCard {
  const xdev = parseXdevWrite(toolName, args);
  const key = keyArgument(xdev ? xdev.content : args);
  // An `xd://` write's `path` names the device, never a file.
  const values = xdev ? undefined : argumentMap(args);
  let file = "";
  for (const name of ["path", "file"]) {
    const value = values?.get(name);
    if (typeof value !== "string" || value.trim() === "") continue;
    file = value.trim();
    break;
  }
  return {
    name: xdev ? xdev.device : toolName,
    title: oneLine(intent ?? "") || oneLine(key),
    argument: clip(key, ARGUMENT_CHARS, ARGUMENT_LINES),
    file,
  };
}

/**
 * A card's body once the call has output (streamed so far, or its result):
 * the call's argument, a blank line, then the head of the output text. With
 * no text out yet the body stays the argument; a call whose start was not
 * seen shows its output alone.
 */
export function toolPreview(
  call: ToolCard | undefined,
  output: unknown,
): string {
  const text = clip(outputText(output), OUTPUT_CHARS, OUTPUT_LINES);
  const argument = call?.argument ?? "";
  if (text === "") return argument;
  return argument === "" ? text : `${argument}\n\n${text}`;
}
