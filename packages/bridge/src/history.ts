import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
  FeedMsgIds,
  type UplinkFrame,
  parseXdevWrite,
} from "@omp-remote/protocol";

/** Most transcript rows (messages and tool cards) a (re)connect re-sends. */
const HISTORY_ROWS = 200;
/** Most message text, in UTF-8 bytes, a (re)connect re-sends. Every session's
 *  backfill lands in each phone's replay, which the relay must hold unsent
 *  without passing its per-socket cap; the newest row goes regardless, as it
 *  went live at that size. */
const HISTORY_TEXT_BYTES = 256 * 1024;

/** The text blocks of a message's content, joined; "" when there are none. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) =>
        c && typeof c === "object" && "text" in c && typeof c.text === "string"
          ? c.text
          : "",
      )
      .join("");
  return "";
}

/**
 * The session's recent transcript as the IPC feed shows it live, for the
 * backfill a (re)connect sends first: an agent that restarted, or dropped this
 * bridge's connection, has forgotten it, and a phone opened afterwards would
 * show only what streams from then on. It is read from omp's own session (the
 * current branch, from its last `/clear`), so no second copy is kept.
 *
 * Each row carries the id its live frame carries, so an open phone updates its
 * rows in place: every user message, an assistant message with text, and a
 * card per tool call (`ask` excepted; an `xd://` write under its device name),
 * done once its result is in. A message is `end`, stamped with the time omp
 * wrote it. Only the newest {@link HISTORY_ROWS} rows go, within
 * {@link HISTORY_TEXT_BYTES} of text; images are not re-sent.
 */
export function historyFrames(
  sessionId: string,
  branch: readonly SessionEntry[],
): UplinkFrame[] {
  // Ids come from the keyer the live feed uses, run over the whole branch in
  // order, so a second same-role message of one millisecond numbers alike.
  const keyer = new FeedMsgIds();
  const ids = new Map<SessionEntry, string>();
  let from = 0;
  for (const [index, entry] of branch.entries()) {
    if (entry.type === "reset_boundary") from = index + 1;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    ids.set(entry, keyer.end(message.role, message.timestamp));
  }

  // Walk back from the newest entry: a tool call's result, which follows the
  // call, is met first. Rows collect newest first and are flipped at the end.
  const rows: UplinkFrame[] = [];
  const answered = new Set<string>();
  let bytes = 0;
  for (let index = branch.length - 1; index >= from; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult") {
      answered.add(message.toolCallId);
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const msgId = ids.get(entry);
    if (msgId === undefined) continue;
    // This message's rows, newest first: its tool cards follow its text.
    const own: { row: UplinkFrame; size: number }[] = [];
    if (message.role === "assistant")
      for (const block of message.content.toReversed()) {
        if (block.type !== "toolCall" || block.name === "ask") continue;
        const done = answered.has(block.id);
        const xdev = parseXdevWrite(block.name, block.arguments);
        own.push({
          row: {
            t: "tool",
            sessionId,
            phase: done ? "end" : "start",
            callId: block.id,
            name: xdev ? xdev.device : block.name,
            status: done ? "done" : "running",
            preview: "",
          },
          size: 0,
        });
      }
    const text = textOf(message.content);
    // A tool-call-only assistant message never shows as a row.
    if (message.role === "user" || text !== "")
      own.push({
        row: {
          t: "msg",
          sessionId,
          phase: "end",
          msgId,
          role: message.role,
          text,
          at: message.timestamp,
        },
        size: Buffer.byteLength(text, "utf8"),
      });
    for (const { row, size } of own) {
      const full =
        rows.length === HISTORY_ROWS ||
        (rows.length > 0 && bytes + size > HISTORY_TEXT_BYTES);
      if (full) return rows.reverse();
      bytes += size;
      rows.push(row);
    }
  }
  return rows.reverse();
}
