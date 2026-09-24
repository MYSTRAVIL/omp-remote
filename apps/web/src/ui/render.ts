/// <reference lib="dom" />
import type {
  ApprovalMode,
  InteractionFrame,
  InteractionResponse,
  SessionMeta,
  SpawnThinkingLevel,
} from "@omp-remote/protocol";
import type { OrbState } from "thinking-orbs/engine";
import type { AppearancePreferences } from "../core/appearance-preferences";
import type {
  FreshCheck,
  Passkey,
  PasswordLoginResult,
  RelayMachine,
  SessionMethod,
  SignInMethods,
} from "../core/auth";
import { ChatPreferences } from "../core/chat-preferences";
import type { RelayState } from "../core/client";
import { ComposerPreferences } from "../core/composer-preferences";
import type { ConnectionStatus } from "../core/connection-state";
import type { OverlayEntry } from "../core/history-nav";
import type { PushEnrolment } from "../core/push-subscribe";
import type { MachineNode } from "../core/session-tree";
import type { SignInPreferences } from "../core/sign-in-preferences";
import type { PendingSpawn } from "../core/store";
import type { SessionCatalog } from "../core/store";
import type { TranscriptState } from "../core/transcript";
import type { UpdateRecord } from "../core/update-policy";
import { ConnectionStatusView } from "./connection-status";
import { SessionView } from "./conversation";
import { WorkspaceDialogs } from "./dialogs";
import {
  brand,
  brandMark,
  button,
  element,
  field,
  icon,
  setText,
  syncChildren,
  uniqueId,
} from "./dom";
import { OrbView, type SessionPulse } from "./orb";

export interface TreeHandlers {
  onSelect(sessionId: string): void;
  onBack(): void;
  /** An overlay opened: back now runs `close`; see `SessionHistory.overlay`. */
  onOverlay(close: () => void): OverlayEntry;
}

/**
 * This device's account on the relay, bound to its sign-in, for Settings >
 * Account. Each change asks for a fresh check first: a passkey prompt after a
 * passkey sign-in, the password after a password sign-in. Each rejects with an
 * `AccountError` when the relay refuses or the passkey check never finishes,
 * else as the network failed.
 */
export interface AccountControls {
  /** How this device signed in, which picks the fresh check a change asks for. */
  readonly method: SessionMethod;
  /** This browser can use passkeys here: an HTTPS page with WebAuthn. */
  readonly passkeyAvailable: boolean;
  /** Which sign-ins the relay offers now. */
  methods(): Promise<SignInMethods>;
  /** Every passkey that can sign in, oldest first. */
  passkeys(): Promise<readonly Passkey[]>;
  /** Revoke one; `signedOut` when it was the passkey this device signed in with. */
  revokePasskey(
    credentialId: string,
    check: FreshCheck,
  ): Promise<{ signedOut: boolean }>;
  /** Add a passkey made on this device; `verified` once the relay stored it. */
  addPasskey(check: FreshCheck): Promise<{ verified: boolean }>;
  /** Every machine the relay lets connect. */
  machines(): Promise<readonly RelayMachine[]>;
  /** Stop a machine connecting; it has to join again to come back. */
  revokeMachine(machineId: string, check: FreshCheck): Promise<void>;
  /** Turn password sign-in on or off; resolves to the relay's setting now. */
  setPasswordSignIn(enabled: boolean, check: FreshCheck): Promise<boolean>;
  /** End every sign-in on every device, this one included. */
  signOutEverywhere(check: FreshCheck): Promise<void>;
}

/** Main captures control targets synchronously and routes mutations through fresh UV. */
export interface ControlHandlers extends TreeHandlers {
  onPrompt(
    text: string,
    mode: "steer" | "followUp" | "aside",
    attachments?: string[],
  ): Promise<boolean>;
  onInterrupt(): Promise<boolean>;
  onServiceTier(sessionId: string, enabled: boolean): Promise<boolean>;
  onSetModel(sessionId: string, model: string): Promise<boolean>;
  onSetThinkingLevel(sessionId: string, level: string): Promise<boolean>;
  onCompact(sessionId: string, instructions?: string): Promise<boolean>;
  /** End the session (`closeSession`): the host stops omp, a running turn
   *  included. A host that cannot answers with a `controlError`. */
  onCloseSession(sessionId: string): Promise<boolean>;
  /** Upload an image attachment for a session; resolves the host resource id to
   *  reference in a prompt, rejects on a transfer error. */
  onUpload(
    sessionId: string,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<string>;
  /**
   * Ask the host for a deferred image's bytes (`mediaFetch`): a read like
   * `sync`, so no passkey check. Each announcement is asked for once; repeat
   * calls send nothing. Undefined where no host can answer (the dev previews).
   */
  onMediaFetch?(sessionId: string, mediaId: string): void;
  onSpawn(
    machineId: string,
    opts: {
      cwd: string;
      model?: string;
      thinkingLevel?: SpawnThinkingLevel;
      approvalMode: ApprovalMode;
    },
  ): Promise<boolean>;
  onInteractionReply(
    sessionId: string,
    id: string,
    response: InteractionResponse,
  ): Promise<boolean>;
  /** Dismiss the pending-spawn screen (cancel while waiting, or after failure). */
  onCancelSpawn(): void;
  onPair?(code: string): Promise<void>;
  /**
   * Clear a remembered device and return to the login screen, which shows
   * `notice` when given.
   */
  onSignOut?(notice?: string): void;
  /**
   * Name a machine on this device only (a blank name restores its default);
   * the tree shows it everywhere. False when browser storage is unavailable,
   * so the name lasts only until the page reloads.
   */
  onRenameMachine(machineId: string, label: string): boolean;
  /**
   * Remove a machine's pairing from this browser and reconnect without it. The
   * host keeps running and can be paired again; nothing is revoked host-side.
   * Rejects only when the pairing could not be removed; resolves false when it
   * was removed but reconnecting to the remaining machines failed.
   */
  onForgetMachine?(machineId: string): Promise<boolean>;
  /**
   * Every machine paired in this browser, online or not, by machineId, with
   * its display name. Settings lists offline ones so they can still be renamed
   * or forgotten. Undefined when there is no pairing store (local dev).
   */
  pairedMachines?(): ReadonlyMap<string, string>;
  /**
   * When this browser last saw a machine online (epoch ms), or undefined when
   * it never has. Settings shows it for machines that are not online now.
   */
  machineLastSeen?(machineId: string): number | undefined;
  /**
   * How long the user must be away from each machine (no keyboard or mouse
   * input) before it pushes a notification, in seconds; `0` pushes always.
   * Setting one saves it on this device and tells the machine at once when it
   * is connected; false when browser storage is unavailable, so the choice
   * lasts only until the page reloads. Undefined in local dev, which gets no
   * pushes.
   */
  notifyAway?: {
    awaySec(machineId: string): number;
    setAwaySec(machineId: string, awaySec: number): boolean;
  };
  /**
   * This device's Web Push registration and push choices, for Settings >
   * Notifications. Undefined in local dev, which has no service worker.
   */
  push?: PushEnrolment;
  /**
   * This bundle's build id (its short commit, stamped at build time) and the
   * builds this browser updated to, newest first, for Settings > About.
   */
  build?: { readonly id: string; updates(): readonly UpdateRecord[] };
  /**
   * The link to the relay right now, for Settings > About. Undefined in local
   * dev, which talks to the host-agent directly.
   */
  relayState?(): RelayState;
  /**
   * The relay link for the always-on connection dot (see `connectionStatus`).
   * Undefined in local dev, which has no relay.
   */
  connectionStatus?(): ConnectionStatus;
  /** Redial the relay at once: the connection dot, tapped while it is down. */
  onRetryConnection?(): void;
  /** Applied to the document since boot; Settings > Appearance edits it. */
  appearance?: AppearancePreferences;
  /**
   * Passkeys and sign-in on the relay, for Settings > Account. Undefined in
   * local dev, which has no sign-in.
   */
  account?: AccountControls;
  /** "Keep me signed in" on this device, for Settings > Account; as `account`. */
  signIn?: SignInPreferences;
}

interface SessionRow {
  node: HTMLButtonElement;
  title: HTMLElement;
  model: HTMLElement;
  status: HTMLElement;
  orb: OrbView;
}

interface ProjectGroup {
  node: HTMLElement;
  title: HTMLElement;
  list: HTMLElement;
}

interface MachineGroup {
  node: HTMLElement;
  title: HTMLElement;
  count: HTMLElement;
  /** "Updating…" beside the count while rows come from the cached last list. */
  updating: HTMLElement;
  /** "Offline" beside the count while the relay no longer lists the machine. */
  offline: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  projects: Map<string, ProjectGroup>;
}

/** Hidden per-state text so a resting row still announces its pulse to AT. */
const PULSE_LABEL: Record<SessionPulse, string> = {
  done: "Finished",
  question: "Needs your answer",
  error: "Error",
};

/** Persistent navigation controls: stream redraws never replace focused rows. */
class SessionNavigation {
  readonly node = element("nav", "tree");
  readonly #machines = new Map<string, MachineGroup>();
  readonly #sessions = new Map<string, SessionRow>();
  readonly #empty = element("div", "tree-empty");
  readonly #connecting = element("div", "tree-empty tree-connecting");
  #handlers: ControlHandlers;

  constructor(handlers: ControlHandlers, openSettings: () => void) {
    this.#handlers = handlers;
    this.node.setAttribute("aria-label", "Machines, projects, and sessions");
    const mark = element("div", "empty-mark");
    mark.append(icon("machine"));
    const pair = button(
      "Pair a machine",
      "button secondary empty-pair",
      "plus",
    );
    pair.addEventListener("click", openSettings);
    this.#empty.append(
      mark,
      element("h2", "empty-title", "Your machines belong here."),
      element(
        "p",
        "empty-copy",
        "Pair a machine to bring its sessions into your workspace. Already paired? Its snapshot will appear here when received.",
      ),
      pair,
    );
    const connectingMark = element("div", "empty-mark connecting-mark");
    connectingMark.append(icon("machine"));
    this.#connecting.setAttribute("role", "status");
    this.#connecting.append(
      connectingMark,
      element("h2", "empty-title", "Connecting to your machines…"),
      element(
        "p",
        "empty-copy",
        "Your sessions appear here as soon as your paired machines report in.",
      ),
    );
  }

  update(
    tree: MachineNode[],
    handlers: ControlHandlers,
    sessionPulse: (sessionId: string) => SessionPulse | null,
    orbState: (sessionId: string) => OrbState | null,
    connecting: boolean,
    selectedId?: string,
  ): void {
    this.#handlers = handlers;
    const machineIds = new Set<string>();
    const sessionIds = new Set<string>();
    const nodes: HTMLElement[] = [];
    for (const machine of tree) {
      machineIds.add(machine.machineId);
      let group = this.#machines.get(machine.machineId);
      if (!group) {
        const node = element("section", "machine-group");
        const header = element("div", "machine-heading");
        const title = element("h2", "machine");
        const count = element("span", "machine-count meta");
        const updating = element("span", "machine-updating meta", "Updating…");
        updating.title =
          "Showing this machine's last known list until it reports in.";
        updating.hidden = true;
        const offline = element("span", "machine-offline meta", "Offline");
        offline.title =
          "Not connected to the relay. Its last known sessions stay listed until it reconnects.";
        offline.hidden = true;
        const list = element("div", "machine-projects");
        const empty = element(
          "p",
          "empty machine-empty",
          "No sessions reported.",
        );
        title.id = uniqueId("machine");
        node.setAttribute("aria-labelledby", title.id);
        header.append(icon("machine"), title, updating, offline, count);
        node.append(header, list);
        group = {
          node,
          title,
          count,
          updating,
          offline,
          list,
          empty,
          projects: new Map(),
        };
        this.#machines.set(machine.machineId, group);
      }
      setText(group.title, machine.label);
      const stale = machine.stale === true;
      const offline = machine.offline === true;
      // An offline machine is not about to report in, so it is not "updating".
      group.updating.hidden = !stale || offline;
      group.offline.hidden = !offline;
      if (stale) group.node.dataset.stale = "";
      else delete group.node.dataset.stale;
      if (offline) group.node.dataset.offline = "";
      else delete group.node.dataset.offline;
      const count = machine.projects.reduce(
        (total, project) => total + project.sessions.length,
        0,
      );
      setText(group.count, String(count));
      group.count.setAttribute(
        "aria-label",
        `${count} ${count === 1 ? "session" : "sessions"}`,
      );
      const projectNames = new Set<string>();
      const projects: HTMLElement[] = [];
      for (const project of machine.projects) {
        projectNames.add(project.project);
        let projectGroup = group.projects.get(project.project);
        if (!projectGroup) {
          const node = element("section", "project-group");
          const title = element("h3", "project");
          const list = element("div", "project-sessions");
          title.id = uniqueId("project");
          node.setAttribute("aria-labelledby", title.id);
          node.append(title, list);
          projectGroup = { node, title, list };
          group.projects.set(project.project, projectGroup);
        }
        setText(projectGroup.title, project.project);
        const rows: HTMLElement[] = [];
        for (const session of project.sessions) {
          sessionIds.add(session.id);
          let row = this.#sessions.get(session.id);
          if (!row) {
            const node = element("button", "session");
            node.type = "button";
            node.dataset.sessionId = session.id;
            const title = element("span", "session-row-title");
            const model = element("span", "session-row-model");
            const status = element("span", "session-status-label");
            const copy = element("span", "session-row-copy");
            copy.append(title, model);
            const orb = new OrbView({ size: 20, className: "session-row-orb" });
            node.append(copy, orb.node, status, icon("chevron"));
            const sessionId = session.id;
            node.addEventListener("click", () =>
              this.#handlers.onSelect(sessionId),
            );
            row = { node, title, model, status, orb };
            this.#sessions.set(session.id, row);
          }
          setText(row.title, session.title || "Untitled session");
          setText(row.model, session.model);
          const pulse = sessionPulse(session.id);
          if (pulse) row.node.dataset.pulse = pulse;
          else delete row.node.dataset.pulse;
          const unreachable = session.reachable === false;
          row.node.classList.toggle("is-unreachable", unreachable);
          setText(
            row.status,
            offline
              ? "Offline"
              : unreachable
                ? "Unreachable"
                : pulse
                  ? PULSE_LABEL[pulse]
                  : "",
          );
          row.node.classList.toggle("is-selected", selectedId === session.id);
          if (selectedId === session.id)
            row.node.setAttribute("aria-current", "page");
          else row.node.removeAttribute("aria-current");
          row.orb.setState(orbState(session.id));
          rows.push(row.node);
        }
        syncChildren(projectGroup.list, rows);
        projects.push(projectGroup.node);
      }
      for (const name of group.projects.keys()) {
        if (!projectNames.has(name)) group.projects.delete(name);
      }
      if (projects.length === 0) projects.push(group.empty);
      syncChildren(group.list, projects);
      nodes.push(group.node);
    }
    for (const id of this.#machines.keys()) {
      if (!machineIds.has(id)) this.#machines.delete(id);
    }
    for (const [id, row] of this.#sessions) {
      if (!sessionIds.has(id)) {
        row.orb.dispose();
        this.#sessions.delete(id);
      }
    }
    if (nodes.length === 0)
      nodes.push(connecting ? this.#connecting : this.#empty);
    syncChildren(this.node, nodes);
  }
}

class Workspace {
  readonly node = element("div", "workspace");
  readonly #content = element("main", "workspace-content");
  readonly #landing = element("section", "workspace-start");
  readonly #landingTitle = element("h1", "workspace-start-title");
  readonly #landingCopy = element("p", "workspace-start-copy");
  readonly #landingMeta = element("p", "workspace-start-meta meta");
  readonly #landingAction = button("Pair a machine", "button primary");
  readonly #pending = element("section", "workspace-start workspace-pending");
  readonly #pendingMark = element("div", "workspace-start-mark");
  readonly #pendingEyebrow = element("p", "eyebrow");
  readonly #pendingTitle = element("h1", "workspace-start-title");
  readonly #pendingCopy = element("p", "workspace-start-copy");
  readonly #pendingAction = button("Cancel", "button secondary");
  readonly #newSession = button(
    "New session",
    "button primary new-session",
    "plus",
  );
  /** The relay link at the top of the rail, always on; tapped while down, it redials. */
  readonly #connectionStatus = new ConnectionStatusView(() =>
    this.#handlers.onRetryConnection?.(),
  );
  readonly #preferences = new ComposerPreferences();
  /** One copy for Settings and every session view, so a change applies at once. */
  readonly #chat = new ChatPreferences();
  readonly #navigation: SessionNavigation;
  readonly #dialogs: WorkspaceDialogs;
  readonly #views = new Map<string, SessionView>();
  #handlers: ControlHandlers;
  #tree: MachineNode[] = [];
  #selectedId: string | undefined;
  /** No live data yet this load: an empty tree means "wait", not "pair". */
  #connecting = false;

  constructor(root: HTMLElement, handlers: ControlHandlers) {
    this.#handlers = handlers;
    this.#dialogs = new WorkspaceDialogs(
      handlers,
      this.#preferences,
      this.#chat,
    );
    this.#navigation = new SessionNavigation(handlers, () =>
      this.#dialogs.openSettings(),
    );
    const rail = element("aside", "workspace-rail");
    rail.setAttribute("aria-label", "Workspace navigation");
    const railBrand = element("div", "rail-brand");
    railBrand.append(brand(), this.#connectionStatus.node);
    const sessions = button("Sessions", "button nav-sessions", "sessions");
    sessions.addEventListener("click", () => this.#handlers.onBack());
    const heading = element("div", "rail-heading");
    heading.append(
      element("h1", "rail-title", "Sessions"),
      element("span", "eyebrow rail-section-label", "Workspace"),
    );
    const footer = element("div", "rail-footer");
    const settings = button(
      "Settings",
      "button secondary settings",
      "settings",
    );
    settings.addEventListener("click", () => this.#dialogs.openSettings());
    this.#newSession.addEventListener("click", () => {
      let selected: SessionMeta | undefined;
      let machineId: string | undefined;
      for (const machine of this.#tree) {
        for (const project of machine.projects) {
          const session = project.sessions.find(
            (item) => item.id === this.#selectedId,
          );
          if (session) {
            selected = session;
            machineId = machine.machineId;
          }
        }
      }
      this.#dialogs.openSpawn(machineId, selected);
    });
    footer.append(this.#newSession, settings);
    this.#newSession.disabled = true;
    rail.append(railBrand, sessions, heading, this.#navigation.node, footer);
    this.#content.id = uniqueId("workspace-content");
    this.#content.tabIndex = -1;
    const skip = element("a", "skip-link", "Skip to workspace");
    skip.href = `#${this.#content.id}`;
    const mark = element("div", "workspace-start-mark");
    mark.append(brandMark());
    const startCopy = element("div", "workspace-start-inner");
    startCopy.append(
      mark,
      element("p", "eyebrow", "Your remote workspace"),
      this.#landingTitle,
      this.#landingCopy,
      this.#landingAction,
      this.#landingMeta,
    );
    this.#landing.append(startCopy);
    this.#landingAction.addEventListener("click", () => {
      if (this.#tree.length > 0) this.#dialogs.openSpawn();
      else this.#dialogs.openSettings();
    });
    this.#content.append(this.#landing);
    this.#pending.setAttribute("role", "status");
    const pendingInner = element("div", "workspace-start-inner");
    pendingInner.append(
      this.#pendingMark,
      this.#pendingEyebrow,
      this.#pendingTitle,
      this.#pendingCopy,
      this.#pendingAction,
    );
    this.#pending.append(pendingInner);
    this.#pending.hidden = true;
    this.#pendingAction.addEventListener("click", () =>
      this.#handlers.onCancelSpawn(),
    );
    this.#content.append(this.#pending);
    this.node.append(
      skip,
      rail,
      this.#content,
      this.#dialogs.settings.node,
      this.#dialogs.about.node,
      this.#dialogs.spawn.node,
    );
    root.replaceChildren(this.node);
  }

  /** Show the relay link's state on the rail's dot. */
  updateConnection(handlers: ControlHandlers): void {
    this.#handlers = handlers;
    this.#connectionStatus.update(handlers.connectionStatus?.());
  }

  updateNavigation(
    tree: MachineNode[],
    handlers: ControlHandlers,
    sessionPulse: (id: string) => SessionPulse | null,
    orbState: (id: string) => OrbState | null,
    connecting: boolean,
    selectedId?: string,
  ): void {
    this.#tree = tree;
    this.#handlers = handlers;
    this.#connecting = connecting;
    this.#navigation.update(
      tree,
      handlers,
      sessionPulse,
      orbState,
      connecting,
      selectedId,
    );
    this.#dialogs.update(tree, handlers);
    this.#newSession.disabled = tree.length === 0;
    this.#newSession.title =
      tree.length === 0
        ? "Wait for a machine snapshot before starting a session."
        : "Start a session on a machine in this workspace.";
    const ids = new Set<string>();
    for (const machine of tree) {
      for (const project of machine.projects) {
        for (const session of project.sessions) ids.add(session.id);
      }
    }
    for (const [id, view] of this.#views) {
      if (!ids.has(id) && id !== selectedId) {
        view.dispose();
        this.#views.delete(id);
      }
    }
  }

  showTree(): void {
    if (this.#selectedId) this.#views.get(this.#selectedId)?.hide();
    this.#selectedId = undefined;
    this.node.classList.remove("has-session");
    this.#landing.hidden = false;
    this.#pending.hidden = true;
    const count = this.#tree.reduce(
      (total, machine) =>
        total +
        machine.projects.reduce(
          (subtotal, project) => subtotal + project.sessions.length,
          0,
        ),
      0,
    );
    const waiting = this.#tree.length === 0 && this.#connecting;
    setText(
      this.#landingTitle,
      waiting
        ? "Connecting to your machines…"
        : this.#tree.length === 0
          ? "Your workspace starts here."
          : count > 0
            ? "Pick up where you left off."
            : "Make room for your next idea.",
    );
    setText(
      this.#landingCopy,
      waiting
        ? "Your sessions appear in the sidebar as soon as your paired machines report in."
        : this.#tree.length === 0
          ? "Pair a machine to see its OMP sessions, follow the work, and answer from wherever you are."
          : count > 0
            ? "Choose a session from the sidebar to open its conversation. Your terminal and this workspace stay in step."
            : "Start a session on a listed machine, or wait for the host to report an existing one.",
    );
    this.#landingAction.hidden = waiting;
    const label =
      this.#landingAction.querySelector<HTMLElement>(".button-label");
    if (label)
      setText(
        label,
        this.#tree.length === 0 ? "Pair a machine" : "New session",
      );
    setText(
      this.#landingMeta,
      this.#tree.length > 0
        ? `${count} ${count === 1 ? "session" : "sessions"} · ${this.#tree.length} ${this.#tree.length === 1 ? "machine" : "machines"}`
        : "Passkey access · End-to-end encrypted",
    );
  }

  showSession(
    session: SessionMeta,
    transcript: TranscriptState,
    handlers: ControlHandlers,
    pending: readonly InteractionFrame[],
    catalog: SessionCatalog,
  ): void {
    if (this.#selectedId && this.#selectedId !== session.id)
      this.#views.get(this.#selectedId)?.hide();
    this.#selectedId = session.id;
    this.node.classList.add("has-session");
    this.#dialogs.closeSettings();
    this.#landing.hidden = true;
    this.#pending.hidden = true;
    let view = this.#views.get(session.id);
    if (!view) {
      view = new SessionView(session, handlers, this.#preferences, this.#chat);
      this.#views.set(session.id, view);
      this.#content.append(view.node);
    }
    const machine = this.#tree.find((item) =>
      item.projects.some((project) =>
        project.sessions.some((item) => item.id === session.id),
      ),
    );
    view.update(
      session,
      transcript,
      handlers,
      pending,
      catalog,
      machine?.label,
      machine?.offline === true,
    );
  }

  showSpawnPending(pending: PendingSpawn, handlers: ControlHandlers): void {
    this.#handlers = handlers;
    if (this.#selectedId) this.#views.get(this.#selectedId)?.hide();
    this.#selectedId = undefined;
    this.node.classList.add("has-session");
    this.#dialogs.closeSettings();
    this.#landing.hidden = true;
    this.#pending.hidden = false;
    const failed = pending.status === "failed";
    this.#pendingMark.replaceChildren(
      failed ? icon("terminal") : element("div", "spawn-spinner"),
    );
    setText(this.#pendingEyebrow, failed ? "Start failed" : "Starting session");
    setText(
      this.#pendingTitle,
      failed ? "Couldn't start the session" : pending.project,
    );
    setText(
      this.#pendingCopy,
      failed
        ? "It didn't report back in time. It may still be starting on the host — check the machine, or try again."
        : `Launching omp in ${pending.project}. It opens here as soon as the host reports it.`,
    );
    const label =
      this.#pendingAction.querySelector<HTMLElement>(".button-label");
    if (label) setText(label, failed ? "Back to sessions" : "Cancel");
    this.#pendingAction.className = failed
      ? "button primary"
      : "button secondary";
  }

  hasDraft(): boolean {
    for (const view of this.#views.values()) if (view.hasDraft()) return true;
    return false;
  }

  dispose(): void {
    for (const view of this.#views.values()) view.dispose();
    // Keep the shell-owned SAS status node available when a new workspace mounts.
    const status =
      this.#dialogs.settings.node.querySelector<HTMLElement>(".pair-status");
    if (status) document.body.append(status);
    this.#dialogs.closeSettings();
    this.#dialogs.spawn.node.close();
    this.node.remove();
  }
}

const workspaces = new WeakMap<HTMLElement, Workspace>();

function workspaceFor(root: HTMLElement, handlers: ControlHandlers): Workspace {
  let workspace = workspaces.get(root);
  if (!workspace) {
    workspace = new Workspace(root, handlers);
    workspaces.set(root, workspace);
  }
  return workspace;
}

/** Whether any session mounted under `root` holds unsent input (composer text
 *  or attachments, or an answer typed into a pending question). A reload would
 *  lose it: drafts live only in memory. */
export function hasUnsentDraft(root: HTMLElement): boolean {
  return workspaces.get(root)?.hasDraft() ?? false;
}

export function renderTree(
  root: HTMLElement,
  tree: MachineNode[],
  handlers: ControlHandlers,
  sessionPulse: (sessionId: string) => SessionPulse | null = () => null,
  orbState: (sessionId: string) => OrbState | null = () => null,
  connecting = false,
): void {
  const workspace = workspaceFor(root, handlers);
  workspace.updateConnection(handlers);
  workspace.updateNavigation(
    tree,
    handlers,
    sessionPulse,
    orbState,
    connecting,
  );
  workspace.showTree();
}

export function renderSessionView(
  root: HTMLElement,
  session: SessionMeta,
  transcript: TranscriptState,
  handlers: ControlHandlers,
  pending: readonly InteractionFrame[] = [],
  catalog: SessionCatalog = { models: [], roles: [] },
  navigation?: {
    tree: MachineNode[];
    sessionPulse: (id: string) => SessionPulse | null;
    orbState: (id: string) => OrbState | null;
    connecting?: boolean;
  },
): void {
  const workspace = workspaceFor(root, handlers);
  workspace.updateConnection(handlers);
  if (navigation)
    workspace.updateNavigation(
      navigation.tree,
      handlers,
      navigation.sessionPulse,
      navigation.orbState,
      navigation.connecting === true,
      session.id,
    );
  workspace.showSession(session, transcript, handlers, pending, catalog);
}

export function renderSpawnPending(
  root: HTMLElement,
  pending: PendingSpawn,
  handlers: ControlHandlers,
  navigation?: {
    tree: MachineNode[];
    sessionPulse: (id: string) => SessionPulse | null;
    orbState: (id: string) => OrbState | null;
    connecting?: boolean;
  },
): void {
  const workspace = workspaceFor(root, handlers);
  workspace.updateConnection(handlers);
  if (navigation)
    workspace.updateNavigation(
      navigation.tree,
      handlers,
      navigation.sessionPulse,
      navigation.orbState,
      navigation.connecting === true,
    );
  workspace.showSpawnPending(pending, handlers);
}

/** What the sign-in screen offers and does; `main` wires it to the relay. */
export interface LoginOptions {
  /** Which sign-ins the relay offers now (`GET /auth/methods`). */
  methods: SignInMethods;
  /** This browser can use passkeys here: an HTTPS page with WebAuthn. */
  passkeyAvailable: boolean;
  /** Sign in with the password; on success `main` has already moved on. */
  onPasswordLogin: (
    password: string,
    remember: boolean,
  ) => Promise<PasswordLoginResult>;
  /** Sign in with a passkey; `main` reports a failure in the status line. */
  onPasskeyLogin: (remember: boolean) => Promise<void>;
}

/** What a refused password sign-in means, said on the sign-in screen. */
function passwordRefusalText(
  result: Exclude<PasswordLoginResult, { ok: true }>,
): string {
  switch (result.reason) {
    case "wrong-password":
      return "Wrong password. Try again.";
    case "disabled":
      return "Password sign-in is off on this server. Use a passkey.";
    case "throttled":
      return `Too many attempts. Try again in ${result.retryAfterSec} s.`;
  }
}

/**
 * The sign-in screen: the password while the relay offers it, and a passkey
 * while the relay offers passkeys and this browser can use them. "Keep me
 * signed in on this device" starts checked when `keepSignedIn`, this device's
 * choice from Settings or its last sign-in.
 */
export function renderLoginView(
  root: HTMLElement,
  options: LoginOptions,
  status: HTMLElement,
  keepSignedIn = false,
): void {
  workspaces.get(root)?.dispose();
  workspaces.delete(root);
  const usePassword = options.methods.password;
  const usePasskey = options.methods.passkey && options.passkeyAvailable;
  const view = element("main", "login");
  const story = element("section", "login-story");
  const introduction = element("div", "login-introduction");
  introduction.append(
    element("p", "eyebrow", "Your remote workspace"),
    element("h1", "login-title", "Good work.\nFrom wherever."),
    element(
      "p",
      "login-copy",
      "Your machines, your OMP sessions. Follow the conversation, guide the next step, and answer when you're needed.",
    ),
  );
  const privacy = element("p", "login-privacy");
  privacy.append(
    icon("lock"),
    element(
      "span",
      "",
      "Session content stays between your browser and your machines.",
    ),
  );
  story.append(brand(), introduction, privacy);
  const panel = element("section", "login-panel");
  const card = element("div", "login-card");
  const mark = element("div", "login-card-mark");
  mark.append(brandMark());
  const title = element("h2", "login-card-title", "Open your workspace");
  title.id = uniqueId("login");
  panel.setAttribute("aria-labelledby", title.id);
  const remember = document.createElement("input");
  remember.type = "checkbox";
  remember.className = "login-remember-check";
  remember.id = uniqueId("remember");
  remember.checked = keepSignedIn;
  const rememberField = element("label", "login-remember");
  rememberField.htmlFor = remember.id;
  rememberField.append(
    remember,
    element("span", "login-remember-label", "Keep me signed in on this device"),
  );
  status.classList.add("status", "login-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const password = document.createElement("input");
  password.type = "password";
  password.className = "login-password";
  password.name = "password";
  password.autocomplete = "current-password";
  password.autocapitalize = "off";
  password.spellcheck = false;
  password.required = true;
  const passwordField = field("Password", password);
  const passwordHint = element(
    "p",
    "field-hint",
    "Forgot it? Set a new one on the server with omp-remote passwd.",
  );
  passwordHint.id = `${password.id}-hint`;
  password.setAttribute("aria-describedby", passwordHint.id);
  passwordField.append(passwordHint);
  const signInButton = button("Sign in", "button primary login-submit");
  signInButton.type = "submit";
  const passwordForm = element("form", "login-password-form");
  passwordForm.noValidate = true;
  passwordForm.append(passwordField, signInButton);
  passwordForm.hidden = !usePassword;

  const passkey = button(
    "Continue with passkey",
    usePassword
      ? "button secondary login-passkey"
      : "button primary login-submit login-passkey",
    "lock",
  );
  passkey.hidden = !usePasskey;

  let busy = false;
  const syncControls = (): void => {
    passkey.disabled = busy;
    signInButton.disabled = busy || password.value.length === 0;
  };
  syncControls();
  const run = async (
    action: () => Promise<void>,
    failure: string,
  ): Promise<void> => {
    busy = true;
    syncControls();
    card.setAttribute("aria-busy", "true");
    try {
      await action();
    } catch {
      status.textContent = failure;
    } finally {
      busy = false;
      syncControls();
      card.removeAttribute("aria-busy");
    }
  };
  passkey.addEventListener("click", () => {
    void run(
      () => options.onPasskeyLogin(remember.checked),
      "Could not complete the passkey request. Please try again.",
    );
  });
  password.addEventListener("input", syncControls);
  // Enter in the field submits the form; a disabled submit button already
  // blocks implicit submission, the guard covers programmatic submits.
  passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || password.value.length === 0) return;
    void run(async () => {
      status.textContent = "Signing in…";
      const result = await options.onPasswordLogin(
        password.value,
        remember.checked,
      );
      // Signed in: `main` has moved on. Refused: the password stays to fix.
      if (result.ok) return;
      status.textContent = passwordRefusalText(result);
      password.focus();
    }, "Couldn't sign in. Check your connection and try again.");
  });

  const copy = usePassword
    ? usePasskey
      ? "Sign in with your password or a passkey."
      : "Sign in with the password set on your server."
    : usePasskey
      ? "Use your passkey to securely connect to your workspace."
      : "This server signs in with passkeys only, and passkeys need HTTPS. Open this app at the server's HTTPS address.";
  card.append(
    mark,
    title,
    element("p", "login-card-copy", copy),
    rememberField,
    passwordForm,
  );
  if (usePassword && usePasskey)
    card.append(element("div", "login-divider", "Or"));
  card.append(passkey, status);
  panel.append(
    card,
    element(
      "p",
      "login-security meta",
      usePasskey && !usePassword
        ? "PASSKEY ACCESS / SEALED SESSION CONTENT"
        : "SIGNED-IN ACCESS / SEALED SESSION CONTENT",
    ),
  );
  view.append(story, panel);
  root.replaceChildren(view);
}
