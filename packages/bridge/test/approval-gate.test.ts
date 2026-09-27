import { expect, test } from "bun:test";
import {
  type ApprovalGate,
  gates,
  resolveApprovalGate,
  toolTier,
} from "../src/approval-gate";

/** The calls of `calls` a gate asks the user about. */
function asked(
  gate: ApprovalGate,
  calls: [tool: string, input?: unknown][],
): string[] {
  return calls
    .filter(([tool, input]) => gates(gate, tool, input))
    .map(([tool]) => tool);
}

const CALLS: [tool: string, input?: unknown][] = [
  ["read", { path: "src/a.ts" }],
  ["grep", { pattern: "TODO", path: "src" }],
  ["glob", { pattern: "**/*.ts" }],
  ["web_search", { query: "bun" }],
  ["todo", {}],
  ["edit", { path: "src/a.ts" }],
  ["write", { path: "src/b.ts", content: "x" }],
  ["mcp__browser_click", { ref: "e1" }],
  ["bash", { command: "rm -rf build" }],
  ["eval", { code: "1" }],
  ["task", {}],
  ["deploy_site", {}],
];

test("always-ask asks before every write and every run of code, never before a read", () => {
  expect(asked(resolveApprovalGate("always-ask", undefined), CALLS)).toEqual([
    "edit",
    "write",
    "mcp__browser_click",
    "bash",
    "eval",
    "task",
    "deploy_site",
  ]);
});

test("write mode asks only before code runs, as omp's --approval-mode write", () => {
  expect(asked(resolveApprovalGate("write", undefined), CALLS)).toEqual([
    "bash",
    "eval",
    "task",
    "deploy_site",
  ]);
});

test("a file tool's target moves its tier as omp's does", () => {
  // Another host or a running process: code runs.
  expect(toolTier("read", { path: "ssh://box/etc/hosts" })).toBe("exec");
  expect(toolTier("write", { path: "proc://job-1", content: "y" })).toBe(
    "exec",
  );
  // The session's own scratch space, or a message to another agent.
  expect(toolTier("write", { path: "local://PLAN.md" })).toBe("read");
  expect(toolTier("write", { path: "[local://PLAN.md#1A2B]" })).toBe("read");
  expect(toolTier("write", { path: "agent://Main", content: "hi" })).toBe(
    "read",
  );
  expect(toolTier("edit", { paths: ["local://PLAN.md", "src/a.ts"] })).toBe(
    "write",
  );
  // A name the table does not list is exec, even a prototype key.
  expect(toolTier("constructor", {})).toBe("exec");
});

test("the flag asks at the terminal too; an unknown value asks for every tool", () => {
  expect(resolveApprovalGate("write", "all")).toMatchObject({ desk: true });
  expect(gates(resolveApprovalGate("nuke", undefined), "read", {})).toBe(true);
  expect(gates(resolveApprovalGate(true, undefined), "read", {})).toBe(true);
  expect(gates(resolveApprovalGate("yolo", "all"), "bash", {})).toBe(false);
});

test("OMP_REMOTE_APPROVAL keeps its phone-only meaning", () => {
  expect(resolveApprovalGate(undefined, "all")).toMatchObject({ desk: false });
  expect(asked(resolveApprovalGate(undefined, "all"), CALLS)).toHaveLength(
    CALLS.length,
  );
  // A list names tools, so `write` is the write tool alone.
  expect(asked(resolveApprovalGate(undefined, "bash, write"), CALLS)).toEqual([
    "write",
    "bash",
  ]);
  expect(asked(resolveApprovalGate(undefined, undefined), CALLS)).toEqual([]);
  expect(asked(resolveApprovalGate(undefined, "off"), CALLS)).toEqual([]);
});

test("the ask tool is never gated: it is the question channel", () => {
  for (const flag of ["always-ask", "nuke"])
    expect(gates(resolveApprovalGate(flag, undefined), "ask", {})).toBe(false);
  expect(gates(resolveApprovalGate(undefined, "all"), "ask", {})).toBe(false);
});
