/// <reference lib="dom" />
import {
  CONNECTION_STATUS_TEXT,
  type ConnectionStatus,
} from "../core/connection-state";
import { element, setText } from "./dom";

/**
 * A dot and a label for the relay link, always on screen: green when
 * connected, pulsing while it dials, grey without a network. It is always in
 * place, so a drop moves nothing. While the link is down it is a
 * button that redials at once. Hidden when there is no relay (local dev).
 */
export class ConnectionStatusView {
  readonly node = element("button", "connection-status");
  readonly #label = element("span", "connection-status-label");

  constructor(onRetry: () => void) {
    this.node.type = "button";
    this.node.hidden = true;
    this.node.append(element("span", "connection-status-dot"), this.#label);
    this.node.addEventListener("click", () => {
      if (!this.node.disabled) onRetry();
    });
  }

  update(status: ConnectionStatus | undefined): void {
    this.node.hidden = status === undefined;
    if (status === undefined) return;
    const text = CONNECTION_STATUS_TEXT[status];
    const connected = status === "connected";
    this.node.dataset.state = status;
    this.node.disabled = connected;
    this.node.title = connected
      ? `Relay: ${text}`
      : `Relay: ${text} Tap to retry now.`;
    setText(this.#label, text);
  }
}
