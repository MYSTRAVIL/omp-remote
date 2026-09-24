import { ApprovalMode, SpawnThinkingLevel } from "@omp-remote/protocol";
import { z } from "zod";
import type { MachineNode } from "./session-tree";

export interface KnownProject {
  cwd: string;
  project: string;
}

export interface HiddenProject extends KnownProject {
  machineId: string;
}

const APPROVAL_KEY = "omp-remote.launch.approval-mode";
const PROJECTS_KEY = "omp-remote.launch.projects";
const REMOVED_KEY = "omp-remote.launch.removed-projects";
const HIDDEN_KEY = "omp-remote.launch.hidden-projects";
const MACHINE_KEY = "omp-remote.launch.default-machine";
const EFFORT_KEY = "omp-remote.launch.default-effort";
const MODELS_KEY = "omp-remote.launch.default-models";
const DEFAULT_PROJECTS_KEY = "omp-remote.launch.default-projects";
const StoredProjects = z.array(
  z.object({
    machineId: z.string().min(1),
    cwd: z.string().min(1),
    project: z.string().min(1),
  }),
);
/** Removed projects: `cutoff` is the newest session start (host clock) seen in that directory at removal. */
const StoredRemoved = z.array(
  z.object({
    machineId: z.string().min(1),
    cwd: z.string().min(1),
    cutoff: z.number(),
  }),
);
const StoredHidden = z.array(
  z.object({ machineId: z.string().min(1), cwd: z.string().min(1) }),
);
/** One value per machine: its default model id, or its default project's cwd. */
const StoredPerMachine = z.record(z.string().min(1), z.string().min(1));
const NO_PROJECTS: readonly KnownProject[] = [];

/**
 * Browser-local launch defaults and previously seen projects, scoped by
 * machine. Each key loads on its own, so denied storage or one malformed value
 * only resets that preference; without storage every choice lasts this page load.
 */
export class LaunchPreferences {
  #approvalMode: ApprovalMode =
    load(APPROVAL_KEY, ApprovalMode) ?? "always-ask";
  #defaultMachine = load(MACHINE_KEY, z.string().min(1));
  #defaultEffort = load(EFFORT_KEY, SpawnThinkingLevel);
  /** Model id new sessions start with, by machine; absent for the host default. */
  readonly #defaultModels = new Map(
    Object.entries(load(MODELS_KEY, StoredPerMachine) ?? {}),
  );
  /** The project directory New session preselects, by machine. */
  readonly #defaultProjects = new Map(
    Object.entries(load(DEFAULT_PROJECTS_KEY, StoredPerMachine) ?? {}),
  );
  readonly #projects = new Map<string, Map<string, KnownProject>>();
  readonly #sorted = new Map<string, readonly KnownProject[]>();
  /** Removed projects by machine, then cwd, to their cutoff. */
  readonly #removed = new Map<string, Map<string, number>>();
  /** Hidden project directories by machine. */
  readonly #hidden = new Map<string, Set<string>>();
  /** Newest session start per machine and cwd in the last observed tree. */
  #latestStart = new Map<string, Map<string, number>>();

  constructor() {
    for (const item of load(PROJECTS_KEY, StoredProjects) ?? [])
      this.#addProject(item.machineId, item.cwd, item.project);
    for (const item of load(REMOVED_KEY, StoredRemoved) ?? [])
      nested(this.#removed, item.machineId).set(item.cwd, item.cutoff);
    for (const item of load(HIDDEN_KEY, StoredHidden) ?? []) {
      let hidden = this.#hidden.get(item.machineId);
      if (!hidden) {
        hidden = new Set();
        this.#hidden.set(item.machineId, hidden);
      }
      hidden.add(item.cwd);
    }
  }

  get approvalMode(): ApprovalMode {
    return this.#approvalMode;
  }

  setApprovalMode(mode: ApprovalMode): boolean {
    this.#approvalMode = mode;
    return save(APPROVAL_KEY, mode);
  }

  /** The machine New session preselects when opened without one; undefined for none. */
  get defaultMachine(): string | undefined {
    return this.#defaultMachine;
  }

  setDefaultMachine(machineId: string | undefined): boolean {
    this.#defaultMachine = machineId;
    return save(MACHINE_KEY, machineId);
  }

  /** The thinking level new sessions start at; undefined leaves it to omp. */
  get defaultEffort(): SpawnThinkingLevel | undefined {
    return this.#defaultEffort;
  }

  setDefaultEffort(level: SpawnThinkingLevel | undefined): boolean {
    this.#defaultEffort = level;
    return save(EFFORT_KEY, level);
  }

  /** The model id new sessions on a machine start with; "" for the host default. */
  defaultModel(machineId: string): string {
    return this.#defaultModels.get(machineId) ?? "";
  }

  setDefaultModel(machineId: string, model: string): boolean {
    const id = model.trim();
    if (id) this.#defaultModels.set(machineId, id);
    else this.#defaultModels.delete(machineId);
    return save(MODELS_KEY, Object.fromEntries(this.#defaultModels));
  }

  /**
   * The remembered project New session preselects on a machine. Hiding or
   * removing that project clears it, so it is always one listed there.
   */
  defaultProject(machineId: string): string | undefined {
    const cwd = this.#defaultProjects.get(machineId);
    return this.projectsFor(machineId).some((project) => project.cwd === cwd)
      ? cwd
      : undefined;
  }

  /** Choose one of the machine's listed projects, or none with `undefined`. */
  setDefaultProject(machineId: string, cwd: string | undefined): boolean {
    if (cwd === undefined) this.#defaultProjects.delete(machineId);
    else this.#defaultProjects.set(machineId, cwd);
    return save(
      DEFAULT_PROJECTS_KEY,
      Object.fromEntries(this.#defaultProjects),
    );
  }

  /** Drop a forgotten machine's launch defaults: its default model and
   *  project, and its place as the default machine. */
  forgetMachine(machineId: string): void {
    if (this.#defaultModels.delete(machineId))
      save(MODELS_KEY, Object.fromEntries(this.#defaultModels));
    if (this.#defaultProjects.delete(machineId))
      save(DEFAULT_PROJECTS_KEY, Object.fromEntries(this.#defaultProjects));
    if (this.#defaultMachine === machineId) this.setDefaultMachine(undefined);
  }

  /**
   * Learn projects from the live session tree. A removed project stays removed
   * until a session newer than its removal cutoff runs in that directory.
   */
  observeProjects(tree: readonly MachineNode[]): void {
    let changed = false;
    let restored = false;
    const latest = new Map<string, Map<string, number>>();
    for (const machine of tree) {
      const removed = this.#removed.get(machine.machineId);
      const starts = nested(latest, machine.machineId);
      for (const group of machine.projects) {
        for (const session of group.sessions) {
          starts.set(
            session.cwd,
            Math.max(starts.get(session.cwd) ?? 0, session.startedAt),
          );
          const cutoff = removed?.get(session.cwd);
          if (cutoff !== undefined) {
            if (session.startedAt <= cutoff) continue;
            removed?.delete(session.cwd);
            restored = true;
          }
          if (this.#addProject(machine.machineId, session.cwd, session.project))
            changed = true;
        }
      }
    }
    this.#latestStart = latest;
    if (changed) this.#persistProjects();
    if (restored) this.#persistRemoved();
  }

  /** Remembered projects on a machine, excluding hidden ones, sorted by name. */
  projectsFor(machineId: string): readonly KnownProject[] {
    const cached = this.#sorted.get(machineId);
    if (cached) return cached;
    const projects = this.#projects.get(machineId);
    if (!projects) return NO_PROJECTS;
    const hidden = this.#hidden.get(machineId);
    const sorted = [...projects.values()]
      .filter((project) => !hidden?.has(project.cwd))
      .sort(byName);
    this.#sorted.set(machineId, sorted);
    return sorted;
  }

  /** Remember a directory this device started a session in; this undoes an earlier removal. */
  rememberProject(machineId: string, cwd: string): void {
    const project =
      cwd
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() || cwd;
    if (this.#removed.get(machineId)?.delete(cwd)) this.#persistRemoved();
    if (this.#addProject(machineId, cwd, project)) this.#persistProjects();
  }

  /**
   * Delete a remembered project from this device's list. Sessions already
   * running there do not bring it back; a session started there later does.
   * It stops being the machine's default project.
   */
  removeProject(machineId: string, cwd: string): void {
    const projects = this.#projects.get(machineId);
    if (!projects?.delete(cwd)) return;
    this.#sorted.delete(machineId);
    nested(this.#removed, machineId).set(
      cwd,
      this.#latestStart.get(machineId)?.get(cwd) ?? 0,
    );
    if (this.#hidden.get(machineId)?.delete(cwd)) this.#persistHidden();
    this.#persistProjects();
    this.#persistRemoved();
    this.#dropDefaultProject(machineId, cwd);
  }

  /**
   * Keep a project remembered but out of the new-session list until unhidden.
   * It stops being the machine's default project; unhiding does not restore that.
   */
  hideProject(machineId: string, cwd: string): void {
    if (!this.#projects.get(machineId)?.has(cwd)) return;
    let hidden = this.#hidden.get(machineId);
    if (!hidden) {
      hidden = new Set();
      this.#hidden.set(machineId, hidden);
    }
    if (hidden.has(cwd)) return;
    hidden.add(cwd);
    this.#sorted.delete(machineId);
    this.#persistHidden();
    this.#dropDefaultProject(machineId, cwd);
  }

  unhideProject(machineId: string, cwd: string): void {
    if (!this.#hidden.get(machineId)?.delete(cwd)) return;
    this.#sorted.delete(machineId);
    this.#persistHidden();
  }

  /** Every hidden project that is still remembered, by machine then name. */
  hiddenProjects(): readonly HiddenProject[] {
    const result: HiddenProject[] = [];
    for (const [machineId, hidden] of this.#hidden) {
      const projects = this.#projects.get(machineId);
      for (const cwd of hidden) {
        const project = projects?.get(cwd);
        if (project) result.push({ machineId, ...project });
      }
    }
    return result.sort(
      (a, b) => a.machineId.localeCompare(b.machineId) || byName(a, b),
    );
  }

  #addProject(machineId: string, cwd: string, project: string): boolean {
    if (!machineId || !cwd || !project) return false;
    let projects = this.#projects.get(machineId);
    if (projects?.has(cwd)) return false;
    if (!projects) {
      projects = new Map();
      this.#projects.set(machineId, projects);
    }
    projects.set(cwd, { cwd, project });
    this.#sorted.delete(machineId);
    return true;
  }

  #dropDefaultProject(machineId: string, cwd: string): void {
    if (this.#defaultProjects.get(machineId) === cwd)
      this.setDefaultProject(machineId, undefined);
  }

  #persistProjects(): void {
    const stored: HiddenProject[] = [];
    for (const [machineId, projects] of this.#projects)
      for (const project of projects.values())
        stored.push({ machineId, ...project });
    save(PROJECTS_KEY, stored);
  }

  #persistRemoved(): void {
    const stored: z.infer<typeof StoredRemoved> = [];
    for (const [machineId, removed] of this.#removed)
      for (const [cwd, cutoff] of removed)
        stored.push({ machineId, cwd, cutoff });
    save(REMOVED_KEY, stored);
  }

  #persistHidden(): void {
    const stored: z.infer<typeof StoredHidden> = [];
    for (const [machineId, hidden] of this.#hidden)
      for (const cwd of hidden) stored.push({ machineId, cwd });
    save(HIDDEN_KEY, stored);
  }
}

/** A stored value, or undefined when it is absent, malformed, or storage is denied. */
function load<T>(key: string, schema: z.ZodType<T>): T | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Write a key, or remove it for `undefined`; false when storage is unavailable. */
function save(key: string, value: unknown): boolean {
  try {
    if (value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function byName(a: KnownProject, b: KnownProject): number {
  return a.project.localeCompare(b.project) || a.cwd.localeCompare(b.cwd);
}

function nested<V>(
  outer: Map<string, Map<string, V>>,
  key: string,
): Map<string, V> {
  let inner = outer.get(key);
  if (!inner) {
    inner = new Map();
    outer.set(key, inner);
  }
  return inner;
}
