/// <reference lib="dom" />
import { element } from "./dom";

/** How long a toast stays up. */
const TOAST_MS = 4_000;

/**
 * A short line over every screen, in one polite live region on the body:
 * what just happened. It fades on its own, and a newer line replaces it.
 */
export class Toast {
  readonly node = element("div", "app-toast");
  #timer = 0;

  constructor(host: HTMLElement = document.body) {
    this.node.setAttribute("role", "status");
    host.append(this.node);
  }

  show(text: string): void {
    window.clearTimeout(this.#timer);
    this.node.replaceChildren(element("span", "app-toast-text", text));
    this.node.classList.add("show");
    this.#timer = window.setTimeout(() => this.hide(), TOAST_MS);
  }

  hide(): void {
    window.clearTimeout(this.#timer);
    this.node.classList.remove("show");
    this.node.replaceChildren();
  }
}
