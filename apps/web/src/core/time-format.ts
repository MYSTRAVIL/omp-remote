const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The copy around these is English; clock times follow the reader's locale.
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const clock = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dated = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** How long before `now` a moment was: "just now", "5 minutes ago", "yesterday". */
export function timeAgo(then: number, now: number): string {
  // A clock set back since then reads as the moment itself, never the future.
  const elapsed = Math.max(0, now - then);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR)
    return relative.format(-Math.floor(elapsed / MINUTE), "minute");
  if (elapsed < DAY)
    return relative.format(-Math.floor(elapsed / HOUR), "hour");
  const days = Math.floor(elapsed / DAY);
  if (days < 7) return relative.format(-days, "day");
  if (days < 30) return relative.format(-Math.floor(days / 7), "week");
  if (days < 365) return relative.format(-Math.floor(days / 30), "month");
  return relative.format(-Math.floor(days / 365), "year");
}

/** A message's time: the clock time on the day of `now`, with the date before it. */
export function messageTime(at: number, now: number): string {
  const day = new Date(at);
  const today = new Date(now);
  const sameDay =
    day.getFullYear() === today.getFullYear() &&
    day.getMonth() === today.getMonth() &&
    day.getDate() === today.getDate();
  return (sameDay ? clock : dated).format(day);
}
