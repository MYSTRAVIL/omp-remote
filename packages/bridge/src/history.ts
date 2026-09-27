import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
  FeedMsgIds,
  type UplinkFrame,
  describeToolCall,
  toolPreview,
} from "@omp-remote/protocol";

/** Most transcript rows (messages and tool cards) a (re)connect re-sends. */
const HISTORY_ROWS = 200;
/** Most text, in UTF-8 bytes, a (re)connect re-sends: messages, and tool
 *  cards' titles and bodies. Every session's backfill lands in each phone's
 *  replay, which the relay must hold unsent without passing its per-socket
 *  cap; the newest row goes regardless, as it went live at that size. */
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
 * titled and described as it was live, done once its result is in (and then
 * showing the head of it). A message is `end`, stamped with the time omp
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
    ids.set(
      entry,
      keyer.end(message.role, message.timestamp, textOf(message.content)),
    );
  }

  // Walk back from the newest entry: a tool call's result, which follows the
  // call, is met first. Rows collect newest first and are flipped at the end.
  const rows: UplinkFrame[] = [];
  const results = new Map<string, { content: unknown; isError: boolean }>();
  let bytes = 0;
  for (let index = branch.length - 1; index >= from; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult") {
      results.set(message.toolCallId, message);
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
        const result = results.get(block.id);
        const card = describeToolCall(
          block.name,
          block.arguments,
          block.intent,
        );
        const preview = result
          ? toolPreview(card, result.content)
          : card.argument;
        own.push({
          row: {
            t: "tool",
            sessionId,
            phase: result ? "end" : "start",
            callId: block.id,
            name: card.name,
            status: !result ? "running" : result.isError ? "error" : "done",
            title: card.title,
            preview,
          },
          size: Buffer.byteLength(card.title + preview, "utf8"),
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
