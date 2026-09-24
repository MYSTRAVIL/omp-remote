import type { NoticeReason } from "@omp-remote/protocol";
import type { SecretAclFailure } from "@omp-remote/protocol/ipc";

export type ControlAction =
  | "prompt"
  | "interrupt"
  | "interactionReply"
  | "serviceTier"
  | "setModel"
  | "setThinkingLevel"
  | "compact"
  | "closeSession"
  | "resourceInit"
  | "resourceChunk"
  | "resourceAbort";
export type ControlRoute =
  | "ipc-prompt-control"
  | "ipc-feed"
  | "collab"
  | "none";

/**
 * Why a client line was dropped. `invalid-json` / `invalid-frame`: a line the
 * host could not parse, or a frame no phone may send. The rest are why the
 * uplink's sealed channel dropped a line: not an envelope (`malformed`), failed
 * authentication (`auth-failed`), seen before (`replayed`), bound to an epoch
 * of this host that is gone (`stale-epoch`), or from a phone it has no
 * handshake with (`unknown-peer`). Codes only: never plaintext or epochs.
 */
const CLIENT_FRAME_REJECT_CODES = [
  "invalid-json",
  "invalid-frame",
  "malformed",
  "auth-failed",
  "replayed",
  "stale-epoch",
  "unknown-peer",
] as const;
export type ClientFrameRejectCode = (typeof CLIENT_FRAME_REJECT_CODES)[number];

/** Why the host-agent could not start; `startAgent` logs it and throws. */
export type AgentStartFailure =
  | "configuration-invalid"
  | "secret-unavailable"
  | "service-start-failed"
  | "uplink-start-failed"
  /** Another process already owns the IPC endpoint (squatter or a second
   *  agent); running without it would leave bridges unattached. */
  | "ipc-endpoint-in-use";

export type AgentDiagnostic =
  | { event: "agent_listening"; devClientPort?: number }
  | { event: "agent_start_failed"; code: AgentStartFailure }
  /** A per-install secret file could not be made owner-only (Windows ACL). */
  | { event: "secret_acl_failed"; code: SecretAclFailure }
  | {
      event: "ipc_session_connected" | "ipc_session_disconnected";
      sessionId: string;
      role: "feed" | "prompt-control";
    }
  | {
      event: "ipc_session_rejected";
      /** `authentication-failed`: wrong token (handshake proof or plain hello);
       *  `handshake-invalid`: a malformed handshake. */
      code: "authentication-failed" | "handshake-invalid";
    }
  | { event: "client_connected" | "client_disconnected" }
  | { event: "client_frame_rejected"; code: ClientFrameRejectCode }
  | {
      /**
       * Rejections on one uplink connection past the first of each code, which
       * alone is reported as `client_frame_rejected`: a relay can send any
       * number of bad lines, so the rest are counted per code and reported
       * once, when the connection closes.
       */
      event: "client_frame_rejections_suppressed";
      suppressedCount: Partial<Record<ClientFrameRejectCode, number>>;
    }
  | {
      event: "collab_session_registered" | "collab_session_deregistered";
      sessionId: string;
    }
  | {
      event: "control_outcome";
      action: ControlAction;
      sessionId: string;
      mode?: "steer" | "followUp" | "aside";
      route: ControlRoute;
      outcome: "forwarded" | "rejected";
      execution: "unconfirmed";
      code?:
        | "prompt-control-unavailable"
        | "close-unsupported"
        | "session-not-found";
    }
  | {
      event: "session_spawned";
      machineId: string;
      outcome: "launched" | "failed";
      code?: string;
    }
  | { event: "uplink_started" | "uplink_stopped"; machineId: string }
  | {
      event: "uplink_connected";
      machineId: string;
      reconnected: boolean;
    }
  | {
      event: "uplink_reconnect_scheduled";
      machineId: string;
      retryDelayMs: number;
      code: "transport-closed";
    }
  | {
      /** The connected backlog passed `MAX_CONNECTED_BACKLOG`: the uplink closed
       *  the socket so the reconnect replays full state instead of trimming. */
      event: "uplink_backlog_overflow";
      machineId: string;
      backlog: number;
    }
  | {
      /** Transient frames the bounded queue evicted while the link was down,
       *  reported once on the next open. */
      event: "uplink_frames_dropped";
      machineId: string;
      dropped: number;
    }
  /** `agent-token-not-found`: the machine has not joined (no `agent-token`);
   *  `pairing-not-found`: no paired phone to bridge to. */
  | {
      event: "uplink_not_started";
      code: "agent-token-not-found" | "pairing-not-found";
    }
  | { event: "collab_discovery_started" | "collab_discovery_stopped" }
  | {
      event: "collab_discovery_failed";
      code: "list-failed" | "refresh-failed";
    }
  | { event: "collab_discovery_recovered"; suppressedCount: number }
  | {
      event: "collab_attach_failed";
      sessionId: string;
      code: "attach-failed";
    }
  | {
      event: "collab_session_opened";
      sessionId: string;
    }
  | {
      event: "collab_session_closed";
      sessionId: string;
      code: "transport-closed" | "decrypt-failed" | "controller-stopped";
    }
  | {
      event: "collab_session_detached";
      sessionId: string;
      code: "not-discovered";
    }
  | {
      event: "collab_not_started";
      code: "unsupported-omp" | "setup-failed";
    }
  | { event: "log_rotation_failed"; code: "io-failed" }
  | {
      /** A session needs the user, who has been away from this machine long
       *  enough (or whose presence is unknown): the aggregator was asked to
       *  push its sealed notice. */
      event: "notify_push_sent";
      sessionId: string;
      reason: NoticeReason;
    }
  | {
      /** A session needs the user, who is at this machine: the push waits
       *  until they have been away `awaySec`, and is dropped if the need is
       *  answered first. Reported once per need. */
      event: "notify_push_deferred";
      sessionId: string;
      reason: NoticeReason;
      code: "user-present";
      awaySec: number;
    }
  | {
      /** The need a pushed notice showed was answered, or its session ended:
       *  the aggregator was asked to push the phone a clear for it. */
      event: "notify_push_cleared";
      sessionId: string;
    }
  | {
      /** A notice could not be sealed, or was too long to send even cut down. */
      event: "notify_push_failed";
      sessionId: string;
      code: "seal-failed" | "too-large";
    }
  /** The phone changed how long the user must be away before a push. */
  | { event: "notify_policy_set"; awaySec: number }
  /** The persisted notify policy could not be read (the default applies) or
   *  saved (it applies until the agent restarts). */
  | { event: "notify_policy_failed"; code: "load-failed" | "save-failed" };

export type AgentDiagnosticSink = (event: AgentDiagnostic) => void;

export const noAgentDiagnostic: AgentDiagnosticSink = () => {};

type DiagnosticLevel = "info" | "warn";
type DiagnosticComponent =
  | "host"
  | "host.ipc"
  | "host.client"
  | "host.control"
  | "host.uplink"
  | "host.collab"
  | "host.log"
  | "host.notify";

function base(
  event: AgentDiagnostic["event"],
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

function levelOf(event: AgentDiagnostic): DiagnosticLevel {
  switch (event.event) {
    case "agent_start_failed":
    case "secret_acl_failed":
    case "ipc_session_rejected":
    case "client_frame_rejected":
    case "client_frame_rejections_suppressed":
    case "uplink_reconnect_scheduled":
    case "uplink_backlog_overflow":
    case "uplink_frames_dropped":
    case "uplink_not_started":
    case "collab_discovery_failed":
    case "collab_attach_failed":
    case "collab_not_started":
    case "log_rotation_failed":
    case "notify_push_failed":
    case "notify_policy_failed":
      return "warn";
    case "control_outcome":
      return event.outcome === "rejected" ? "warn" : "info";
    case "session_spawned":
      return event.outcome === "failed" ? "warn" : "info";
    default:
      return "info";
  }
}

export function formatAgentDiagnostic(
  event: AgentDiagnostic,
  now = new Date(),
): string {
  const level = levelOf(event);
  switch (event.event) {
    case "agent_listening":
      return JSON.stringify({
        ...base(event.event, "host", level, now),
        ...(event.devClientPort === undefined
          ? {}
          : { devClientPort: event.devClientPort }),
      });
    case "agent_start_failed":
    case "secret_acl_failed":
      return JSON.stringify({
        ...base(event.event, "host", level, now),
        code: event.code,
      });
    case "ipc_session_connected":
    case "ipc_session_disconnected":
      return JSON.stringify({
        ...base(event.event, "host.ipc", level, now),
        sessionId: event.sessionId,
        role: event.role,
      });
    case "ipc_session_rejected":
      return JSON.stringify({
        ...base(event.event, "host.ipc", level, now),
        code: event.code,
      });
    case "client_connected":
    case "client_disconnected":
      return JSON.stringify(base(event.event, "host.client", level, now));
    case "client_frame_rejected":
      return JSON.stringify({
        ...base(event.event, "host.client", level, now),
        code: event.code,
      });
    case "client_frame_rejections_suppressed": {
      // Known codes only, so the line carries counts and nothing else.
      const suppressedCount: Partial<Record<ClientFrameRejectCode, number>> =
        {};
      for (const code of CLIENT_FRAME_REJECT_CODES) {
        const count = event.suppressedCount[code];
        if (count !== undefined) suppressedCount[code] = count;
      }
      return JSON.stringify({
        ...base(event.event, "host.client", level, now),
        suppressedCount,
      });
    }
    case "collab_session_registered":
    case "collab_session_deregistered":
      return JSON.stringify({
        ...base(event.event, "host.collab", level, now),
        sessionId: event.sessionId,
      });
    case "control_outcome": {
      const record = {
        ...base(event.event, "host.control", level, now),
        action: event.action,
        sessionId: event.sessionId,
        ...(event.mode === undefined ? {} : { mode: event.mode }),
        route: event.route,
        outcome: event.outcome,
        execution: event.execution,
        ...(event.code === undefined ? {} : { code: event.code }),
      };
      return JSON.stringify(record);
    }
    case "session_spawned": {
      const record = {
        ...base(event.event, "host.control", level, now),
        machineId: event.machineId,
        outcome: event.outcome,
        ...(event.code === undefined ? {} : { code: event.code }),
      };
      return JSON.stringify(record);
    }
    case "uplink_started":
    case "uplink_stopped":
      return JSON.stringify({
        ...base(event.event, "host.uplink", level, now),
        machineId: event.machineId,
      });
    case "uplink_connected":
      return JSON.stringify({
        ...base(event.event, "host.uplink", level, now),
        machineId: event.machineId,
        reconnected: event.reconnected,
      });
    case "uplink_reconnect_scheduled":
      return JSON.stringify({
        ...base(event.event, "host.uplink", level, now),
        machineId: event.machineId,
        retryDelayMs: event.retryDelayMs,
        code: event.code,
      });
    case "uplink_backlog_overflow":
      return JSON.stringify({
        ...base(event.event, "host.uplink", level, now),
        machineId: event.machineId,
        backlog: event.backlog,
      });
    case "uplink_frames_dropped":
      return JSON.stringify({
        ...base(event.event, "host.uplink", level, now),
        machineId: event.machineId,
        dropped: event.dropped,
      });
    case "uplink_not_started":
      return JSON.stringify({
        ...base(event.event, "host.uplink", level, now),
        code: event.code,
      });
    case "collab_discovery_started":
    case "collab_discovery_stopped":
      return JSON.stringify(base(event.event, "host.collab", level, now));
    case "collab_discovery_failed":
      return JSON.stringify({
        ...base(event.event, "host.collab", level, now),
        code: event.code,
      });
    case "collab_discovery_recovered":
      return JSON.stringify({
        ...base(event.event, "host.collab", level, now),
        suppressedCount: event.suppressedCount,
      });
    case "collab_attach_failed":
      return JSON.stringify({
        ...base(event.event, "host.collab", level, now),
        sessionId: event.sessionId,
        code: event.code,
      });
    case "collab_session_opened":
      return JSON.stringify({
        ...base(event.event, "host.collab", level, now),
        sessionId: event.sessionId,
      });
    case "collab_session_closed":
    case "collab_session_detached":
      return JSON.stringify({
        ...base(event.event, "host.collab", level, now),
        sessionId: event.sessionId,
        code: event.code,
      });
    case "collab_not_started":
      return JSON.stringify({
        ...base(event.event, "host.collab", level, now),
        code: event.code,
      });
    case "log_rotation_failed":
      return JSON.stringify({
        ...base(event.event, "host.log", level, now),
        code: event.code,
      });
    case "notify_push_sent":
      return JSON.stringify({
        ...base(event.event, "host.notify", level, now),
        sessionId: event.sessionId,
        reason: event.reason,
      });
    case "notify_push_deferred":
      return JSON.stringify({
        ...base(event.event, "host.notify", level, now),
        sessionId: event.sessionId,
        reason: event.reason,
        code: event.code,
        awaySec: event.awaySec,
      });
    case "notify_push_cleared":
      return JSON.stringify({
        ...base(event.event, "host.notify", level, now),
        sessionId: event.sessionId,
      });
    case "notify_push_failed":
      return JSON.stringify({
        ...base(event.event, "host.notify", level, now),
        sessionId: event.sessionId,
        code: event.code,
      });
    case "notify_policy_set":
      return JSON.stringify({
        ...base(event.event, "host.notify", level, now),
        awaySec: event.awaySec,
      });
    case "notify_policy_failed":
      return JSON.stringify({
        ...base(event.event, "host.notify", level, now),
        code: event.code,
      });
  }
}

export const consoleAgentDiagnostic: AgentDiagnosticSink = (event) => {
  try {
    const line = formatAgentDiagnostic(event);
    if (levelOf(event) === "warn") console.error(line);
    else console.log(line);
  } catch {
    // Operational diagnostics must never affect host availability.
  }
};
