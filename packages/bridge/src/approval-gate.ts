import { ApprovalMode } from "@omp-remote/protocol";

/**
 * The bridge's tool approval gate: which tool calls it asks the user about,
 * and whether it asks at the terminal as well as on the phone. Two sources,
 * the flag first:
 *
 * - `--omp-remote-approval=<mode>` (protocol `REMOTE_APPROVAL_FLAG`), which
 *   the bridge registers. The host-agent passes it to a session it spawns for
 *   the phone with omp's own approval off (`--approval-mode yolo`), so this
 *   gate is that session's only one: it asks at the terminal and on the phone
 *   at once and applies omp's meaning of the mode (see {@link toolTier}).
 * - `OMP_REMOTE_APPROVAL`, an opt-in phone-only gate on top of omp's own
 *   approval mode, which keeps asking at the terminal: unset/`off` never asks,
 *   `all` asks for every tool, a CSV list for exactly those tool names.
 *
 * The `ask` tool is never gated: it is the question channel itself.
 */
export interface ApprovalGate {
  policy: GatePolicy;
  /** Ask at the terminal too: set by the flag, whose session runs with omp's
   *  own approval off. */
  desk: boolean;
}

export type GatePolicy =
  | { kind: "none" }
  | { kind: "every" }
  /** omp's `always-ask` (`read`) and `write` (`write`): ask for every tool
   *  whose tier is above `tier`. */
  | { kind: "above"; tier: "read" | "write" }
  | { kind: "named"; tools: ReadonlySet<string> };

/** omp's capability tiers, least to most privileged (omp `ToolTier`). */
export type ToolTier = "read" | "write" | "exec";

const TIER_RANK: Record<ToolTier, number> = { read: 0, write: 1, exec: 2 };

/**
 * omp's (18.3) tier for the tools that declare one below exec; every other tool
 * is exec-tier, as omp treats a tool that declares none: `bash`, `eval`,
 * `task`, `debug`, `github`, extension tools.
 *
 * - `read`: the tool reads the workspace, the web or the session and changes
 *   nothing, so omp's `always-ask` and `write` modes never ask for it.
 * - `write`: the tool changes files or session state but runs no code, so
 *   omp's `write` mode does not ask for it. MCP tools (`mcp__…`) are
 *   write-tier in omp too.
 *
 * omp tiers the file tools by their target ({@link EXEC_URL},
 * {@link SCRATCH_URL}). Any other tool whose omp tier depends on its input
 * sits at its highest tier here (`lsp`: a query or a rename; `context_notes`:
 * a read or a replace; `debug`: a stack trace or a step), so the gate may ask
 * where omp would not.
 */
const TOOL_TIERS: Record<string, "read" | "write"> = {
  read: "read",
  grep: "read",
  glob: "read",
  find: "read",
  ast_grep: "read",
  web_search: "read",
  ask: "read",
  todo: "read",
  think: "read",
  yield: "read",
  wait: "read",
  checkpoint: "read",
  rewind: "read",
  recall: "read",
  reflect: "read",
  retain: "read",
  memory_edit: "read",
  vibe_wait: "read",
  vibe_list: "read",
  vibe_kill: "read",
  edit: "write",
  write: "write",
  ast_edit: "write",
  lsp: "write",
  context_notes: "write",
  new_context: "write",
  manage_skill: "write",
  learn: "write",
  generate_image: "write",
  tts: "write",
};

/** Internal URL schemes omp raises a file tool to the exec tier for: `ssh://`
 *  runs commands on another host, and a `proc://` write feeds a running
 *  process. */
const EXEC_URL = /(?:ssh|proc):\/\//i;

/** Targets omp's file tools write at the read tier: the session's own
 *  `local://` space and another agent's `agent://` inbox (a message). A
 *  `[path#TAG]` hashline wrapper may enclose the path. */
const SCRATCH_URL = /^\[?(?:local|agent):\/\/?/i;

/** The file tools whose tier {@link SCRATCH_URL} lowers. */
const FILE_WRITE_TOOLS: Record<string, true> = {
  write: true,
  edit: true,
  ast_edit: true,
};

/** Longest input the terminal dialog shows, as omp's own approval prompt. */
const PROMPT_INPUT_MAX = 2000;

/**
 * The gate for this session. `flag` is the `--omp-remote-approval` value
 * (`undefined` when absent), `env` is `OMP_REMOTE_APPROVAL`. A flag value
 * other than an omp approval mode asks for every tool: consent is never
 * assumed.
 */
export function resolveApprovalGate(
  flag: boolean | string | undefined,
  env: string | undefined,
): ApprovalGate {
  if (flag !== undefined) return { policy: flagPolicy(flag), desk: true };
  return { policy: envPolicy(env), desk: false };
}

function flagPolicy(flag: boolean | string): GatePolicy {
  const mode = ApprovalMode.safeParse(flag);
  if (!mode.success) return { kind: "every" };
  switch (mode.data) {
    case "always-ask":
      return { kind: "above", tier: "read" };
    case "write":
      return { kind: "above", tier: "write" };
    case "yolo":
      return { kind: "none" };
  }
}

function envPolicy(raw: string | undefined): GatePolicy {
  const value = raw?.trim();
  if (!value || value === "off" || value === "false") return { kind: "none" };
  if (value === "all" || value === "true") return { kind: "every" };
  return {
    kind: "named",
    tools: new Set(
      value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
  };
}

/** The string paths a tool input names (`path`, `paths`). */
function pathsOf(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const named = [
    "path" in input ? input.path : undefined,
    "paths" in input ? input.paths : undefined,
  ].flat();
  return named.filter((value): value is string => typeof value === "string");
}

/** omp's tier for a call: by tool name, then by the target a file tool names
 *  ({@link EXEC_URL}, {@link SCRATCH_URL}). */
export function toolTier(toolName: string, input: unknown): ToolTier {
  let tier: ToolTier = "exec";
  if (Object.hasOwn(TOOL_TIERS, toolName)) tier = TOOL_TIERS[toolName] ?? tier;
  else if (toolName.startsWith("mcp__")) tier = "write";
  if (tier === "exec") return tier;
  const paths = pathsOf(input);
  if (paths.some((path) => EXEC_URL.test(path))) return "exec";
  if (
    Object.hasOwn(FILE_WRITE_TOOLS, toolName) &&
    paths.length > 0 &&
    paths.every((path) => SCRATCH_URL.test(path))
  )
    return "read";
  return tier;
}

/** Whether the gate asks the user before this call runs. */
export function gates(
  gate: ApprovalGate,
  toolName: string,
  input: unknown,
): boolean {
  if (toolName === "ask") return false;
  const { policy } = gate;
  switch (policy.kind) {
    case "none":
      return false;
    case "every":
      return true;
    case "named":
      return policy.tools.has(toolName);
    case "above":
      return TIER_RANK[toolTier(toolName, input)] > TIER_RANK[policy.tier];
  }
}

/** The terminal dialog's title, shaped like omp's own approval prompt. */
export function approvalPrompt(toolName: string, input: unknown): string {
  const details =
    input === undefined ? "" : (JSON.stringify(input, null, 2) ?? "");
  if (details === "") return `Allow tool: ${toolName}`;
  const shown =
    details.length > PROMPT_INPUT_MAX
      ? `${details.slice(0, PROMPT_INPUT_MAX)}\u2026`
      : details;
  return `Allow tool: ${toolName}\n${shown}`;
}
