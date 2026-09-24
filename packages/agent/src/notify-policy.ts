import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NotifyPolicyFrame } from "@omp-remote/protocol";
import { stateDir } from "@omp-remote/protocol/ipc";
import { type AgentDiagnosticSink, noAgentDiagnostic } from "./diagnostics";

/** How long the user must be away from this machine before a push, until the
 *  phone sets it. */
export const DEFAULT_AWAY_SEC = 120;

/** The persisted file: the `awaySec` of the phone's latest `notifyPolicy`. */
const StoredPolicy = NotifyPolicyFrame.pick({ awaySec: true });

/** `notify-policy.json` in the agent's state dir (beside `ipc-token`). */
export function notifyPolicyPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(stateDir(env), "notify-policy.json");
}

/** What the notifier reads: the current away time, and when it changes. */
export interface NotifyPolicySource {
  /** Seconds without keyboard or mouse input before a push; `0` pushes always. */
  readonly awaySec: number;
  /** Call `listener` whenever `awaySec` changes; returns an unsubscribe. */
  onChange(listener: () => void): () => void;
}

/**
 * This machine's notification policy, set from the phone (`notifyPolicy`) and
 * persisted so a restarted agent keeps it. Without a `path` it lives in memory
 * only. Reading and saving never throw: a file that cannot be read or written
 * leaves the policy working in memory and is reported.
 */
export class NotifyPolicy implements NotifyPolicySource {
  #awaySec = DEFAULT_AWAY_SEC;
  /** The value known to be in the file; `undefined` until a load or save finds one. */
  #stored: number | undefined;
  /** Saves run one at a time, each writing the latest value. */
  #saving: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<() => void>();
  readonly #path: string | undefined;
  readonly #diagnostic: AgentDiagnosticSink;

  constructor(opts: { path?: string; diagnostic?: AgentDiagnosticSink } = {}) {
    this.#path = opts.path;
    this.#diagnostic = opts.diagnostic ?? noAgentDiagnostic;
  }

  get awaySec(): number {
    return this.#awaySec;
  }

  /** Take the persisted policy. A missing file keeps the default; so does an
   *  unreadable or invalid one, which is reported. */
  async load(): Promise<void> {
    if (this.#path === undefined) return;
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (err) {
      const missing =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ENOENT";
      if (!missing)
        this.#diagnostic({
          event: "notify_policy_failed",
          code: "load-failed",
        });
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = StoredPolicy.safeParse(json);
    if (!parsed.success) {
      this.#diagnostic({ event: "notify_policy_failed", code: "load-failed" });
      return;
    }
    this.#stored = parsed.data.awaySec;
    this.#apply(parsed.data.awaySec);
  }

  /** Take the phone's policy: in effect at once, then saved. Resolves once it
   *  is saved (or the save failed and was reported); never rejects. */
  set(awaySec: number): Promise<void> {
    if (this.#apply(awaySec))
      this.#diagnostic({ event: "notify_policy_set", awaySec });
    const path = this.#path;
    if (path === undefined) return Promise.resolve();
    this.#saving = this.#saving.then(async () => {
      const value = this.#awaySec;
      if (value === this.#stored) return;
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, `${JSON.stringify({ awaySec: value })}\n`);
        this.#stored = value;
      } catch {
        this.#diagnostic({
          event: "notify_policy_failed",
          code: "save-failed",
        });
      }
    });
    return this.#saving;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Make `awaySec` current; true (listeners told) when it changed. */
  #apply(awaySec: number): boolean {
    if (awaySec === this.#awaySec) return false;
    this.#awaySec = awaySec;
    for (const listener of this.#listeners) listener();
    return true;
  }
}
