import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDiagnostic } from "../src/diagnostics";
import { rotateLog, rotateLogForLaunch } from "../src/log-rotation";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function logPath(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-remote-log-"));
  roots.push(root);
  return join(root, "agent.log");
}

test("launch rotation leaves a below-threshold log unchanged", () => {
  const path = logPath();
  writeFileSync(path, "current");

  expect(rotateLog(path, { thresholdBytes: 8 })).toBe("below-threshold");
  expect(readFileSync(path, "utf8")).toBe("current");
  expect(existsSync(`${path}.1`)).toBe(false);
});

test("launch rotation retains the two previous logs", () => {
  const path = logPath();
  writeFileSync(path, "current");
  writeFileSync(`${path}.1`, "previous");
  writeFileSync(`${path}.2`, "oldest");

  expect(rotateLog(path, { thresholdBytes: 7 })).toBe("rotated");
  expect(readFileSync(`${path}.1`, "utf8")).toBe("current");
  expect(readFileSync(`${path}.2`, "utf8")).toBe("previous");
  expect(existsSync(path)).toBe(false);
});

test("rotation failure emits a stable diagnostic and preserves startup availability", () => {
  const path = logPath();
  writeFileSync(path, "PRIVATE_CURRENT_LOG");
  writeFileSync(`${path}.1`, "PRIVATE_PREVIOUS_LOG");
  mkdirSync(`${path}.2`);
  writeFileSync(join(`${path}.2`, "blocker"), "PRIVATE_BLOCKER");
  const diagnostics: AgentDiagnostic[] = [];

  expect(
    rotateLogForLaunch(path, (event) => diagnostics.push(event), {
      thresholdBytes: 1,
    }),
  ).toBe(false);
  expect(diagnostics).toEqual([
    { event: "log_rotation_failed", code: "io-failed" },
  ]);
  expect(readFileSync(path, "utf8")).toBe("PRIVATE_CURRENT_LOG");
  expect(readFileSync(`${path}.1`, "utf8")).toBe("PRIVATE_PREVIOUS_LOG");
  expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_");
  expect(JSON.stringify(diagnostics)).not.toContain(path);
});

test("a failing diagnostic sink still cannot block startup", () => {
  const path = logPath();
  writeFileSync(path, "current");
  mkdirSync(`${path}.2`);
  writeFileSync(join(`${path}.2`, "blocker"), "blocker");

  expect(
    rotateLogForLaunch(
      path,
      () => {
        throw new Error("diagnostic sink unavailable");
      },
      { thresholdBytes: 1 },
    ),
  ).toBe(false);
});
