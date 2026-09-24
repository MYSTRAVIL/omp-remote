// Disposable OMP extension for the parity probes (overnight run
// `2026-09-12-parity-preview`, queue item "Build disposable integration probes").
//
// Loaded into an ephemeral spawned RPC session with:
//   omp --mode rpc --no-session --no-extensions --no-skills --no-rules -e <this file>
//
// It registers three harmless slash commands that raise the standard extension
// dialogs (`select` / `confirm` / `input`). Over RPC each dialog is bridged to the
// client as an `extension_ui_request` frame; the client replies with an
// `extension_ui_response`. Each handler then echoes the resolved value back through
// `ctx.ui.notify(...)` (another `extension_ui_request`), so the probe client can
// assert the full round-trip: request emitted -> client answered -> the exact value
// reached the extension.
//
// This exercises the ADOPTED-path control surface (the `ExtensionContext` API an
// adopted session also receives) through the RPC bridge. RPC delivery does NOT prove
// a real adopted terminal session; that remains a morning check. Nothing here touches
// a real user session, production IPC, or credentials.
//
// Types are a minimal local structural subset of the omp extension API — this file is
// standalone under `scripts/` (no path to the workspace `@oh-my-pi/pi-coding-agent`
// types), and omp injects the real `ExtensionAPI` object at load time. Only the
// members the probe actually calls are declared.

/** The rich-ask question shape (subset of `ExtensionAskDialogQuestion`). */
interface ProbeAskQuestion {
  id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
}

/** Subset of `ExtensionUIContext` used by the probe. */
interface ProbeUiContext {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  askDialog?(questions: ProbeAskQuestion[]): Promise<unknown>;
}

/** Subset of `ExtensionCommandContext` used by the probe. */
interface ProbeCommandContext {
  ui: ProbeUiContext;
}

/** Subset of `ExtensionAPI` used by the probe. */
interface ProbeExtensionApi {
  setLabel(label: string): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: ProbeCommandContext) => Promise<void>;
    },
  ): void;
}

/** Prefix every probe echo so the client can match round-trip notifications. */
export const PROBE_ECHO_PREFIX = "parity-probe";

/** Fixed option set the `select` probe presents; the client answers with one of these. */
export const PROBE_SELECT_OPTIONS = ["alpha", "beta", "gamma"] as const;

export default function parityProbeExtension(pi: ProbeExtensionApi): void {
  pi.setLabel(PROBE_ECHO_PREFIX);

  const echo = (
    ctx: ProbeCommandContext,
    kind: string,
    value: string,
  ): void => {
    const line = `${PROBE_ECHO_PREFIX}:${kind}:${value}`;
    ctx.ui.setStatus(`${PROBE_ECHO_PREFIX}:${kind}`, value);
    ctx.ui.notify(line, "info");
  };

  pi.registerCommand("probe-select", {
    description: "Parity probe: raise a select dialog and echo the choice.",
    handler: async (_args: string, ctx: ProbeCommandContext): Promise<void> => {
      const choice = await ctx.ui.select("Parity probe: pick one", [
        ...PROBE_SELECT_OPTIONS,
      ]);
      echo(ctx, "select", choice ?? "<cancelled>");
    },
  });

  pi.registerCommand("probe-confirm", {
    description: "Parity probe: raise a confirm dialog and echo the answer.",
    handler: async (_args: string, ctx: ProbeCommandContext): Promise<void> => {
      const confirmed = await ctx.ui.confirm(
        "Parity probe",
        "Confirm the probe?",
      );
      echo(ctx, "confirm", confirmed ? "yes" : "no");
    },
  });

  pi.registerCommand("probe-input", {
    description: "Parity probe: raise a text input dialog and echo the text.",
    handler: async (_args: string, ctx: ProbeCommandContext): Promise<void> => {
      const text = await ctx.ui.input(
        "Parity probe: type something",
        "e.g. hello",
      );
      echo(ctx, "input", text ?? "<cancelled>");
    },
  });

  // Rich ask (`ctx.ui.askDialog`) is optional and documented TUI-only. Probe it only
  // when the running surface actually exposes it, and record its absence honestly
  // rather than faking support.
  pi.registerCommand("probe-ask", {
    description: "Parity probe: raise the rich ask dialog when supported.",
    handler: async (_args: string, ctx: ProbeCommandContext): Promise<void> => {
      const askDialog = ctx.ui.askDialog;
      if (!askDialog) {
        echo(ctx, "ask", "<unsupported>");
        return;
      }
      const result = await askDialog.call(ctx.ui, [
        {
          id: "q1",
          question: "Parity probe: rich ask",
          options: [{ label: "one" }, { label: "two" }],
        },
      ]);
      echo(ctx, "ask", result ? JSON.stringify(result) : "<cancelled>");
    },
  });
}
