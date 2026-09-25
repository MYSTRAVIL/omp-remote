import type {
  ApprovalMode,
  SpawnFrame,
  SpawnThinkingLevel,
} from "@omp-remote/protocol";

/** What New session starts: a fresh session, or with `resume` a stored one of `cwd`. */
export interface SpawnOptions {
  cwd: string;
  model?: string;
  thinkingLevel?: SpawnThinkingLevel;
  approvalMode: ApprovalMode;
  /** A stored session of `cwd` to reopen (`omp --resume`); see `SpawnFrame`. */
  resume?: string;
}

/**
 * The `spawn` frame for New session. A resume sends no model: omp restores the
 * stored session's own, and the host ignores one anyway.
 */
export function spawnFrame(
  machineId: string,
  opts: SpawnOptions,
  spawnId: string,
): SpawnFrame {
  const { cwd, thinkingLevel, approvalMode, resume } = opts;
  const frame: SpawnFrame = {
    t: "spawn",
    machineId,
    cwd,
    approvalMode,
    spawnId,
  };
  if (thinkingLevel !== undefined) frame.thinkingLevel = thinkingLevel;
  if (resume !== undefined) frame.resume = resume;
  else if (opts.model !== undefined) frame.model = opts.model;
  return frame;
}
