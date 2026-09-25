/**
 * omp v18.3.0 mounts discoverable tools (lsp, ast_edit, debug, gh, memory, ...)
 * plus extension and MCP tools as `xd://` devices. The model runs a device by
 * writing its JSON payload to `xd://<tool>`, so the call the agent loop sees is
 * `write` with `{ path: "xd://<tool>", content }`. omp then dispatches to the
 * real tool, which runs (and re-emits its own `tool_call`) under its real name.
 *
 * That double emission is why the remote approval gate and the phone's tool
 * cards must treat an `xd://` write specially: gate/label it as the device, not
 * as a generic `write`. This helper recognises the outer write and decodes the
 * device name plus its own arguments.
 */

/** The scheme prefix omp mounts discoverable/extension/MCP tools under. */
const XD_PREFIX = "xd://";

export interface XdevWrite {
  /** The mounted device's real tool name (e.g. `ast_edit`, `mcp__server_tool`). */
  device: string;
  /** The device's own arguments, decoded from the write `content` when it is
   *  JSON; the raw string when it is not parseable. */
  content: unknown;
}

/**
 * The `xd://` device a `write` call dispatches to, or `undefined` for any other
 * call (including a plain filesystem write and a bare `xd://` device listing).
 */
export function parseXdevWrite(
  toolName: string | undefined,
  input: unknown,
): XdevWrite | undefined {
  if (toolName !== "write") return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const path = record.path;
  if (typeof path !== "string" || !path.startsWith(XD_PREFIX)) return undefined;
  const device = path.slice(XD_PREFIX.length).trim();
  if (!device) return undefined; // `xd://` alone lists devices; not a dispatch.
  const raw = record.content;
  let content: unknown = raw;
  if (typeof raw === "string") {
    try {
      content = JSON.parse(raw);
    } catch {
      content = raw;
    }
  }
  return { device, content };
}
