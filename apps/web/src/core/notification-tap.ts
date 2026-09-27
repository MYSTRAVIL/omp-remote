import type { MachineNode } from "./session-tree";
import { NotificationTarget } from "./sw-push";

/**
 * What a tapped notification does now: `open` its session; `ended`, stay on
 * the list and say so, since its machine's current list no longer has it;
 * `offline`, stay on the list, since its machine is off the relay (or, with
 * live data in, never listed); `wait` while its machine's list is in doubt
 * (still connecting, or syncing), deciding again when it lands.
 */
export type TapOutcome = "open" | "ended" | "offline" | "wait";

/**
 * Decide a tapped notification against the session tree as the store shows
 * it. A list in doubt never opens or ends anything: the tree may hold the
 * device's cached rows, or rows the relay link may have missed changes to.
 */
export function decideTap(
  target: NotificationTarget,
  tree: readonly MachineNode[],
  connecting: boolean,
): TapOutcome {
  const machine = tree.find((node) => node.machineId === target.machineId);
  if (machine === undefined) return connecting ? "wait" : "offline";
  if (machine.offline === true) return "offline";
  if (machine.syncing === true) return "wait";
  const listed = machine.projects.some((project) =>
    project.sessions.some((session) => session.id === target.sessionId),
  );
  return listed ? "open" : "ended";
}

/** `sessionStorage` key: the session this window opens once its list is current. */
export const PENDING_OPEN_KEY = "omp-remote.pending-open";

/** The slice of `Storage` the waiting session is kept in; production passes `sessionStorage`. */
export interface PendingOpenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface NotificationTapDeps {
  /** Keeps the waiting session across a reload of this window. */
  storage: PendingOpenStorage;
  /** The machines paired here; a tap for any other is ignored. */
  pairedMachineIds(): readonly string[];
  /** Signed in with a client running; until then a tap waits, for sign-in too. */
  ready(): boolean;
  /** The session tree as the store shows it. */
  tree(): readonly MachineNode[];
  /** True until this load's first live data. */
  connecting(): boolean;
  /** The page is off screen: a tap is bringing a backgrounded app forward. */
  hidden(): boolean;
  /** Check the relay link; every list shows in doubt until it answers. */
  probe(): void;
  /** Open a session, as a tap in the session list does. */
  open(sessionId: string): void;
  /** Show the session list. */
  back(): void;
  /** Say the tapped session has ended. */
  ended(): void;
}

/**
 * The session a tapped notification asks this window to open, held until its
 * machine's list is current (see `decideTap`). It is kept in `sessionStorage`
 * too: the window a tap opens navigates, the browser checks for a new service
 * worker on every navigation, and after a deploy the new one takes over and
 * the page reloads into it, most often before the list has landed. The
 * session open when that reload runs is carried the same way.
 */
export class NotificationTaps {
  readonly #deps: NotificationTapDeps;
  #target: NotificationTarget | undefined;

  constructor(deps: NotificationTapDeps) {
    this.#deps = deps;
    this.#target = readPendingOpen(deps.storage);
  }

  /**
   * A notification was tapped, or a window opened on one. With the app
   * running, the list shows while the tap waits, and when the session ended
   * or its machine is offline. A tap that brings a backgrounded app forward
   * checks the relay link first: the page may have been frozen while its
   * link died, and the list it last saw would call a session started since
   * then ended.
   */
  tapped(target: NotificationTarget): void {
    if (!this.#deps.pairedMachineIds().includes(target.machineId)) return;
    this.#keep(target);
    if (!this.#deps.ready()) return;
    if (this.#deps.hidden()) this.#deps.probe();
    if (this.settle() !== "open") this.#deps.back();
  }

  /**
   * Decide the waiting tap once its machine's list is current: open its
   * session, or stay on the list, saying so when the session ended. What it
   * decided; undefined when there is nothing to decide yet.
   */
  settle(): TapOutcome | undefined {
    const target = this.#target;
    if (target === undefined || !this.#deps.ready()) return undefined;
    const outcome = decideTap(
      target,
      this.#deps.tree(),
      this.#deps.connecting(),
    );
    if (outcome === "wait") return outcome;
    this.#keep(undefined);
    if (outcome === "open") this.#deps.open(target.sessionId);
    else if (outcome === "ended") this.#deps.ended();
    return outcome;
  }

  /** The user opened a session: a tap still waiting is dropped. */
  drop(): void {
    this.#keep(undefined);
  }

  /**
   * This window is about to reload into a new deploy: the session open now
   * opens again once the new build's list is current. A tap still waiting
   * is kept already, and wins.
   */
  carry(open: NotificationTarget | undefined): void {
    if (this.#target === undefined && open !== undefined) this.#keep(open);
  }

  #keep(target: NotificationTarget | undefined): void {
    this.#target = target;
    try {
      if (target === undefined) this.#deps.storage.removeItem(PENDING_OPEN_KEY);
      else this.#deps.storage.setItem(PENDING_OPEN_KEY, JSON.stringify(target));
    } catch {
      // Denied storage: the tap still opens in this load; a reload loses it.
    }
  }
}

/** The waiting session this window kept; none when absent or unreadable. */
function readPendingOpen(
  storage: PendingOpenStorage,
): NotificationTarget | undefined {
  try {
    const raw = storage.getItem(PENDING_OPEN_KEY);
    if (raw === null) return undefined;
    const parsed = NotificationTarget.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
