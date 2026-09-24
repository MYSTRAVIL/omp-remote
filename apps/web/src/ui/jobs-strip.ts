/// <reference lib="dom" />
import type { JobRow } from "@omp-remote/protocol";
import type { TranscriptEntry } from "../core/transcript";
import { element, setText, syncChildren } from "./dom";

/** One piece of work still running: an async job, or a `task` call the
 *  agent is waiting on (a synchronous subagent, which is not an async job). */
interface StripItem {
  key: string;
  label: string;
  type: string;
  /** Host epoch ms it started; undefined when the host does not say. */
  startMs: number | undefined;
}

interface StripRow {
  readonly node: HTMLLIElement;
  readonly label: HTMLElement;
  readonly type: HTMLElement;
  readonly elapsed: HTMLElement;
  startMs: number | undefined;
}

const SECOND = 1000;

/** "8s", "3m 05s", "1h 02m": how long something has been running. */
function elapsedText(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / SECOND);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function stripItems(
  jobs: readonly JobRow[],
  entries: readonly TranscriptEntry[],
): StripItem[] {
  const items: StripItem[] = jobs.map((job) => ({
    key: `job:${job.id}`,
    label: job.label || job.type,
    type: job.type,
    startMs: job.startMs,
  }));
  for (const entry of entries)
    if (entry.kind === "tool" && entry.name === "task" && !entry.done)
      items.push({
        key: `tool:${entry.callId}`,
        label: entry.title || "Subagent",
        type: "task",
        startMs: undefined,
      });
  return items;
}

/**
 * The session's running work, between the conversation and the composer:
 * async jobs and running `task` calls, each with its label, type and time
 * running. Hidden while nothing runs; elapsed times tick once a second only
 * while it shows.
 */
export class JobsStrip {
  readonly node = element("div", "jobs-strip");
  readonly #list = element("ul", "jobs-strip-list");
  readonly #rows = new Map<string, StripRow>();
  #timer = 0;

  constructor() {
    this.node.setAttribute("role", "region");
    this.node.setAttribute("aria-label", "Running work");
    this.node.hidden = true;
    this.node.append(this.#list);
  }

  /** Show what runs now; an ended session runs nothing. */
  update(
    jobs: readonly JobRow[],
    entries: readonly TranscriptEntry[],
    ended: boolean,
  ): void {
    const items = ended ? [] : stripItems(jobs, entries);
    const keys = new Set(items.map((item) => item.key));
    for (const key of this.#rows.keys())
      if (!keys.has(key)) this.#rows.delete(key);
    syncChildren(
      this.#list,
      items.map((item) => this.#row(item).node),
    );
    this.node.hidden = items.length === 0;
    this.#tick();
    if (this.node.hidden || !items.some((item) => item.startMs !== undefined))
      this.stop();
    else if (this.#timer === 0)
      this.#timer = window.setInterval(() => this.#tick(), SECOND);
  }

  /** Stop refreshing elapsed times: the view is hidden or gone. */
  stop(): void {
    clearInterval(this.#timer);
    this.#timer = 0;
  }

  #row(item: StripItem): StripRow {
    let row = this.#rows.get(item.key);
    if (!row) {
      const node = element("li", "jobs-strip-row");
      const label = element("span", "jobs-strip-label");
      const type = element("span", "jobs-strip-type");
      const elapsed = element("span", "jobs-strip-elapsed");
      node.append(label, type, elapsed);
      row = { node, label, type, elapsed, startMs: item.startMs };
      this.#rows.set(item.key, row);
    }
    row.startMs = item.startMs;
    setText(row.label, item.label);
    row.label.title = item.label;
    setText(row.type, item.type);
    row.elapsed.hidden = item.startMs === undefined;
    return row;
  }

  #tick(): void {
    const now = Date.now();
    for (const row of this.#rows.values())
      if (row.startMs !== undefined)
        setText(row.elapsed, elapsedText(now - row.startMs));
  }
}
