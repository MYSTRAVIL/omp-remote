// Parity integration smoke probe (overnight run `2026-09-12-parity-preview`, queue
// item "Build disposable integration probes and report API gaps").
//
// Spawns one ephemeral, disposable `omp --mode rpc` session with the probe extension
// (`probe-extension.ts`) and exercises the real RPC control surface end to end:
//
//   - observed readiness (`ready` frame),
//   - state snapshot (`get_state`),
//   - command discovery (`get_available_commands`),
//   - paged history (`get_messages_page`),
//   - subagent reads (`get_subagents`),
//   - extension dialog round-trips (`select` / `confirm` / `input`) through the actual
//     `extension_ui_request` / `extension_ui_response` bridge,
//   - rich ask (`askDialog`) support detection,
//   - the native tool-approval seam (documented gap; not runtime-answerable),
//   - the adopted plain-TUI path (recorded unperformed without a PTY driver).
//
// Every operation prints an explicit pass/fail/unsupported/unperformed/blocked line.
// Teardown is deterministic (kill + await exit + temp-dir removal). Exit code is 0
// only when every REQUIRED operation passed; informational gaps do not fail the run.
//
// Run:  OMP_BIN=<omp> bun run scripts/parity/smoke.ts
import {
  type ExtensionUiReply,
  RpcProbeClient,
  probeExtensionPath,
} from "./probe-client";

type OpStatus = "pass" | "fail" | "unsupported" | "unperformed" | "blocked";

interface OpResult {
  name: string;
  status: OpStatus;
  /** REQUIRED operations must be `pass` for the run to succeed. */
  required: boolean;
  detail: string;
}

const results: OpResult[] = [];

function record(
  name: string,
  status: OpStatus,
  required: boolean,
  detail: string,
): void {
  results.push({ name, status, required, detail });
  console.log(`[${status.toUpperCase()}] ${name} — ${detail}`);
}

/** Narrow RPC response data to a record or throw with context. */
function requireRecord(data: unknown, what: string): Record<string, unknown> {
  if (typeof data !== "object" || data === null)
    throw new Error(`${what}: expected an object, got ${typeof data}`);
  // `data` is validated as a non-null object above.
  return data as Record<string, unknown>;
}

interface SessionStateInfo {
  sessionId: string;
  isStreaming: boolean;
}

function parseSessionState(data: unknown): SessionStateInfo {
  const rec = requireRecord(data, "get_state");
  if (typeof rec.sessionId !== "string")
    throw new Error("get_state: missing sessionId");
  if (typeof rec.isStreaming !== "boolean")
    throw new Error("get_state: missing isStreaming");
  return { sessionId: rec.sessionId, isStreaming: rec.isStreaming };
}

function parseCommandNames(data: unknown): string[] {
  const rec = requireRecord(data, "get_available_commands");
  const commands = rec.commands;
  if (!Array.isArray(commands))
    throw new Error("get_available_commands: missing commands array");
  return commands.map((entry, index) => {
    const command = requireRecord(entry, `command[${index}]`);
    if (typeof command.name !== "string")
      throw new Error(`command[${index}]: missing name`);
    return command.name;
  });
}

function parseTotalMessages(data: unknown): number {
  const rec = requireRecord(data, "get_messages_page");
  if (typeof rec.totalMessages !== "number")
    throw new Error("get_messages_page: missing totalMessages");
  return rec.totalMessages;
}

function parseSubagentCount(data: unknown): number {
  const rec = requireRecord(data, "get_subagents");
  if (!Array.isArray(rec.subagents))
    throw new Error("get_subagents: missing subagents array");
  return rec.subagents.length;
}

const PROBE_COMMANDS = [
  "probe-select",
  "probe-confirm",
  "probe-input",
  "probe-ask",
] as const;

/** One dialog round-trip: the slash command to invoke and the echo it must produce. */
interface DialogCase {
  command: string;
  kind: string;
  expectedEcho: string;
}

async function main(): Promise<void> {
  const client = new RpcProbeClient({
    extraArgs: ["-e", probeExtensionPath()],
    readyTimeoutMs: 45_000,
    requestTimeoutMs: 30_000,
  });

  // Notify frames (the probe's echo channel) resolve pending round-trip waiters.
  const notifyWaiters = new Map<string, (message: string) => void>();
  const notifications: string[] = [];
  client.onExtensionUiRequest((frame): ExtensionUiReply | undefined => {
    const method = frame.method;
    if (method === "notify") {
      const message = typeof frame.message === "string" ? frame.message : "";
      notifications.push(message);
      for (const [kind, resolve] of notifyWaiters) {
        if (message.startsWith(`parity-probe:${kind}:`)) {
          notifyWaiters.delete(kind);
          resolve(message);
        }
      }
      return undefined;
    }
    if (
      method === "setStatus" ||
      method === "setWidget" ||
      method === "setTitle"
    )
      return undefined;
    if (method === "select")
      return { type: "extension_ui_response", id: frame.id, value: "beta" };
    if (method === "confirm")
      return { type: "extension_ui_response", id: frame.id, confirmed: true };
    if (method === "input")
      return {
        type: "extension_ui_response",
        id: frame.id,
        value: "typed-by-probe",
      };
    if (method === "editor")
      return { type: "extension_ui_response", id: frame.id, value: "edited" };
    // Any other dialog method (e.g. a bridged rich-ask): cancel cleanly so nothing hangs.
    return { type: "extension_ui_response", id: frame.id, cancelled: true };
  });

  try {
    const ready = await client.start();
    record(
      "ready",
      "pass",
      true,
      `protocolVersion=${ready.protocolVersion} maxFrameBytes=${ready.maxFrameBytes}`,
    );

    // --- get_state ---
    try {
      const state = parseSessionState(await client.getState());
      record(
        "get_state",
        "pass",
        true,
        `sessionId=${state.sessionId} isStreaming=${state.isStreaming}`,
      );
    } catch (err) {
      record("get_state", "fail", true, String(err));
    }

    // --- get_available_commands (and probe-extension load check) ---
    let probeCommandsLoaded = false;
    try {
      const names = new Set(
        parseCommandNames(await client.getAvailableCommands()),
      );
      const missing = PROBE_COMMANDS.filter((command) => !names.has(command));
      probeCommandsLoaded = missing.length === 0;
      record(
        "get_available_commands",
        "pass",
        true,
        `total=${names.size}; probe commands ${probeCommandsLoaded ? "present" : `missing: ${missing.join(",")}`}`,
      );
    } catch (err) {
      record("get_available_commands", "fail", true, String(err));
    }

    // --- get_messages_page ---
    try {
      const total = parseTotalMessages(
        await client.getMessagesPage({ limit: 10 }),
      );
      record("get_messages_page", "pass", true, `totalMessages=${total}`);
    } catch (err) {
      record("get_messages_page", "fail", true, String(err));
    }

    // --- get_subagents ---
    try {
      const count = parseSubagentCount(await client.getSubagents());
      record("get_subagents", "pass", true, `subagents=${count}`);
    } catch (err) {
      record("get_subagents", "fail", true, String(err));
    }

    // --- extension dialog round-trips ---
    // Only invoke the probe commands when they actually registered; otherwise a
    // slash that is not a command would fall through to a model turn.
    const dialogCases: DialogCase[] = [
      {
        command: "/probe-select",
        kind: "select",
        expectedEcho: "parity-probe:select:beta",
      },
      {
        command: "/probe-confirm",
        kind: "confirm",
        expectedEcho: "parity-probe:confirm:yes",
      },
      {
        command: "/probe-input",
        kind: "input",
        expectedEcho: "parity-probe:input:typed-by-probe",
      },
    ];

    if (!probeCommandsLoaded) {
      for (const c of dialogCases) {
        record(
          `dialog:${c.kind}`,
          "fail",
          true,
          "probe extension commands did not load; dialog not exercised",
        );
      }
      record(
        "dialog:ask",
        "unsupported",
        false,
        "probe extension commands did not load",
      );
    } else {
      for (const dialog of dialogCases) {
        try {
          const echoed = await runDialogRoundTrip(
            client,
            notifyWaiters,
            dialog,
          );
          if (echoed === dialog.expectedEcho) {
            record(
              `dialog:${dialog.kind}`,
              "pass",
              true,
              `round-trip echoed '${echoed}'`,
            );
          } else {
            record(
              `dialog:${dialog.kind}`,
              "fail",
              true,
              `expected '${dialog.expectedEcho}', got '${echoed}'`,
            );
          }
        } catch (err) {
          record(`dialog:${dialog.kind}`, "fail", true, String(err));
        }
      }

      // Rich ask: support is detected by the extension itself (echoes <unsupported>
      // when `ctx.ui.askDialog` is absent on the RPC surface).
      try {
        const echoed = await runAskRoundTrip(client, notifyWaiters);
        if (echoed === "parity-probe:ask:<unsupported>") {
          record(
            "dialog:ask",
            "unsupported",
            false,
            "ctx.ui.askDialog absent on the RPC surface (rich ask is TUI-only)",
          );
        } else {
          record(
            "dialog:ask",
            "pass",
            false,
            `rich ask bridged; echo '${echoed}'`,
          );
        }
      } catch (err) {
        record(
          "dialog:ask",
          "unsupported",
          false,
          `rich ask not exercised: ${err}`,
        );
      }
    }

    // --- native tool-approval seam (documented gap) ---
    // The RPC command union (rpc-types.ts `RpcCommand`) has no frame to observe or
    // resolve a native tool approval by id; native approvals are governed by the
    // spawn-time `--approval-mode`, not answered interactively. Exercising it would
    // require an approval with no reply channel, which would hang — so it is recorded
    // as a blocked upstream seam, distinct from the extension `confirm` dialog above,
    // which IS runtime-answerable.
    record(
      "native-approval-resolver",
      "blocked",
      false,
      "no RPC frame to resolve a native tool approval; governed by --approval-mode (source: rpc-types.ts RpcCommand). Distinct from extension confirm.",
    );

    // --- adopted plain-TUI path ---
    // The adopted seam is the extension API, exercised above through RPC. A real
    // interactive terminal session needs a PTY driver and must never touch a user's
    // live session; without a deterministic PTY runtime this stays a morning check.
    record(
      "adopted-tui",
      "unperformed",
      false,
      "no deterministic PTY driver; interactive adopted-session verification deferred (must not drive a real user session)",
    );
  } finally {
    await client.close();
  }

  const required = results.filter((r) => r.required);
  const failedRequired = required.filter((r) => r.status !== "pass");
  const summary = {
    ompBin: process.env.OMP_BIN ?? "omp",
    total: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    failedRequired: failedRequired.map((r) => r.name),
    results,
  };
  console.log(`\nPROBE_SUMMARY ${JSON.stringify(summary)}`);
  if (failedRequired.length > 0) {
    console.error(
      `\nFAIL: ${failedRequired.length} required operation(s) failed.`,
    );
    process.exit(1);
  }
  console.log("\nOK: all required operations passed.");
}

/** Race an echo waiter against a bounded deadline, clearing the timer either way. */
function awaitEcho(
  echo: Promise<string>,
  notifyWaiters: Map<string, (message: string) => void>,
  kind: string,
): Promise<string> {
  const deadline = Promise.withResolvers<string>();
  const timer = setTimeout(() => {
    notifyWaiters.delete(kind);
    deadline.reject(new Error(`no '${kind}' echo within 20000ms`));
  }, 20_000);
  return Promise.race([echo, deadline.promise]).finally(() =>
    clearTimeout(timer),
  );
}

/** Invoke a slash command and resolve the probe's echo notification for its dialog. */
async function runDialogRoundTrip(
  client: RpcProbeClient,
  notifyWaiters: Map<string, (message: string) => void>,
  dialog: DialogCase,
): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  notifyWaiters.set(dialog.kind, resolve);
  await client.prompt(dialog.command);
  return awaitEcho(promise, notifyWaiters, dialog.kind);
}

/** Rich-ask variant: same round-trip, keyed on the `ask` echo. */
async function runAskRoundTrip(
  client: RpcProbeClient,
  notifyWaiters: Map<string, (message: string) => void>,
): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  notifyWaiters.set("ask", resolve);
  await client.prompt("/probe-ask");
  return awaitEcho(promise, notifyWaiters, "ask");
}

await main();
