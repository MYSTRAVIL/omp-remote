import type { IpcAuthFailureCode } from "@omp-remote/protocol/ipc";

export type BridgeRole = "feed" | "prompt-control";
export type PromptMode = "steer" | "followUp" | "aside";
export type PromptDispatchRoute =
  | "idle-start"
  | "active-steer"
  | "active-follow-up"
  | "active-aside";

export type BridgeDiagnostic =
  | {
      event: "bridge_mode_selected";
      mode: "ipc-feed" | "collab-prompt-control";
    }
  | {
      event: "ipc_connected";
      sessionId: string;
      role: BridgeRole;
    }
  | {
      event: "ipc_reconnect_scheduled";
      sessionId: string;
      role: BridgeRole;
      retryDelayMs: number;
      code: "connect-failed" | "connection-closed" | "auth-failed";
    }
  | {
      /** The bridge refused the IPC endpoint: it did not prove the token. */
      event: "ipc_auth_failed";
      sessionId: string;
      role: BridgeRole;
      code: IpcAuthFailureCode;
    }
  | {
      event: "prompt_received";
      sessionId: string;
      mode: PromptMode;
      role: BridgeRole;
    }
  | {
      event: "prompt_dispatch_accepted";
      sessionId: string;
      mode: PromptMode;
      route: PromptDispatchRoute;
      execution: "unconfirmed";
    }
  | { event: "model_execution_started"; sessionId: string }
  | {
      event: "bridge_operation_failed";
      sessionId?: string;
      code:
        | "callback-failed"
        | "approval-failed"
        | "service-tier-unsupported"
        | "attachment-unresolved"
        | "ipc-token-unavailable"
        /** The bridge created ipc-token but could not make it owner-only. */
        | "ipc-token-acl-failed"
        | "compact-failed";
    };

export type BridgeDiagnosticSink = (event: BridgeDiagnostic) => void;
export const noBridgeDiagnostic: BridgeDiagnosticSink = () => {};

type DiagnosticLevel = "info" | "warn" | "error";
type DiagnosticComponent =
  | "bridge"
  | "bridge.ipc"
  | "bridge.control"
  | "bridge.model";

type BridgeLogger = {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
};

function base(
  event: BridgeDiagnostic["event"],
  component: DiagnosticComponent,
  level: DiagnosticLevel,
  now: Date,
): Record<string, unknown> {
  return {
    timestamp: now.toISOString(),
    level,
    component,
    event,
  };
}

/** What an operator should read into each handshake failure. */
const IPC_AUTH_HINTS: Record<IpcAuthFailureCode, string> = {
  "agent-closed":
    "the IPC endpoint closed before proving the token: upgrade the host-agent (it must be deployed before this bridge) or check what owns the endpoint",
  "token-rejected":
    "the host-agent rejected this bridge's token: omp and the host-agent read different ipc-token files (check OMP_REMOTE_STATE_DIR)",
  "server-unproven":
    "the IPC endpoint could not prove the token: another process may be squatting it; the bridge sent it nothing",
  "protocol-error":
    "the IPC endpoint does not speak the handshake: another process may be squatting it",
};

function record(
  event: BridgeDiagnostic,
  now = new Date(),
): Record<string, unknown> {
  switch (event.event) {
    case "bridge_mode_selected":
      return {
        ...base(event.event, "bridge", "info", now),
        mode: event.mode,
      };
    case "ipc_connected":
      return {
        ...base(event.event, "bridge.ipc", "info", now),
        sessionId: event.sessionId,
        role: event.role,
      };
    case "ipc_reconnect_scheduled":
      return {
        ...base(event.event, "bridge.ipc", "warn", now),
        sessionId: event.sessionId,
        role: event.role,
        retryDelayMs: event.retryDelayMs,
        code: event.code,
      };
    case "ipc_auth_failed":
      return {
        ...base(event.event, "bridge.ipc", "error", now),
        sessionId: event.sessionId,
        role: event.role,
        code: event.code,
        hint: IPC_AUTH_HINTS[event.code],
      };
    case "prompt_received":
      return {
        ...base(event.event, "bridge.control", "info", now),
        sessionId: event.sessionId,
        mode: event.mode,
        role: event.role,
      };
    case "prompt_dispatch_accepted":
      return {
        ...base(event.event, "bridge.control", "info", now),
        sessionId: event.sessionId,
        mode: event.mode,
        route: event.route,
        execution: event.execution,
      };
    case "model_execution_started":
      return {
        ...base(event.event, "bridge.model", "info", now),
        sessionId: event.sessionId,
      };
    case "bridge_operation_failed":
      return {
        ...base(event.event, "bridge", "error", now),
        ...(event.sessionId === undefined
          ? {}
          : { sessionId: event.sessionId }),
        code: event.code,
      };
  }
}

export function formatBridgeDiagnostic(
  event: BridgeDiagnostic,
  now = new Date(),
): string {
  return JSON.stringify(record(event, now));
}

export function bridgeLoggerDiagnostic(
  logger: BridgeLogger,
): BridgeDiagnosticSink {
  return (event) => {
    try {
      const diagnostic = record(event);
      const level = diagnostic.level;
      const context = Object.fromEntries(
        Object.entries(diagnostic).filter(([key]) => key !== "level"),
      );
      if (level === "error") logger.error("omp-remote bridge", context);
      else if (level === "warn") logger.warn("omp-remote bridge", context);
      else logger.info("omp-remote bridge", context);
    } catch {
      // Extension diagnostics must never disturb the OMP session.
    }
  };
}
