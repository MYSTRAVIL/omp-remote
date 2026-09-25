import type { SessionMeta } from "@omp-remote/protocol";
import type { MachineCatalog } from "./machine-catalogs";

/** A machine's current session list, tagged with its display label (spec §5). */
export interface MachineSessions {
  machineId: string;
  /** Human-facing name — the host-agent's enrolled label (machineId in v1). */
  label: string;
  sessions: SessionMeta[];
  /** Last-known model catalog for the machine, cached on this device. */
  catalog?: MachineCatalog;
  /** Rows are the device's cached last list, awaiting this load's live snapshot. */
  stale?: true;
  /**
   * Rows await a live snapshot (cached, just listed, or the relay link lost or
   * being checked): the list shows the machine as syncing, never "0 sessions".
   */
  syncing?: true;
  /** The relay's live machine list no longer carries it: rows are its last known list. */
  offline?: true;
}

export interface SessionNode {
  session: SessionMeta;
}
export interface ProjectNode {
  project: string;
  sessions: SessionMeta[];
}
export interface MachineNode {
  machineId: string;
  /** Display name: the name given on this device, else the machine's label. */
  label: string;
  projects: ProjectNode[];
  /** Last-known model catalog for the machine; absent until a session reports one. */
  catalog?: MachineCatalog;
  /** Rows are the device's cached last list, awaiting this load's live snapshot. */
  stale?: true;
  /** Rows await a live snapshot; see {@link MachineSessions.syncing}. */
  syncing?: true;
  /** The relay's live machine list no longer carries it: rows are its last known list. */
  offline?: true;
}

/**
 * Assemble the phone's **machine → project → session** tree from each machine's
 * session list. Sort is total and stable (spec §5): machine label, then project
 * name, then session `startedAt`, with the session `id` as the final tie-break so
 * two sessions started in the same millisecond keep a deterministic order.
 */
export function assembleTree(machines: MachineSessions[]): MachineNode[] {
  return [...machines]
    .sort((a, b) => cmp(a.label, b.label) || cmp(a.machineId, b.machineId))
    .map((m) => ({
      machineId: m.machineId,
      label: m.label,
      projects: groupProjects(m.sessions),
      ...(m.catalog ? { catalog: m.catalog } : {}),
      ...(m.stale ? { stale: m.stale } : {}),
      ...(m.syncing ? { syncing: m.syncing } : {}),
      ...(m.offline ? { offline: m.offline } : {}),
    }));
}

function groupProjects(sessions: SessionMeta[]): ProjectNode[] {
  const byProject = new Map<string, SessionMeta[]>();
  for (const s of sessions) {
    const bucket = byProject.get(s.project);
    if (bucket) bucket.push(s);
    else byProject.set(s.project, [s]);
  }
  return [...byProject.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([project, group]) => ({
      project,
      sessions: [...group].sort(
        (a, b) => a.startedAt - b.startedAt || cmp(a.id, b.id),
      ),
    }));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
