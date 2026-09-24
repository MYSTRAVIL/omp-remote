import type { RelayState } from "./client";

export interface ConnectionInput {
  /** The client's link to the relay now. */
  readonly relay: RelayState;
  /** This client has been connected to the relay at least once. */
  readonly connectedOnce: boolean;
  /** The device reports a network connection (`navigator.onLine`). */
  readonly networkOnline: boolean;
}

/** The always-on connection dot: the relay link now, as the user sees it. */
export type ConnectionStatus =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "offline";

/** What the dot's label says for each status. */
export const CONNECTION_STATUS_TEXT: Record<ConnectionStatus, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

/**
 * The dot's status. A device without a network is offline whatever the link
 * last did; otherwise a down link is connecting before this sign-in's first
 * connect and reconnecting after it.
 */
export function connectionStatus(input: ConnectionInput): ConnectionStatus {
  if (input.relay === "connected") return "connected";
  if (!input.networkOnline) return "offline";
  return input.connectedOnce ? "reconnecting" : "connecting";
}

/** The machine a session runs on, as the session tree shows it. */
export interface SessionMachine {
  /** Its display name. */
  readonly label: string;
  /** The relay's live machine list no longer carries it. */
  readonly offline: boolean;
}

export interface SendContext {
  /** The session's machine; undefined when the tree does not list it. */
  readonly machine: SessionMachine | undefined;
}

/** Whether the composer may send its draft now, and what it says when not. */
export type SendDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly notice: string };

const ALLOWED: SendDecision = { allowed: true };

/**
 * Whether a draft may go to its session's machine now. A machine the relay
 * lists as offline would never receive it (the relay drops an envelope for a
 * machine with no live agent), so the draft stays in the composer beside a
 * notice. The relay link never blocks: while it is down, frames wait in the
 * client's queue and go out in order once it reconnects.
 */
export function decideSend({ machine }: SendContext): SendDecision {
  if (machine?.offline !== true) return ALLOWED;
  return {
    allowed: false,
    notice: `${machine.label} is offline. Messages can't be sent until it reconnects.`,
  };
}
