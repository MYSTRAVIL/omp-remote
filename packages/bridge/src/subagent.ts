import { dirname, resolve } from "node:path";

/** What the bridge reads to tell a subagent from a session of its own; omp's
 *  `ExtensionContext` satisfies it. */
export interface SessionOrigin {
  hasUI: boolean;
  sessionManager: {
    getSessionFile(): string | undefined;
    getHeader(): { parentSession?: string } | null;
  };
}

const SESSION_FILE_EXT = ".jsonl";

/**
 * True when omp runs this session as a subagent (a `task` or eval `agent()`
 * child) rather than as a session of its own. omp runs a subagent in the
 * parent's process, headless (`hasUI` false), and stores it in the parent's
 * artifacts dir: `<parent>.jsonl` gets `<parent>/<agentId>.jsonl`, with the
 * parent file recorded as the header's `parentSession`. A fork also records a
 * parent but lives beside it, and a subagent transcript reopened in the TUI has
 * a UI, so neither counts.
 */
export function isSubagentSession(ctx: SessionOrigin): boolean {
  if (ctx.hasUI) return false;
  const file = ctx.sessionManager.getSessionFile();
  const parent = ctx.sessionManager.getHeader()?.parentSession;
  if (!file || !parent?.endsWith(SESSION_FILE_EXT)) return false;
  return (
    resolve(dirname(file)) ===
    resolve(parent.slice(0, -SESSION_FILE_EXT.length))
  );
}
