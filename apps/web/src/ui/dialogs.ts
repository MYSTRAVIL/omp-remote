/// <reference lib="dom" />
import {
  ApprovalMode,
  type HistoryEntry,
  type SessionMeta,
  SpawnThinkingLevel,
} from "@omp-remote/protocol";
import type { ChatPreferences } from "../core/chat-preferences";
import type {
  ComposerPreferences,
  ComposerSendMode,
} from "../core/composer-preferences";
import type { OverlayEntry } from "../core/history-nav";
import {
  type KnownProject,
  LaunchPreferences,
} from "../core/launch-preferences";
import type { MachineNode } from "../core/session-tree";
import type { SpawnOptions } from "../core/spawn-frame";
import { timeAgo } from "../core/time-format";
import { AboutSettings } from "./about-settings";
import { AccountSettings } from "./account-settings";
import { AppearanceSettings } from "./appearance-settings";
import { ChatSettings } from "./chat-settings";
import { type Choice, type Dropdown, dropdown, savedOutcome } from "./choices";
import { button, element, field, setText, syncChildren, uniqueId } from "./dom";
import { MachineSettings } from "./machine-settings";
import { type ModelPick, ModelPicker } from "./model-picker";
import { NotificationSettings } from "./notification-settings";
import type { ControlHandlers } from "./render";

const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  "always-ask": "Always ask",
  write: "Write mode",
  yolo: "Allow all tools (yolo)",
};

/** What the About page tells people about their data, in reading order. */
const DATA_PROTECTION: readonly { label: string; description: string }[] = [
  {
    label: "End-to-end encryption",
    description:
      "Session content is encrypted between this browser and your machine. The relay routes sealed data.",
  },
  {
    label: "Passkey verification",
    description:
      "Sending messages, answering requests, starting sessions, and interrupting require a recent passkey verification.",
  },
  {
    label: "Drafts stay in this tab",
    description:
      "Message and answer drafts are kept in memory, not saved to browser storage. Reloading or closing this tab clears them.",
  },
];

/** Where a new session starts on one machine; kept per machine while the tab lives. */
interface DirectoryDraft {
  /** The chosen remembered project; empty when Custom directory is chosen. */
  projectCwd: string;
  /** What was typed as the custom directory. */
  cwd: string;
}

/** A remembered project's row in New session's Manage list, with Hide and Remove. */
interface ManagedProjectRow {
  readonly node: HTMLLIElement;
  readonly name: HTMLElement;
  readonly meta: HTMLElement;
  readonly hide: HTMLButtonElement;
  readonly remove: HTMLButtonElement;
  /** The project last drawn in this row; undefined until first drawn. */
  project: KnownProject | undefined;
}

/** Settings > Projects: one hidden project and its Unhide. */
interface HiddenProjectRow {
  readonly node: HTMLLIElement;
  readonly name: HTMLElement;
  readonly meta: HTMLElement;
  readonly unhide: HTMLButtonElement;
  project: string;
}

/** Settings > Projects: one machine's default project. */
interface DefaultProjectRow {
  readonly dropdown: Dropdown<string>;
  /** The project list the options were drawn from, to skip identical redraws. */
  projects: readonly KnownProject[] | undefined;
}

/** Settings > New sessions: one machine's default model, as New session picks one. */
interface DefaultModelRow {
  readonly machineId: string;
  readonly node: HTMLFieldSetElement;
  readonly caption: HTMLElement;
  readonly picker: ModelPicker;
  readonly input: HTMLInputElement;
  readonly hint: HTMLElement;
  /** The catalog and model id the picker last drew, to skip identical redraws. */
  shownCatalog: MachineNode["catalog"];
  shownModel: string;
}

/** Every effort New session offers; "" leaves the level to omp. */
type EffortChoice = "" | SpawnThinkingLevel;
const EFFORT_LABELS: Record<EffortChoice, string> = {
  "": "omp default",
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  auto: "Auto",
};
const EFFORT_CHOICES: readonly Choice<EffortChoice>[] = [
  "" as const,
  ...SpawnThinkingLevel.options,
].map((level) => ({ value: level, label: EFFORT_LABELS[level] }));
const APPROVAL_CHOICES: readonly Choice<ApprovalMode>[] =
  ApprovalMode.options.map((mode) => ({
    value: mode,
    label: APPROVAL_MODE_LABELS[mode],
  }));
const SEND_MODE_CHOICES: readonly Choice<ComposerSendMode>[] = [
  { value: "followUp", label: "Queue" },
  { value: "steer", label: "Steer" },
];

/** A project in a bordered list (Manage in New session, Hidden projects): name, path, actions. */
function listedProject(...actions: HTMLButtonElement[]): {
  node: HTMLLIElement;
  name: HTMLElement;
  meta: HTMLElement;
} {
  const node = element("li", "settings-machine");
  const summary = element("div", "settings-machine-summary");
  const copy = element("div", "settings-machine-copy");
  const name = element("span", "settings-machine-name");
  const meta = element("span", "meta");
  copy.append(name, meta);
  const buttons = element("div", "settings-machine-actions");
  buttons.append(...actions);
  summary.append(copy, buttons);
  node.append(summary);
  return { node, name, meta };
}

/** A Settings section, named by its title for assistive technology. */
function settingsSection(title: string): HTMLElement {
  const node = element("section", "settings-section");
  const heading = element("h3", "section-title", title);
  heading.id = uniqueId("settings-section");
  node.setAttribute("aria-labelledby", heading.id);
  node.append(heading);
  return node;
}

/** The model id a picker row stands for: "" for omp's default; undefined for an effort row. */
function pickedModel(pick: ModelPick): string | undefined {
  switch (pick.kind) {
    case "default":
      return "";
    case "role":
      return pick.role.modelId;
    case "model":
      return pick.model.id;
    case "effort":
      return undefined;
  }
}

function dialogShell(
  title: string,
  subtitle: string,
  onOverlay: ControlHandlers["onOverlay"],
): {
  node: HTMLDialogElement;
  body: HTMLElement;
  /** Open modally with a history entry, so back closes the dialog. */
  show(): void;
} {
  const node = element("dialog", "workspace-dialog");
  const header = element("header", "dialog-header");
  const copy = element("div", "dialog-heading");
  const heading = element("h2", "dialog-title", title);
  heading.id = uniqueId("dialog");
  node.setAttribute("aria-labelledby", heading.id);
  copy.append(element("p", "eyebrow", subtitle), heading);
  const close = button("Close", "button icon-button dialog-close", "close");
  close.setAttribute("aria-label", `Close ${title.toLowerCase()}`);
  close.addEventListener("click", () => node.close());
  header.append(copy, close);
  const body = element("div", "dialog-body");
  node.append(header, body);
  node.addEventListener("click", (event) => {
    if (event.target !== node) return;
    const bounds = node.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) {
      node.close();
    }
  });
  // Every close path — Close, backdrop, Cancel, Esc, back, a programmatic
  // close() — ends in the `close` event, which retires the history entry.
  let entry: OverlayEntry | undefined;
  node.addEventListener("close", () => {
    if (node.open) return; // reopened before this queued event ran
    entry?.dismiss();
    entry = undefined;
  });
  const show = (): void => {
    if (node.open) return;
    node.showModal();
    // A close whose event is still queued hasn't retired its entry yet.
    entry?.dismiss();
    entry = onOverlay(() => node.close());
  };
  return { node, body, show };
}

/**
 * A question in the app's modal dialog, with Cancel beside the action. `ask`
 * opens it with `detail` (back closes it, like any dialog); the action closes
 * it and runs `onConfirm` once. Every other way out confirms nothing.
 */
export function confirmDialog(options: {
  title: string;
  subtitle: string;
  action: string;
  onConfirm(): void;
  onOverlay: ControlHandlers["onOverlay"];
}): {
  node: HTMLDialogElement;
  ask(detail: string): void;
  close(): void;
} {
  const shell = dialogShell(options.title, options.subtitle, options.onOverlay);
  const detail = element("p", "section-copy");
  shell.body.append(detail);
  const cancel = button("Cancel", "button secondary");
  cancel.addEventListener("click", () => shell.node.close());
  const go = button(options.action, "button primary");
  go.addEventListener("click", () => {
    if (!shell.node.open) return;
    shell.node.close();
    options.onConfirm();
  });
  const actions = element("div", "dialog-actions");
  actions.append(cancel, go);
  const footer = element("footer", "dialog-footer");
  footer.append(actions);
  shell.node.append(footer);
  return {
    node: shell.node,
    ask: (text) => {
      setText(detail, text);
      shell.show();
      // The safe choice holds focus, so a stray Enter confirms nothing.
      cancel.focus();
    },
    close: () => shell.node.close(),
  };
}

export class WorkspaceDialogs {
  readonly settings = dialogShell("Settings", "Workspace", (close) =>
    this.#handlers.onOverlay(close),
  );
  /** Stacks over Settings with its own history entry: back returns to Settings. */
  readonly about = dialogShell("About", "Settings", (close) =>
    this.#handlers.onOverlay(close),
  );
  readonly spawn = dialogShell("New session", "Start something", (close) =>
    this.#handlers.onOverlay(close),
  );
  readonly #spawnForm = element("form", "spawn-form");
  /** Its hint says why Start waits when the chosen machine can't take a session. */
  readonly #spawnMachine = dropdown<string>({
    label: "Machine",
    choices: [],
    onChange: (machineId) => this.#selectMachine(machineId),
  });
  /** The project dropdown, Manage's list and the custom directory, disabled together. */
  readonly #projectGroup = element("fieldset", "spawn-project");
  readonly #spawnProject = dropdown<string>({
    label: "Project",
    choices: [],
    onChange: (cwd) => this.#chooseProject(cwd),
  });
  readonly #manageProjects = element("button", "button secondary field-action");
  readonly #managedList = element("ul", "settings-machines");
  readonly #managedRows = new Map<string, ManagedProjectRow>();
  readonly #cwd = element("input", "spawn-cwd");
  readonly #cwdField = field(
    "Working directory (cwd)",
    this.#cwd,
    "A full path to an existing directory on that machine.",
  );
  readonly #modelGroup = element("fieldset", "spawn-group");
  readonly #modelPicker = new ModelPicker({
    heading: "h3",
    rootTitle: "Model",
    effort: false,
    defaultLabel: "Host default",
    onPick: (pick) => this.#pickModel(pick),
  });
  readonly #model = element("input", "spawn-model");
  readonly #modelHint = element("p", "field-hint");
  readonly #spawnEffort = dropdown({
    label: "Effort",
    choices: EFFORT_CHOICES,
    hint: "Starts at your Settings default. A role you pick brings its own effort.",
  });
  readonly #spawnApproval = dropdown({
    label: "Approval mode",
    choices: APPROVAL_CHOICES,
    onChange: () => this.#updateApprovalHint(),
  });
  readonly #spawnButton = button(
    "Start session",
    "button primary spawn",
    "plus",
  );
  readonly #spawnStatus = element("p", "spawn-status");
  /** Past sessions: its toggle, and the panel listing the chosen project's stored sessions. */
  readonly #pastToggle = button(
    "Past sessions",
    "button secondary spawn-past-toggle",
  );
  readonly #pastPanel = element("div", "spawn-past");
  readonly #pastStatus = element("p", "field-hint spawn-past-status");
  readonly #pastList = element("ul", "settings-machines spawn-past-list");
  /** The project Past sessions is open for, and whether the ask reached its machine. */
  #past: { machineId: string; cwd: string; sent: boolean } | undefined;
  /** The answer the list was drawn from, to skip identical redraws. */
  #drawnPast: readonly HistoryEntry[] | undefined;
  /** The stored session Start reopens instead of starting a new one. */
  #resume:
    | {
        machineId: string;
        cwd: string;
        sessionId: string;
        title: string;
        ago: string;
      }
    | undefined;
  readonly #resumeNote = element("div", "spawn-resume");
  readonly #resumeCopy = element("p", "section-copy");
  readonly #resumeCancel = button("Start new instead", "button secondary");
  readonly #pairForm = element("form", "pair-form");
  readonly #pairCode = element("input", "pair-code");
  readonly #pairButton = button("Pair machine", "button primary pair");
  readonly #pairStatus: HTMLElement;
  readonly #accountSettings: AccountSettings;
  readonly #machineSettings: MachineSettings;
  readonly #chatSettings: ChatSettings;
  /** Undefined without push to manage (local dev, tests). */
  readonly #notificationSettings: NotificationSettings | undefined;
  /** Undefined when there are no appearance preferences to edit (tests). */
  readonly #appearanceSettings: AppearanceSettings | undefined;
  readonly #aboutSettings = new AboutSettings(() => this.about.show());
  readonly #sendMode = dropdown({
    label: "Default send action",
    choices: SEND_MODE_CHOICES,
    hint: "Queue waits for the active turn to finish; Steer redirects it; both start at once when the session is idle. This sets the send button and Ctrl + Enter. The message menu has the other action, and Interrupt, which stops the turn without sending your draft.",
    onChange: (mode) => {
      const label =
        SEND_MODE_CHOICES.find((choice) => choice.value === mode)?.label ??
        mode;
      setText(
        this.#preferenceStatus,
        savedOutcome(
          this.#preferences.setMode(mode),
          `${label} is the default in this browser.`,
        ),
      );
    },
  });
  readonly #preferenceStatus = element("p", "field-hint preference-status");
  readonly #preferences: ComposerPreferences;
  readonly #launchPreferences = new LaunchPreferences();
  readonly #defaultMachine = dropdown<string>({
    label: "Default machine",
    choices: [],
    hint: "Chosen when you open New session without picking a machine, if it is online.",
    onChange: (value) => {
      const machineId = value || undefined;
      const name =
        this.#settingsMachines().find(
          (machine) => machine.machineId === machineId,
        )?.label ?? value;
      setText(
        this.#launchPreferenceStatus,
        savedOutcome(
          this.#launchPreferences.setDefaultMachine(machineId),
          machineId === undefined
            ? "New session starts on the machine you chose last."
            : `New session starts on ${name} whenever it is online.`,
        ),
      );
    },
  });
  readonly #defaultModels = element("div", "default-models");
  readonly #defaultModelRows = new Map<string, DefaultModelRow>();
  readonly #defaultModelsEmpty = element(
    "p",
    "field-hint",
    "Pair a machine to choose the model its new sessions start with.",
  );
  readonly #defaultEffort = dropdown({
    label: "Default effort",
    choices: EFFORT_CHOICES,
    hint: "How much the model thinks. omp default leaves it to omp.",
    onChange: (choice) => {
      const level = choice || undefined;
      setText(
        this.#launchPreferenceStatus,
        savedOutcome(
          this.#launchPreferences.setDefaultEffort(level),
          level === undefined
            ? "New sessions start at omp's default effort."
            : `New sessions start at ${EFFORT_LABELS[level]} effort.`,
        ),
      );
    },
  });
  readonly #defaultApproval = dropdown({
    label: "Default approval mode",
    choices: APPROVAL_CHOICES,
    hint: "Used when you open New session. You can override it for an individual session before starting.",
    onChange: (mode) =>
      setText(
        this.#launchPreferenceStatus,
        savedOutcome(
          this.#launchPreferences.setApprovalMode(mode),
          `${APPROVAL_MODE_LABELS[mode]} is the default approval mode in this browser.`,
        ),
      ),
  });
  readonly #launchPreferenceStatus = element(
    "p",
    "field-hint preference-status",
  );
  readonly #defaultProjects = element("div", "default-projects");
  readonly #defaultProjectRows = new Map<string, DefaultProjectRow>();
  readonly #defaultProjectsEmpty = element(
    "p",
    "field-hint",
    "No remembered projects yet. New session remembers the directories your sessions run in.",
  );
  readonly #hiddenHeading = element(
    "h4",
    "settings-subtitle",
    "Hidden projects",
  );
  readonly #hiddenList = element("ul", "settings-machines");
  readonly #hiddenEmpty = element(
    "p",
    "field-hint settings-machines-empty",
    "No hidden projects.",
  );
  readonly #projectsStatus = element("p", "field-hint preference-status");
  readonly #hiddenRows = new Map<string, HiddenProjectRow>();
  readonly #directoryDrafts = new Map<string, DirectoryDraft>();
  /** The model id typed or picked per machine while the dialog is open. */
  readonly #modelDrafts = new Map<string, string>();
  #selectedMachineId = "";
  /** Manage is on: the remembered projects are listed, each with Hide and Remove. */
  #managing = false;
  /** The project list the Project dropdown was drawn from, to skip identical redraws. */
  #drawnProjects: readonly KnownProject[] | undefined;
  /** The catalog and model id the picker last drew, to skip identical redraws. */
  #shownCatalog: MachineNode["catalog"];
  #shownModel = "";
  #handlers: ControlHandlers;
  #tree: MachineNode[] = [];
  #spawning = false;
  #pairing = false;

  constructor(
    handlers: ControlHandlers,
    preferences: ComposerPreferences,
    chat: ChatPreferences,
  ) {
    this.#handlers = handlers;
    this.#preferences = preferences;
    this.#pairStatus =
      document.querySelector<HTMLElement>(".pair-status") ??
      element("p", "pair-status");
    this.#pairStatus.setAttribute("role", "status");
    this.#pairStatus.setAttribute("aria-live", "polite");
    this.#accountSettings = new AccountSettings(handlers);
    this.#machineSettings = new MachineSettings(handlers, (machineId) => {
      this.#launchPreferences.forgetMachine(machineId);
      this.#renderLaunchDefaults();
      this.#renderDefaultProjects();
    });
    this.#chatSettings = new ChatSettings(chat);
    this.#notificationSettings =
      handlers.push === undefined
        ? undefined
        : new NotificationSettings(handlers.push);
    this.#appearanceSettings =
      handlers.appearance === undefined
        ? undefined
        : new AppearanceSettings(handlers.appearance);
    this.#buildSettings();
    this.#buildAbout();
    this.#buildSpawn();
  }

  update(tree: MachineNode[], handlers: ControlHandlers): void {
    this.#tree = tree;
    this.#handlers = handlers;
    this.#launchPreferences.observeProjects(tree);
    this.#accountSettings.update(handlers);
    this.#pairForm.hidden = handlers.onPair === undefined;
    this.#renderMachines();
    this.#renderProjects();
    this.#syncModel();
    this.#syncSpawnControls();
    // Pairing and spawn inputs remain mounted, including while their dialogs are closed.
    if (!this.settings.node.open) return;
    this.#machineSettings.update(tree, handlers);
    this.#aboutSettings.update(tree, handlers);
    this.#notificationSettings?.update();
    this.#renderLaunchDefaults();
    this.#renderDefaultProjects();
    this.#renderHiddenProjects();
  }

  openSettings(): void {
    // A reopened Settings starts at rest, with no half-finished rename or
    // forget and no outcome from last time.
    if (!this.settings.node.open) {
      this.#machineSettings.reset();
      this.#accountSettings.reset();
      this.#chatSettings.reset();
      this.#notificationSettings?.reset();
      this.#appearanceSettings?.reset();
      this.#aboutSettings.reset(this.#handlers);
      setText(this.#preferenceStatus, "");
      setText(this.#launchPreferenceStatus, "");
      setText(this.#projectsStatus, "");
    }
    this.#machineSettings.update(this.#tree, this.#handlers);
    this.#aboutSettings.update(this.#tree, this.#handlers);
    this.#renderLaunchDefaults(true);
    this.#renderDefaultProjects();
    this.#renderHiddenProjects();
    this.#sendMode.set(this.#preferences.mode);
    this.#defaultEffort.set(this.#launchPreferences.defaultEffort ?? "");
    this.#defaultApproval.set(this.#launchPreferences.approvalMode);
    this.settings.show();
  }

  /** Close Settings and the About page stacked on it, top first. */
  closeSettings(): void {
    this.about.node.close();
    this.settings.node.close();
  }

  openSpawn(machineId?: string, session?: SessionMeta): void {
    if (this.spawn.node.open || this.#spawning) {
      this.spawn.show();
      return;
    }
    // Opened without a machine: the saved default while it is online, else the
    // machine chosen last while online, else the first online one. An offline
    // machine is still chosen when no machine is online, or when asked for.
    const preferred = this.#launchPreferences.defaultMachine;
    const online = this.#tree
      .filter((machine) => machine.offline !== true)
      .map((machine) => machine.machineId);
    const target =
      machineId ??
      (preferred !== undefined && online.includes(preferred)
        ? preferred
        : online.includes(this.#selectedMachineId)
          ? this.#selectedMachineId
          : (online[0] ?? this.#tree[0]?.machineId));
    if (!target || !this.#tree.some((machine) => machine.machineId === target))
      return;
    // Every open starts each machine's model at its saved default ("" for the
    // host's), so nothing typed into a cancelled form carries over. From a
    // session, the form then takes that session's directory and model;
    // otherwise each machine's default project.
    this.#modelDrafts.clear();
    // Past sessions starts closed, and Start starts a new session.
    this.#past = undefined;
    this.#resume = undefined;
    this.#model.value = this.#launchPreferences.defaultModel(
      this.#selectedMachineId,
    );
    if (!session) this.#startFromDefaultProjects();
    this.#selectMachine(target, session?.cwd);
    if (session) this.#model.value = session.model;
    this.#setManaging(false);
    this.#syncModel(true);
    this.#spawnEffort.set(this.#launchPreferences.defaultEffort ?? "");
    this.#spawnApproval.set(this.#launchPreferences.approvalMode);
    this.#updateApprovalHint();
    setText(this.#spawnStatus, "");
    this.spawn.show();
    this.spawn.body.scrollTop = 0;
    // A remembered project is chosen from the dropdown; without one, the path is typed.
    (this.#spawnProject.node.hidden
      ? this.#cwd
      : this.#spawnProject.select
    ).focus({ preventScroll: true });
  }

  /**
   * Each machine's project starts at its default project when it has one; a
   * machine without a default project keeps the one this tab last chose.
   */
  #startFromDefaultProjects(): void {
    for (const [machineId, draft] of this.#directoryDrafts) {
      const project = this.#launchPreferences.defaultProject(machineId);
      if (project !== undefined) draft.projectCwd = project;
    }
  }

  #selectMachine(machineId: string, initialCwd?: string): void {
    if (
      this.#spawning ||
      !this.#tree.some((machine) => machine.machineId === machineId)
    )
      return;
    const previous = this.#selectedMachineId;
    const changed = machineId !== previous;
    this.#selectedMachineId = machineId;
    if (changed) {
      // A model id picked from one machine's catalog may not exist on another.
      if (previous) this.#modelDrafts.set(previous, this.#model.value);
      this.#model.value =
        this.#modelDrafts.get(machineId) ??
        this.#launchPreferences.defaultModel(machineId);
    }
    if (!this.#directoryDrafts.has(machineId)) {
      const projects = this.#launchPreferences.projectsFor(machineId);
      const cwd =
        initialCwd ??
        this.#launchPreferences.defaultProject(machineId) ??
        projects[0]?.cwd ??
        "";
      const known = projects.some((project) => project.cwd === cwd);
      this.#directoryDrafts.set(machineId, {
        projectCwd: known ? cwd : "",
        cwd: known ? "" : cwd,
      });
    }
    if (changed) {
      this.#setManaging(false);
      setText(this.#spawnStatus, "");
    }
    this.#renderMachines();
    this.#renderProjects();
    this.#syncModel(changed);
    this.#syncSpawnControls();
  }

  #renderMachines(): void {
    const selected = this.#selectedMachineId;
    this.#spawnMachine.setChoices(
      this.#tree.map((machine) => {
        const { machineId, label } = machine;
        const count = machine.projects.reduce(
          (total, project) => total + project.sessions.length,
          0,
        );
        const sessions = `${count} ${count === 1 ? "session" : "sessions"}`;
        const name = label === machineId ? label : `${label} (${machineId})`;
        return {
          value: machineId,
          label:
            machine.offline === true
              ? `${name} · Offline · ${sessions}`
              : `${name} · ${sessions}`,
        };
      }),
    );
    // Nothing is chosen while the chosen machine is not listed.
    this.#spawnMachine.set(selected);
    // The chosen machine left the workspace, or the relay no longer lists it:
    // Start waits either way, and the hint says why.
    const chosen = this.#chosenMachine();
    setText(
      this.#spawnMachine.hint,
      selected === "" || (chosen !== undefined && chosen.offline !== true)
        ? ""
        : chosen === undefined
          ? "The machine you chose is unavailable. Choose another one."
          : `${chosen.label} is offline. Sessions can't start until it reconnects.`,
    );
  }

  /** The machine New session would start on, while the workspace lists it. */
  #chosenMachine(): MachineNode | undefined {
    return this.#tree.find(
      (machine) => machine.machineId === this.#selectedMachineId,
    );
  }

  #renderProjects(): void {
    const draft = this.#directoryDrafts.get(this.#selectedMachineId);
    const projects = this.#launchPreferences.projectsFor(
      this.#selectedMachineId,
    );
    const rows: HTMLElement[] = [];
    const paths = new Set<string>();
    for (const project of projects) {
      paths.add(project.cwd);
      let row = this.#managedRows.get(project.cwd);
      if (!row) {
        row = this.#managedRow();
        this.#managedRows.set(project.cwd, row);
      }
      if (row.project !== project) {
        row.project = project;
        setText(row.name, project.project);
        setText(row.meta, project.cwd);
        row.hide.setAttribute("aria-label", `Hide ${project.project}`);
        row.remove.setAttribute(
          "aria-label",
          `Remove ${project.project} from this device's list`,
        );
      }
      rows.push(row.node);
    }
    for (const path of this.#managedRows.keys()) {
      if (!paths.has(path)) this.#managedRows.delete(path);
    }
    syncChildren(this.#managedList, rows);
    if (projects !== this.#drawnProjects) {
      this.#drawnProjects = projects;
      this.#spawnProject.setChoices([
        ...projects.map((project) => ({
          value: project.cwd,
          label: `${project.project} · ${project.cwd}`,
        })),
        { value: "", label: "Custom directory…" },
      ]);
    }
    // A chosen project that left the list (hidden or removed) stays chosen as
    // a custom directory, so where the session starts never changes silently.
    if (draft?.projectCwd && !paths.has(draft.projectCwd)) {
      draft.cwd = draft.projectCwd;
      draft.projectCwd = "";
    }
    const chosen = draft?.projectCwd ?? "";
    this.#spawnProject.set(chosen);
    // Without remembered projects there is nothing to choose: just the path.
    this.#spawnProject.node.hidden = projects.length === 0;
    if (projects.length === 0 && this.#managing) this.#setManaging(false);
    this.#cwdField.hidden = chosen !== "";
    // A hidden required field would block submitting a chosen project.
    this.#cwd.required = chosen === "";
    const cwd = draft?.cwd ?? "";
    if (this.#cwd.value !== cwd) this.#cwd.value = cwd;
    this.#syncPast();
  }

  #managedRow(): ManagedProjectRow {
    const hide = button("Hide", "button secondary");
    hide.title = "Hide it from this list. Unhide it in Settings > Projects.";
    const remove = button("Remove", "button secondary");
    remove.title =
      "Remove it from this device's list. It comes back only if you start a new session in this directory.";
    const row: ManagedProjectRow = {
      ...listedProject(hide, remove),
      hide,
      remove,
      project: undefined,
    };
    hide.addEventListener("click", () => this.#dropProject(row, "hide"));
    remove.addEventListener("click", () => this.#dropProject(row, "remove"));
    return row;
  }

  /** Choose a remembered project by its path, or Custom directory with "". */
  #chooseProject(projectCwd: string): void {
    const draft = this.#directoryDrafts.get(this.#selectedMachineId);
    if (this.#spawning || !draft) return;
    // Custom starts from the last chosen project's path, ready to edit.
    if (!projectCwd && !draft.cwd) draft.cwd = draft.projectCwd;
    draft.projectCwd = projectCwd;
    this.#renderProjects();
  }

  #dropProject(row: ManagedProjectRow, action: "hide" | "remove"): void {
    const machineId = this.#selectedMachineId;
    const project = row.project;
    if (this.#spawning || !project) return;
    const index = this.#launchPreferences
      .projectsFor(machineId)
      .findIndex((item) => item.cwd === project.cwd);
    if (action === "hide")
      this.#launchPreferences.hideProject(machineId, project.cwd);
    else this.#launchPreferences.removeProject(machineId, project.cwd);
    // The footer's status line stays in view wherever the row was.
    setText(
      this.#spawnStatus,
      action === "hide"
        ? `${project.project} is hidden. Unhide it in Settings > Projects.`
        : `${project.project} was removed from this device's list. It comes back only if you start a new session in that directory.`,
    );
    this.#renderProjects();
    // The row is gone: focus the same action on the row that took its place,
    // or the directory field once no remembered project is left.
    const remaining = this.#launchPreferences.projectsFor(machineId);
    const next = remaining[Math.min(index, remaining.length - 1)];
    const nextRow = next && this.#managedRows.get(next.cwd);
    if (nextRow) (action === "hide" ? nextRow.hide : nextRow.remove).focus();
    else this.#cwd.focus();
  }

  #setManaging(on: boolean): void {
    this.#managing = on;
    setText(this.#manageProjects, on ? "Done" : "Manage");
    this.#manageProjects.setAttribute("aria-expanded", String(on));
    this.#managedList.hidden = !on;
  }

  /** Where Start runs: the chosen remembered project, else the typed directory. */
  #chosenCwd(): string {
    const draft = this.#directoryDrafts.get(this.#selectedMachineId);
    return draft ? draft.projectCwd || draft.cwd.trim() : "";
  }

  /** Open Past sessions for the chosen project, asking its machine afresh; or close it. */
  #togglePast(): void {
    const history = this.#handlers.history;
    const cwd = this.#chosenCwd();
    if (this.#spawning || !history) return;
    if (this.#past !== undefined || !cwd) {
      this.#past = undefined;
    } else {
      const machineId = this.#selectedMachineId;
      this.#past = { machineId, cwd, sent: history.request(machineId, cwd) };
    }
    this.#drawnPast = undefined;
    this.#syncPast();
  }

  /**
   * Draw Past sessions and resume for the chosen machine and project. Either
   * one belongs to the project it was opened for, so choosing another closes
   * the list and leaves resume. Resume hides the model (omp restores the
   * stored session's own) and turns Start into Resume.
   */
  #syncPast(): void {
    const history = this.#handlers.history;
    const machineId = this.#selectedMachineId;
    const cwd = this.#chosenCwd();
    const moved = (at: { machineId: string; cwd: string } | undefined) =>
      at !== undefined && (at.machineId !== machineId || at.cwd !== cwd);
    if (moved(this.#past)) this.#past = undefined;
    if (moved(this.#resume)) this.#resume = undefined;

    const chosen = this.#chosenMachine();
    this.#pastToggle.hidden = history === undefined;
    this.#pastToggle.disabled =
      !cwd || chosen === undefined || chosen.offline === true;
    const resume = this.#resume;
    this.#modelGroup.hidden = resume !== undefined;
    this.#resumeNote.hidden = resume === undefined;
    if (resume)
      setText(
        this.#resumeCopy,
        `Resumes “${resume.title}”, last active ${resume.ago}. It keeps its own model.`,
      );
    const label = this.#spawnButton.querySelector<HTMLElement>(".button-label");
    if (label)
      setText(label, resume === undefined ? "Start session" : "Resume session");

    const past = this.#past;
    this.#pastToggle.setAttribute("aria-expanded", String(past !== undefined));
    this.#pastPanel.hidden = past === undefined;
    if (past === undefined || history === undefined) return;
    const entries = past.sent
      ? history.entries(past.machineId, past.cwd)
      : undefined;
    this.#pastPanel.setAttribute(
      "aria-busy",
      String(past.sent && entries === undefined),
    );
    setText(
      this.#pastStatus,
      !past.sent
        ? "Couldn't reach this machine. Check the connection, then try again."
        : entries === undefined
          ? "Loading past sessions…"
          : entries.length === 0
            ? "No past sessions in this project."
            : "",
    );
    this.#pastStatus.hidden = this.#pastStatus.textContent === "";
    // A list still loading is empty, never the last project's.
    if (entries !== undefined && entries === this.#drawnPast) return;
    this.#drawnPast = entries;
    const now = Date.now();
    const rows = (entries ?? []).map((entry) => {
      // Untitled: the id's first characters name it.
      const title = entry.title?.trim() || entry.sessionId.slice(0, 8);
      const ago = timeAgo(entry.lastActiveAt, now);
      const row = button(title, "button model-picker-option spawn-past-entry");
      row.append(element("span", "model-picker-option-detail", ago));
      row.setAttribute("aria-label", `${title}, last active ${ago}`);
      row.addEventListener("click", () => {
        if (this.#spawning) return;
        this.#resume = {
          machineId: past.machineId,
          cwd: past.cwd,
          sessionId: entry.sessionId,
          title,
          ago,
        };
        this.#past = undefined;
        this.#syncPast();
        // Approval mode is the one choice still to confirm.
        this.#spawnApproval.select.focus();
      });
      const item = element("li", "spawn-past-item");
      item.append(row);
      return item;
    });
    this.#pastList.replaceChildren(...rows);
    this.#pastList.hidden = rows.length === 0;
  }

  /**
   * Show the chosen machine's last-known catalog in the picker, or only the
   * model id field when this device has none saved for it. `reset` returns the
   * picker to its root list; otherwise it redraws only on a change.
   */
  #syncModel(reset = false): void {
    const catalog = this.#tree.find(
      (machine) => machine.machineId === this.#selectedMachineId,
    )?.catalog;
    const model = this.#model.value.trim();
    if (!reset && catalog === this.#shownCatalog && model === this.#shownModel)
      return;
    this.#shownCatalog = catalog;
    this.#shownModel = model;
    this.#modelPicker.node.hidden = catalog === undefined;
    setText(
      this.#modelHint,
      catalog
        ? "Pick a role or model above, or type a model id. Leave it empty for the host default."
        : "This device has no model list for this machine yet; it saves one when a session there reports its models. Type a model id, or leave it empty for the host default.",
    );
    if (!catalog) return;
    this.#modelPicker.setCatalog({
      models: catalog.models,
      roles: catalog.roles,
      currentId: model || undefined,
    });
    if (reset) this.#modelPicker.reset();
    else this.#modelPicker.render();
  }

  #pickModel(pick: ModelPick): void {
    if (this.#spawning) return;
    switch (pick.kind) {
      case "default":
        this.#model.value = "";
        break;
      case "role": {
        this.#model.value = pick.role.modelId;
        // A role carries its own effort: start there when omp accepts that level.
        const effort = SpawnThinkingLevel.safeParse(pick.role.effort);
        if (effort.success) this.#spawnEffort.set(effort.data);
        break;
      }
      case "model":
        this.#model.value = pick.model.id;
        break;
      case "effort":
        // Not offered here.
        return;
    }
    this.#syncModel(true);
  }

  #syncSpawnControls(): void {
    const chosen = this.#chosenMachine();
    this.#spawnMachine.select.disabled =
      this.#spawning || this.#tree.length === 0;
    this.#projectGroup.disabled = this.#spawning || chosen === undefined;
    this.#modelGroup.disabled = this.#spawning;
    this.#spawnEffort.select.disabled = this.#spawning;
    this.#spawnApproval.select.disabled = this.#spawning;
    this.#resumeCancel.disabled = this.#spawning;
    // The relay drops a spawn for a machine it does not list.
    this.#spawnButton.disabled =
      this.#spawning || chosen === undefined || chosen.offline === true;
  }

  #updateApprovalHint(): void {
    setText(
      this.#spawnApproval.hint,
      this.#spawnApproval.value === "yolo"
        ? "Tools run without approval. Applies to this session only."
        : "Applies to this session only; your Settings default stays unchanged.",
    );
  }

  #buildSettings(): void {
    this.#preferenceStatus.setAttribute("role", "status");
    this.#sendMode.set(this.#preferences.mode);
    const models = element("fieldset", "settings-fieldset");
    models.append(
      element("legend", "field-label", "Default model"),
      this.#defaultModels,
      this.#defaultModelsEmpty,
    );
    this.#defaultEffort.set(this.#launchPreferences.defaultEffort ?? "");
    this.#defaultApproval.set(this.#launchPreferences.approvalMode);
    this.#launchPreferenceStatus.setAttribute("role", "status");
    const launch = settingsSection("New sessions");
    launch.append(
      element(
        "p",
        "section-copy",
        "New session starts with these. You can change any of them for one session before starting it.",
      ),
      this.#defaultMachine.node,
      models,
      this.#defaultEffort.node,
      this.#defaultApproval.node,
      this.#launchPreferenceStatus,
      // The default send action lives with the other defaults, in one place.
      this.#sendMode.node,
      this.#preferenceStatus,
    );

    const projects = settingsSection("Projects");
    const defaults = element("fieldset", "settings-fieldset");
    defaults.append(
      element("legend", "field-label", "Default project"),
      this.#defaultProjects,
      this.#defaultProjectsEmpty,
    );
    this.#hiddenHeading.id = uniqueId("hidden-projects");
    // Focus lands here once the last hidden project is unhidden.
    this.#hiddenHeading.tabIndex = -1;
    this.#hiddenList.setAttribute("aria-labelledby", this.#hiddenHeading.id);
    this.#projectsStatus.setAttribute("role", "status");
    projects.append(
      element(
        "p",
        "section-copy",
        "New session starts in a machine's default project. Hiding or removing that project clears it.",
      ),
      defaults,
      this.#hiddenHeading,
      element(
        "p",
        "section-copy",
        "Projects you hide in New session are listed here. Unhide one to list it there again.",
      ),
      this.#hiddenList,
      this.#hiddenEmpty,
      this.#projectsStatus,
    );
    const pairTitle = element("h4", "settings-subtitle", "Pair a machine");
    pairTitle.id = uniqueId("pair");
    this.#pairForm.setAttribute("aria-labelledby", pairTitle.id);
    const instructions = element(
      "p",
      "section-copy",
      "Enter the pairing code shown by the host agent on your machine. Keep the host visible to compare the verification code.",
    );
    this.#pairCode.placeholder = "Enter pairing code";
    this.#pairCode.autocomplete = "off";
    this.#pairCode.autocapitalize = "off";
    this.#pairCode.spellcheck = false;
    this.#pairCode.required = true;
    this.#pairButton.type = "submit";
    this.#pairForm.append(
      pairTitle,
      instructions,
      field("Pairing code", this.#pairCode),
      this.#pairButton,
      this.#pairStatus,
    );
    this.#pairForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#pair();
    });
    // Machines first, then pairing another one, in the same section.
    this.#machineSettings.node.append(this.#pairForm);
    this.settings.body.append(
      this.#accountSettings.node,
      this.#machineSettings.node,
      projects,
      launch,
      this.#chatSettings.node,
      ...(this.#notificationSettings ? [this.#notificationSettings.node] : []),
      ...(this.#appearanceSettings ? [this.#appearanceSettings.node] : []),
      this.#aboutSettings.node,
    );
  }

  #buildAbout(): void {
    const protection = element("section", "settings-section");
    const facts = element("dl", "security-facts");
    for (const { label, description } of DATA_PROTECTION) {
      facts.append(
        element("dt", "security-label", label),
        element("dd", "security-description", description),
      );
    }
    protection.append(
      element("h3", "section-title", "How your data is protected"),
      facts,
    );
    const back = button("Back to settings", "button secondary");
    back.addEventListener("click", () => this.about.node.close());
    const actions = element("div", "dialog-actions");
    actions.append(back);
    this.about.body.append(protection, actions);
  }

  /** Machines Settings offers defaults for: the workspace's, then those paired here but offline. */
  #settingsMachines(): { machineId: string; label: string }[] {
    const machines = this.#tree.map(({ machineId, label }) => ({
      machineId,
      label,
    }));
    const listed = new Set(machines.map((machine) => machine.machineId));
    for (const [machineId, label] of this.#handlers.pairedMachines?.() ?? [])
      if (!listed.has(machineId)) machines.push({ machineId, label });
    return machines;
  }

  /**
   * Settings > New sessions: the default machine's options and each machine's
   * default model. `reset` (Settings opening) shows what is saved and returns
   * each picker to its root list; otherwise a row redraws only on a change.
   */
  #renderLaunchDefaults(reset = false): void {
    const machines = this.#settingsMachines();
    this.#defaultMachine.setChoices([
      { value: "", label: "No default" },
      ...machines.map(({ machineId, label }) => ({ value: machineId, label })),
    ]);
    this.#defaultMachine.set(this.#launchPreferences.defaultMachine ?? "");

    const ids = new Set<string>();
    const rows: HTMLElement[] = [];
    for (const { machineId, label } of machines) {
      ids.add(machineId);
      let row = this.#defaultModelRows.get(machineId);
      const created = row === undefined;
      if (!row) {
        row = this.#defaultModelRow(machineId);
        this.#defaultModelRows.set(machineId, row);
      }
      setText(row.caption, label);
      if (reset || created)
        row.input.value = this.#launchPreferences.defaultModel(machineId);
      this.#syncDefaultModel(row, reset || created);
      rows.push(row.node);
    }
    for (const id of this.#defaultModelRows.keys()) {
      if (!ids.has(id)) this.#defaultModelRows.delete(id);
    }
    syncChildren(this.#defaultModels, rows);
    this.#defaultModelsEmpty.hidden = rows.length > 0;
  }

  #defaultModelRow(machineId: string): DefaultModelRow {
    const node = element("fieldset", "spawn-group default-model");
    const head = element("div", "spawn-group-head");
    const caption = element("span", "field-label");
    caption.id = uniqueId("default-model");
    node.setAttribute("aria-labelledby", caption.id);
    head.append(caption);
    const input = element("input", "default-model-input");
    input.placeholder = "Leave empty for omp's default";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.autocapitalize = "off";
    const picker = new ModelPicker({
      heading: "h4",
      rootTitle: "Model",
      effort: false,
      defaultLabel: "omp default",
      onPick: (pick) => {
        const model = pickedModel(pick);
        if (model === undefined) return;
        input.value = model;
        this.#saveDefaultModel(row, true);
        this.#syncDefaultModel(row, true);
      },
    });
    picker.node.classList.add("is-inline");
    const hint = element("p", "field-hint");
    hint.id = uniqueId("model-hint");
    input.setAttribute("aria-describedby", hint.id);
    const modelField = field("Model id", input);
    modelField.append(hint);
    node.append(head, picker.node, modelField);
    const row: DefaultModelRow = {
      machineId,
      node,
      caption,
      picker,
      input,
      hint,
      shownCatalog: undefined,
      shownModel: "",
    };
    // Saved as typed; announced once the field is left.
    input.addEventListener("input", () => {
      this.#saveDefaultModel(row, false);
      this.#syncDefaultModel(row);
    });
    input.addEventListener("change", () => this.#saveDefaultModel(row, true));
    return row;
  }

  #saveDefaultModel(row: DefaultModelRow, announce: boolean): void {
    const saved = this.#launchPreferences.setDefaultModel(
      row.machineId,
      row.input.value,
    );
    if (!announce) return;
    const model = this.#launchPreferences.defaultModel(row.machineId);
    const machine = row.caption.textContent ?? row.machineId;
    setText(
      this.#launchPreferenceStatus,
      savedOutcome(
        saved,
        model
          ? `New sessions on ${machine} start with ${model}.`
          : `New sessions on ${machine} start with omp's default model.`,
      ),
    );
  }

  /** Like New session's model group: the machine's cached catalog in the picker, or only the id field. */
  #syncDefaultModel(row: DefaultModelRow, reset = false): void {
    const catalog = this.#tree.find(
      (machine) => machine.machineId === row.machineId,
    )?.catalog;
    const model = row.input.value.trim();
    if (!reset && catalog === row.shownCatalog && model === row.shownModel)
      return;
    row.shownCatalog = catalog;
    row.shownModel = model;
    row.picker.node.hidden = catalog === undefined;
    setText(
      row.hint,
      catalog
        ? "Pick a role or model above, or type a model id. Leave it empty for omp's default."
        : "This device has no model list for this machine yet; it saves one when a session there reports its models. Type a model id, or leave it empty for omp's default.",
    );
    if (!catalog) return;
    row.picker.setCatalog({
      models: catalog.models,
      roles: catalog.roles,
      currentId: model || undefined,
    });
    if (reset) row.picker.reset();
    else row.picker.render();
  }

  /** Settings > Projects: the project New session starts in, for each machine with remembered projects. */
  #renderDefaultProjects(): void {
    const ids = new Set<string>();
    const rows: HTMLElement[] = [];
    for (const { machineId, label } of this.#settingsMachines()) {
      const projects = this.#launchPreferences.projectsFor(machineId);
      if (projects.length === 0) continue;
      ids.add(machineId);
      let row = this.#defaultProjectRows.get(machineId);
      if (!row) {
        row = this.#defaultProjectRow(machineId);
        this.#defaultProjectRows.set(machineId, row);
      }
      setText(row.dropdown.label, label);
      if (row.projects !== projects) {
        row.projects = projects;
        row.dropdown.setChoices([
          { value: "", label: "None" },
          ...projects.map((project) => ({
            value: project.cwd,
            label: `${project.project} · ${project.cwd}`,
          })),
        ]);
      }
      row.dropdown.set(this.#launchPreferences.defaultProject(machineId) ?? "");
      rows.push(row.dropdown.node);
    }
    for (const id of this.#defaultProjectRows.keys()) {
      if (!ids.has(id)) this.#defaultProjectRows.delete(id);
    }
    syncChildren(this.#defaultProjects, rows);
    this.#defaultProjects.hidden = rows.length === 0;
    this.#defaultProjectsEmpty.hidden = rows.length > 0;
  }

  #defaultProjectRow(machineId: string): DefaultProjectRow {
    const control = dropdown<string>({
      label: machineId,
      choices: [],
      onChange: (value) => {
        const cwd = value || undefined;
        const saved = this.#launchPreferences.setDefaultProject(machineId, cwd);
        const project = this.#launchPreferences
          .projectsFor(machineId)
          .find((item) => item.cwd === cwd);
        const machine = control.label.textContent ?? machineId;
        setText(
          this.#projectsStatus,
          savedOutcome(
            saved,
            project
              ? `New session on ${machine} starts in ${project.project}.`
              : `New session on ${machine} starts in the project you chose last.`,
          ),
        );
      },
    });
    return { dropdown: control, projects: undefined };
  }

  /** Settings > Projects: every hidden project, labelled with its machine. */
  #renderHiddenProjects(): void {
    const labels = new Map(this.#handlers.pairedMachines?.() ?? []);
    for (const machine of this.#tree)
      labels.set(machine.machineId, machine.label);
    const hidden = this.#launchPreferences
      .hiddenProjects()
      .map((item) => ({
        ...item,
        machine: labels.get(item.machineId) ?? item.machineId,
      }))
      .sort(
        (a, b) =>
          a.machine.localeCompare(b.machine) ||
          a.project.localeCompare(b.project) ||
          a.cwd.localeCompare(b.cwd),
      );
    const keys = new Set<string>();
    const rows: HTMLElement[] = [];
    for (const item of hidden) {
      const key = `${item.machineId}\n${item.cwd}`;
      keys.add(key);
      let row = this.#hiddenRows.get(key);
      if (!row) {
        row = this.#hiddenProjectRow(item.machineId, item.cwd);
        this.#hiddenRows.set(key, row);
      }
      row.project = item.project;
      setText(row.name, item.project);
      setText(row.meta, `${item.machine} · ${item.cwd}`);
      const label = `Unhide ${item.project} on ${item.machine}`;
      if (row.unhide.getAttribute("aria-label") !== label)
        row.unhide.setAttribute("aria-label", label);
      rows.push(row.node);
    }
    for (const key of this.#hiddenRows.keys()) {
      if (!keys.has(key)) this.#hiddenRows.delete(key);
    }
    syncChildren(this.#hiddenList, rows);
    this.#hiddenList.hidden = rows.length === 0;
    this.#hiddenEmpty.hidden = rows.length > 0;
  }

  #hiddenProjectRow(machineId: string, cwd: string): HiddenProjectRow {
    const unhide = button("Unhide", "button secondary");
    const { node, name, meta } = listedProject(unhide);
    const row: HiddenProjectRow = { node, name, meta, unhide, project: "" };
    unhide.addEventListener("click", () => {
      const index = [...this.#hiddenList.children].indexOf(node);
      this.#launchPreferences.unhideProject(machineId, cwd);
      setText(
        this.#projectsStatus,
        `${row.project} is listed in New session again.`,
      );
      this.#renderHiddenProjects();
      this.#renderDefaultProjects();
      this.#renderProjects();
      // The row is gone: focus the next Unhide, or the section once none are left.
      const rest = this.#hiddenList.children;
      const next = rest
        .item(Math.min(index, rest.length - 1))
        ?.querySelector<HTMLButtonElement>("button");
      (next ?? this.#hiddenHeading).focus();
    });
    return row;
  }

  #buildSpawn(): void {
    const form = this.#spawnForm;
    form.id = uniqueId("spawn-form");

    // Says why Start waits; announced as it appears.
    this.#spawnMachine.hint.setAttribute("role", "status");

    // Manage sits on the Project row's label line and lists the remembered
    // projects under the dropdown, each with Hide and Remove.
    this.#manageProjects.type = "button";
    this.#manageProjects.title = "Hide or remove remembered projects";
    this.#managedList.id = uniqueId("managed-projects");
    this.#managedList.setAttribute("aria-label", "Remembered projects");
    this.#manageProjects.setAttribute("aria-controls", this.#managedList.id);
    this.#manageProjects.addEventListener("click", () =>
      this.#setManaging(!this.#managing),
    );
    this.#setManaging(false);
    this.#spawnProject.label.after(this.#manageProjects);
    this.#cwd.placeholder = "Absolute path on the host machine";
    this.#cwd.spellcheck = false;
    this.#cwd.autocomplete = "off";
    this.#cwd.autocapitalize = "off";
    this.#cwd.addEventListener("input", () => {
      const draft = this.#directoryDrafts.get(this.#selectedMachineId);
      if (!this.#spawning && draft) draft.cwd = this.#cwd.value;
      this.#syncPast();
    });
    // Past sessions sits under the directory: the chosen project's stored
    // sessions, each one a tap from resuming it.
    this.#pastPanel.id = uniqueId("past-sessions");
    this.#pastToggle.setAttribute("aria-controls", this.#pastPanel.id);
    this.#pastToggle.title = "Resume a stored session of this project";
    this.#pastToggle.addEventListener("click", () => this.#togglePast());
    this.#pastStatus.setAttribute("role", "status");
    this.#pastList.setAttribute("aria-label", "Past sessions");
    this.#pastPanel.append(this.#pastStatus, this.#pastList);
    this.#resumeCancel.addEventListener("click", () => {
      this.#resume = undefined;
      this.#syncPast();
      this.#pastToggle.focus();
    });
    this.#resumeCopy.setAttribute("aria-live", "polite");
    this.#resumeNote.append(this.#resumeCopy, this.#resumeCancel);
    this.#projectGroup.append(
      this.#spawnProject.node,
      this.#managedList,
      this.#cwdField,
      this.#pastToggle,
      this.#pastPanel,
    );

    const modelHead = element("div", "spawn-group-head");
    const modelCaption = element("span", "field-label", "Model (optional)");
    modelCaption.id = uniqueId("spawn-group");
    modelHead.append(modelCaption);
    this.#modelGroup.setAttribute("aria-labelledby", modelCaption.id);
    this.#modelPicker.node.classList.add("is-inline");
    this.#model.placeholder = "Leave empty for the default";
    this.#model.spellcheck = false;
    this.#model.autocomplete = "off";
    this.#model.autocapitalize = "off";
    this.#model.addEventListener("input", () => this.#syncModel());
    const modelField = field("Model id", this.#model);
    this.#modelHint.id = uniqueId("model-hint");
    this.#model.setAttribute("aria-describedby", this.#modelHint.id);
    modelField.append(this.#modelHint);
    this.#modelGroup.append(modelHead, this.#modelPicker.node, modelField);

    this.#spawnEffort.set(this.#launchPreferences.defaultEffort ?? "");
    this.#spawnApproval.set(this.#launchPreferences.approvalMode);
    this.#updateApprovalHint();

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#start();
    });
    form.append(
      element(
        "p",
        "section-copy",
        "Start OMP on a machine in your workspace. The session appears once the host reports it.",
      ),
      this.#spawnMachine.node,
      this.#projectGroup,
      this.#resumeNote,
      this.#modelGroup,
      this.#spawnEffort.node,
      this.#spawnApproval.node,
    );
    this.spawn.body.append(form);

    // The footer stays in view under the scrolling body, so Start session and
    // Cancel are always reachable, even with the keyboard up.
    this.#spawnStatus.setAttribute("role", "status");
    const cancel = button("Cancel", "button secondary");
    cancel.addEventListener("click", () => this.spawn.node.close());
    this.#spawnButton.type = "submit";
    this.#spawnButton.setAttribute("form", form.id);
    const actions = element("div", "dialog-actions");
    actions.append(cancel, this.#spawnButton);
    const footer = element("footer", "dialog-footer");
    footer.append(this.#spawnStatus, actions);
    this.spawn.node.append(footer);
  }

  async #pair(): Promise<void> {
    const pair = this.#handlers.onPair;
    const code = this.#pairCode.value.trim();
    if (this.#pairing || !pair || !code) return;
    this.#pairing = true;
    this.#pairButton.disabled = true;
    this.#pairCode.readOnly = true;
    this.#pairForm.setAttribute("aria-busy", "true");
    try {
      await pair(code);
    } catch {
      this.#pairStatus.textContent =
        "Pairing failed. Check the code and try again.";
    } finally {
      this.#pairing = false;
      this.#pairButton.disabled = false;
      this.#pairCode.readOnly = false;
      this.#pairForm.removeAttribute("aria-busy");
    }
  }

  async #start(): Promise<void> {
    const machineId = this.#selectedMachineId;
    const draft = this.#directoryDrafts.get(machineId);
    const cwd = this.#chosenCwd();
    const chosen = this.#chosenMachine();
    if (
      this.#spawning ||
      !cwd ||
      chosen === undefined ||
      chosen.offline === true
    )
      return;
    const approvalMode = this.#spawnApproval.value ?? "always-ask";
    const thinkingLevel = this.#spawnEffort.value || undefined;
    const resume = this.#resume?.sessionId;
    // A resume sends no model: omp restores the stored session's own.
    const opts: SpawnOptions =
      resume === undefined
        ? {
            cwd,
            model: this.#model.value.trim() || undefined,
            thinkingLevel,
            approvalMode,
          }
        : { cwd, thinkingLevel, approvalMode, resume };
    const spawn = this.#handlers.onSpawn;
    this.#spawning = true;
    this.#syncSpawnControls();
    this.spawn.body.setAttribute("aria-busy", "true");
    this.#spawnStatus.textContent =
      resume === undefined
        ? "Starting… A passkey check may be needed."
        : "Resuming… A passkey check may be needed.";
    try {
      const sent = await spawn(machineId, opts);
      if (sent) {
        this.#launchPreferences.rememberProject(machineId, cwd);
        // A custom directory is a remembered project now: offer it as one.
        if (
          draft &&
          this.#launchPreferences
            .projectsFor(machineId)
            .some((project) => project.cwd === cwd)
        ) {
          draft.projectCwd = cwd;
          draft.cwd = "";
        }
        this.#resume = undefined;
        this.#renderProjects();
        this.#spawnStatus.textContent = "";
        this.spawn.node.close();
      } else {
        this.#spawnStatus.textContent =
          "Not started. Your settings are still here. Confirm your passkey and check the connection.";
      }
    } catch {
      this.#spawnStatus.textContent =
        "Could not start a session. Your settings are still here; try again.";
    } finally {
      this.#spawning = false;
      this.#syncSpawnControls();
      this.spawn.body.removeAttribute("aria-busy");
    }
  }
}
