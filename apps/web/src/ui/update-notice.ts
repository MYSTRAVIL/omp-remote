/// <reference lib="dom" />
import {
  type HistoryStorage,
  type MarkerStorage,
  type UpdateAction,
  markUpdateReload,
  recordUpdate,
  takeUpdateReload,
} from "../core/update-policy";
import { button, element } from "./dom";

/** How long "Updated to …" stays up; the Reload offer stays until tapped. */
const TOAST_MS = 4_000;

export interface UpdateNoticeDeps {
  /** Holds the one-shot reload marker; production passes `sessionStorage`. */
  storage: MarkerStorage;
  /**
   * Keeps the builds this browser updated to, for Settings > About;
   * production passes `localStorage`.
   */
  history: HistoryStorage;
  /** Production passes `location.reload`. */
  reload: () => void;
  /** When an update lands (epoch ms); defaults to `Date.now`. */
  now?: () => number;
  /** Where the notice mounts; the body, so it shows over every screen. */
  host?: HTMLElement;
}

/**
 * The app-update line: one polite live region mounted on the body, so it
 * shows over the login, the session list and a session alike. After an update
 * reload it says which build is running, then fades, and adds that build to
 * the history Settings > About lists. When reloading would lose a draft it
 * offers "Update ready · Reload" and stays until tapped.
 */
export class UpdateNotice {
  readonly node = element("div", "update-notice");
  readonly #storage: MarkerStorage;
  readonly #history: HistoryStorage;
  readonly #reload: () => void;
  readonly #now: () => number;
  #timer = 0;

  constructor(deps: UpdateNoticeDeps) {
    this.#storage = deps.storage;
    this.#history = deps.history;
    this.#reload = deps.reload;
    this.#now = deps.now ?? Date.now;
    this.node.setAttribute("role", "status");
    (deps.host ?? document.body).append(this.node);
  }

  /** On load: if this load follows an update reload, say so once and record it. */
  announce(buildId: string): void {
    if (!takeUpdateReload(this.#storage)) return;
    recordUpdate(this.#history, buildId, this.#now());
    this.node.classList.remove("is-offer");
    this.node.replaceChildren(
      element("span", "update-notice-text", `Updated to ${buildId}`),
    );
    this.node.classList.add("show");
    window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => {
      this.node.classList.remove("show");
      this.node.replaceChildren();
    }, TOAST_MS);
  }

  /** A new build took control of the page: reload now, or offer to. */
  apply(action: UpdateAction): void {
    if (action === "reload") {
      this.reloadNow();
      return;
    }
    window.clearTimeout(this.#timer);
    const reload = button("Reload", "update-notice-reload");
    reload.addEventListener("click", () => this.reloadNow());
    this.node.replaceChildren(
      element("span", "update-notice-text", "Update ready"),
      reload,
    );
    this.node.classList.add("show", "is-offer");
  }

  /** Reload into the new build, leaving the marker the next load announces. */
  reloadNow(): void {
    markUpdateReload(this.#storage);
    this.#reload();
  }
}
