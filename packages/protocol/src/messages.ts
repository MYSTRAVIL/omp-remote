/**
 * Row ids and prompt text for omp messages, shared by every host emitter (the
 * bridge's IPC feed, its history re-send, the Collab translator) and the phone.
 */

/**
 * The transcript row id of an omp message. omp gives a message no id, but every
 * event for one message carries the same `timestamp`, so role + timestamp name
 * its row, the same live and from stored history. `occurrence` counts distinct
 * messages of that role with that very millisecond, oldest first: a second one
 * gets its own row rather than overwriting the first.
 */
export function feedMsgId(
  role: string,
  timestamp: number,
  occurrence = 1,
): string {
  return occurrence > 1
    ? `${role}-${timestamp}-${occurrence}`
    : `${role}-${timestamp}`;
}

/**
 * Hands out {@link feedMsgId}s to a live, ordered event stream. A message's
 * events all get the row its first event opened; once it ends, a later message
 * with the same role and millisecond (it can only start after the earlier one
 * ended) takes the next occurrence. Only the last ended message per role is
 * remembered: timestamps only grow, so an older one never comes back.
 */
export class FeedMsgIds {
  /** The occurrence open (streaming) per role + timestamp. */
  readonly #open = new Map<string, number>();
  /** Per role, the timestamp and occurrence of the message that ended last. */
  readonly #ended = new Map<
    string,
    { timestamp: number; occurrence: number }
  >();

  /** The row of an event of the message with this role and timestamp. */
  id(role: string, timestamp: number): string {
    return feedMsgId(role, timestamp, this.#occurrence(role, timestamp));
  }

  /** The row of the message's last event: it ends here. */
  end(role: string, timestamp: number): string {
    const occurrence = this.#occurrence(role, timestamp);
    this.#open.delete(feedMsgId(role, timestamp));
    this.#ended.set(role, { timestamp, occurrence });
    return feedMsgId(role, timestamp, occurrence);
  }

  #occurrence(role: string, timestamp: number): number {
    const base = feedMsgId(role, timestamp);
    const open = this.#open.get(base);
    if (open !== undefined) return open;
    const last = this.#ended.get(role);
    const occurrence = last?.timestamp === timestamp ? last.occurrence + 1 : 1;
    this.#open.set(base, occurrence);
    return occurrence;
  }
}

/**
 * A prompt's text as the phone's copy and omp's user message are compared:
 * line endings unified, Unicode composed, outer whitespace dropped.
 */
export function normalizePromptText(text: string): string {
  return text.replace(/\r\n?/g, "\n").normalize("NFC").trim();
}
