import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import {
  type AgentDiagnosticSink,
  consoleAgentDiagnostic,
} from "./diagnostics";

export const DEFAULT_LOG_ROTATION_BYTES = 10 * 1024 * 1024;

export interface LogRotationOptions {
  /** Checked once at launch; this is not a hard runtime size bound. */
  thresholdBytes?: number;
}

export type LogRotationResult = "missing" | "below-threshold" | "rotated";

/**
 * Rotate `path` at launch, retaining `path.1` and `path.2`. The caller owns
 * failure containment because diagnostics must never prevent the host starting.
 */
export function rotateLog(
  path: string,
  opts: LogRotationOptions = {},
): LogRotationResult {
  if (!existsSync(path)) return "missing";
  const threshold = opts.thresholdBytes ?? DEFAULT_LOG_ROTATION_BYTES;
  if (statSync(path).size < threshold) return "below-threshold";

  rmSync(`${path}.2`, { force: true });
  if (existsSync(`${path}.1`)) renameSync(`${path}.1`, `${path}.2`);
  renameSync(path, `${path}.1`);
  return "rotated";
}

/** Run launch rotation without making logging an availability dependency. */
export function rotateLogForLaunch(
  path: string,
  diagnostic: AgentDiagnosticSink = consoleAgentDiagnostic,
  opts: LogRotationOptions = {},
): boolean {
  try {
    rotateLog(path, opts);
    return true;
  } catch {
    try {
      diagnostic({ event: "log_rotation_failed", code: "io-failed" });
    } catch {
      // Logging must never become a launch dependency.
    }
    return false;
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  let rotated = false;
  if (path === undefined) {
    consoleAgentDiagnostic({
      event: "log_rotation_failed",
      code: "io-failed",
    });
  } else {
    rotated = rotateLogForLaunch(path);
  }
  if (!rotated) process.exitCode = 1;
}
