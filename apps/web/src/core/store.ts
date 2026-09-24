import type {
  CatalogModel,
  CatalogRole,
  InteractionFrame,
  SealedFrame,
  SessionMeta,
  UplinkFrame,
} from "@omp-remote/protocol";
import type { MachineCatalogs } from "./machine-catalogs";
import type { MachinePresence } from "./machine-presence";
import type { SessionListCache } from "./session-list-cache";
import {
  type MachineNode,
  type MachineSessions,
  assembleTree,
} from "./session-tree";
import {
  type TranscriptState,
  claimMediaFetch,
  emptyTranscript,
  reduceTranscript,
  restartMediaTransfers,
} from "./transcript";

export interface AppState {
  /** Session-list selection: undefined = show the tree, set = show a session view. */
  selectedSessionId: string | undefined;
}

/** A phone-initiated spawn awaiting its session. `spawnId` is the nonce the host
 *  echoes back in `SessionMeta.spawnId`; the store opens the session whose
 *  `spawnId` matches. `status` drives the waiting vs failed screen. */
export interface PendingSpawn {
  machineId: string;
  cwd: string;
  project: string;
  spawnId: string;
  status: "waiting" | "failed";
}

type Listener = () => void;

/**
 * A session's pending interactions, tagged with the machine that delivered them.
 * The owner is the sole cleanup authority: only its own session snapshot (or its
 * disconnect) may retire these entries. That scoping is what keeps an unrelated
 * machine's snapshot from dropping a request that arrived before the owning
 * machine had ever listed its session.
 */
interface PendingQueue {
  /** Machine that raised these interactions — the only authority that can retire them. */
  machineId: string;
  /** Interaction id → frame, in first-seen order (a `Map` preserves insertion order). */
  readonly items: Map<string, InteractionFrame>;
  /** Lazily-built readonly view of `items`; reset to `undefined` when the queue mutates. */
  snapshot: readonly InteractionFrame[] | undefined;
}

/** The model/role/effort catalog delivered by the agent for a session. */
export interface SessionCatalog {
  models: CatalogModel[];
  roles: CatalogRole[];
  currentId?: string;
  currentEffort?: string;
  /** True when this catalog came from the user's curated omp config; a bare
   *  fallback catalog is `false`. The store refuses to downgrade a configured
   *  catalog to a fallback one. */
  configured?: boolean;
}

/** Shared, referentially-stable empty catalog. */
const NO_CATALOG: SessionCatalog = { models: [], roles: [] };
/** Shared, referentially-stable empty view so `pendingInteractions` of an idle
 *  session hands back the same array every call — cheap for renderer memoization. */
const NO_PENDING: readonly InteractionFrame[] = [];

/**
 * The PWA's single source of truth. It holds each attached machine's session
 * list (keyed by machineId) and the current selection routing the shell between
 * the tree and a session view. The tree is derived on demand via
 * `assembleTree`; the store never caches a stale copy.
 *
 * A `sessions` snapshot REPLACES a machine's list (the agent always sends the
 * whole list, never a delta) and is authoritative for THAT machine alone: it
 * retires the attention flags and pending interactions the machine owns but no
 * longer lists, leaving every other machine's state untouched. Streamed frames
 * are handled per type: `interaction`/`interactionEnd` maintain the pending-
 * decision queue, `attention` lights the tree badge, and `msg`/`tool`/`state`/
 * `controlError`/`bye` build the session transcript.
 */
export class AppStore {
  readonly #machines = new Map<string, MachineSessions>();
  readonly #transcripts = new Map<string, TranscriptState>();
  /** Sessions the host flagged as needing input, mapped to the machine that
   *  raised the flag so a disconnect/removal can retire it (spec §5). Opening a
   *  session clears its flag; a still-pending interaction keeps it lit anyway. */
  readonly #attention = new Map<string, string>();
  /** Pending user decisions per session; see {@link PendingQueue}. */
  readonly #pendingInteractions = new Map<string, PendingQueue>();
  #state: AppState = { selectedSessionId: undefined };
  /** Model/role/effort catalogs per session. */
  readonly #catalogs = new Map<
    string,
    SessionCatalog & { machineId: string }
  >();
  #resourceSink: ((frame: UplinkFrame) => void) | undefined;
  readonly #listeners = new Set<Listener>();
  readonly #now: () => number;
  /** Monotonic id source for optimistic local prompt echoes. */
  #promptSeq = 0;
  /** A phone-initiated spawn awaiting the host to report its session. */
  #pendingSpawn: PendingSpawn | undefined;
  /** Names given to machines on this device (`MachineLabels`), by machineId. */
  #labels: ReadonlyMap<string, string> = new Map();

  /** Last-known catalog per machine, for the new-session dialog. */
  readonly #machineCatalogs: MachineCatalogs | undefined;
  /** The device's copy of the last session list, painted on a cold load. */
  readonly #sessionCache: SessionListCache | undefined;
  /** When this device last saw each machine online, for Settings. */
  readonly #presence: MachinePresence | undefined;
  /** Machines whose rows still come from that cache (no live snapshot yet). */
  readonly #stale = new Set<string>();
  /** Cached machines no live machine list or frame has named yet this load. */
  readonly #cachedOnly = new Set<string>();
  /**
   * Machines seen online this load that the relay's live machine list no
   * longer carries: kept with their last rows, marked offline, until a later
   * list or any frame shows them back.
   */
  readonly #offline = new Set<string>();
  /** True once this load received live data (a machine list or a snapshot). */
  #live = false;

  constructor(
    now: () => number = Date.now,
    machineCatalogs?: MachineCatalogs,
    sessionCache?: SessionListCache,
    presence?: MachinePresence,
  ) {
    this.#now = now;
    this.#machineCatalogs = machineCatalogs;
    this.#sessionCache = sessionCache;
    this.#presence = presence;
  }

  /**
   * Paint the device's cached session list before the client connects. Each
   * cached machine is marked stale until its live snapshot replaces its rows;
   * one the first live machine list does not carry is dropped, never having
   * been seen online this load. Machines the store already holds live data for
   * are left alone.
   */
  restoreCachedList(): void {
    const cached = this.#sessionCache?.load() ?? [];
    let changed = false;
    for (const machine of cached) {
      if (this.#machines.has(machine.machineId)) continue;
      this.#machines.set(machine.machineId, {
        machineId: machine.machineId,
        label: machine.machineId,
        sessions: machine.sessions.map((s) => ({ ...s, pid: 0 })),
      });
      this.#stale.add(machine.machineId);
      this.#cachedOnly.add(machine.machineId);
      changed = true;
    }
    if (changed) this.#emit();
  }

  /** True until this load's first live machine list or snapshot arrives. */
  connecting(): boolean {
    return !this.#live;
  }

  getState(): AppState {
    return {
      selectedSessionId: this.#state.selectedSessionId,
    };
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Reconcile the set of connected machines from the relay's `machines`
   * control, sent on attach and again whenever a machine's agent registers or
   * drops. A newly listed machine gets an empty entry so it shows in the tree
   * before its first snapshot. A machine seen online this load that the list
   * no longer carries keeps its rows, marked offline, so its sessions (and an
   * open one's draft) stay put until it returns; a cached machine never seen
   * online this load is dropped. A disconnected machine takes the attention
   * flags and pending interactions it owned with it. Every listed machine
   * counts as seen online now.
   */
  setMachineList(machineIds: string[]): void {
    this.#presence?.observe(machineIds, this.#now());
    const connected = new Set(machineIds);
    for (const id of [...this.#machines.keys()]) {
      if (connected.has(id)) continue;
      if (this.#cachedOnly.delete(id)) {
        this.#machines.delete(id);
        this.#stale.delete(id);
      } else this.#offline.add(id);
    }
    this.#retire((owner) => !connected.has(owner));
    for (const id of machineIds) {
      this.#cachedOnly.delete(id);
      this.#offline.delete(id);
      if (!this.#machines.has(id))
        this.#machines.set(id, { machineId: id, label: id, sessions: [] });
    }
    this.#live = true;
    this.#saveList();
    this.#emit();
  }

  /**
   * Replace the names given to machines on this device. The tree shows a
   * machine's name in place of its default label (and sorts by it); a machine
   * without one keeps the default.
   */
  setMachineLabels(labels: ReadonlyMap<string, string>): void {
    this.#labels = new Map(labels);
    this.#emit();
  }

  /**
   * Drop a machine this browser no longer pairs with ("Forget on this
   * device"): its session list and every transcript, attention flag, pending
   * interaction and catalog it owned. Unlike a disconnect, nothing is kept for
   * a return — the rebuilt client never attaches to it again.
   */
  forgetMachine(machineId: string): void {
    // A paired-but-offline machine has no entry but may still have a cached
    // catalog and a last-seen time.
    this.#machineCatalogs?.forget(machineId);
    this.#presence?.forget(machineId);
    const machine = this.#machines.get(machineId);
    if (machine === undefined) return;
    this.#machines.delete(machineId);
    this.#stale.delete(machineId);
    this.#cachedOnly.delete(machineId);
    this.#offline.delete(machineId);
    for (const session of machine.sessions)
      this.#transcripts.delete(session.id);
    this.#retire((owner) => owner === machineId);
    this.#saveList();
    this.#emit();
  }

  /**
   * Apply a sealed frame received for `machineId`; any frame shows the machine
   * online now, since only its live agent sends one. A `sessions` snapshot
   * moves the machine tree and retires the sender's own attention + pending
   * for any session it no longer lists; `attention` lights the tree badge;
   * `interaction` queues a decision and `interactionEnd` (only from the owning
   * machine) dismisses one; `msg`/`tool`/`state`/`jobs`/`controlError`/`bye`
   * build the owning session's transcript, and a `bye` retires that session's
   * attention + pending. Everything else is ignored.
   */
  applyFrame(machineId: string, frame: SealedFrame): void {
    this.#presence?.observe([machineId], this.#now());
    this.#cachedOnly.delete(machineId);
    if (this.#offline.delete(machineId)) this.#emit();
    if (frame.t === "sessions") {
      const existing = this.#machines.get(machineId);
      this.#machines.set(machineId, {
        machineId,
        label: existing?.label ?? machineId,
        sessions: frame.sessions,
      });
      // The sender's snapshot is authoritative for its own sessions only: retire
      // what it owns but no longer lists, leaving other machines' state intact.
      const listed = new Set(frame.sessions.map((s) => s.id));
      this.#retire(
        (owner, sessionId) => owner === machineId && !listed.has(sessionId),
      );
      this.#stale.delete(machineId);
      this.#live = true;
      this.#saveList();
      this.#emit();
      return;
    }
    if (frame.t === "modelCatalog") {
      // omp may load the bridge in more than one context; an early/probe load
      // with no config visible emits a bare fallback catalog (configured false
      // or absent). Never let it clobber a curated catalog already stored for
      // this session, regardless of which arrives first.
      const existing = this.#catalogs.get(frame.sessionId);
      if (!frame.configured && existing?.configured === true) return;
      this.#machineCatalogs?.observe(machineId, frame);
      this.#catalogs.set(frame.sessionId, {
        machineId,
        models: frame.models,
        roles: frame.roles,
        currentId: frame.currentId,
        currentEffort: frame.currentEffort,
        configured: frame.configured,
      });
      this.#emit();
      return;
    }
    if (
      frame.t === "resourceProgress" ||
      frame.t === "resourceReady" ||
      frame.t === "resourceError"
    ) {
      this.#resourceSink?.(frame);
      return;
    }
    if (frame.t === "attention") {
      // Flag the session unless it's the one the user is already looking at.
      if (frame.sessionId !== this.#state.selectedSessionId) {
        this.#attention.set(frame.sessionId, machineId);
        this.#emit();
      }
      return;
    }
    if (frame.t === "interaction") {
      let queue = this.#pendingInteractions.get(frame.sessionId);
      if (queue === undefined) {
        queue = { machineId, items: new Map(), snapshot: undefined };
        this.#pendingInteractions.set(frame.sessionId, queue);
      }
      // First-seen wins: a duplicate id is ignored, so order and idempotence hold.
      if (!queue.items.has(frame.id)) {
        queue.items.set(frame.id, frame);
        queue.snapshot = undefined;
        this.#emit();
      }
      return;
    }
    if (frame.t === "interactionEnd") {
      // Only the owning machine may end its interaction; a stale end relayed for
      // a session another machine owns is ignored.
      const queue = this.#pendingInteractions.get(frame.sessionId);
      if (queue?.machineId === machineId)
        this.dismissInteraction(frame.sessionId, frame.id);
      return;
    }
    if (
      frame.t === "msg" ||
      frame.t === "tool" ||
      frame.t === "state" ||
      frame.t === "jobs" ||
      frame.t === "mediaInit" ||
      frame.t === "mediaChunk" ||
      frame.t === "mediaError" ||
      frame.t === "controlError" ||
      frame.t === "bye"
    ) {
      const current =
        this.#transcripts.get(frame.sessionId) ?? emptyTranscript();
      const title = current.footer?.title;
      reduceTranscript(current, frame);
      this.#transcripts.set(frame.sessionId, current);
      // A session that says goodbye takes its attention + pending + catalog with it.
      if (frame.t === "bye") {
        this.#attention.delete(frame.sessionId);
        this.#pendingInteractions.delete(frame.sessionId);
        this.#catalogs.delete(frame.sessionId);
      }
      // The tree shows the live title; keep the cached list in step with it.
      if (current.footer?.title !== title) this.#saveList();
      this.#emit();
    }
  }

  select(sessionId: string | undefined): void {
    // Opening a session clears its ordinary needs-attention flag; a still-pending
    // interaction keeps `needsAttention` true — that decision outlives a glance.
    if (sessionId !== undefined) this.#attention.delete(sessionId);
    this.#state = { ...this.#state, selectedSessionId: sessionId };
    this.#emit();
  }

  /** Record a phone-initiated spawn and show its waiting screen until the host
   *  reports a session carrying the matching `spawnId`. */
  beginSpawn(input: { machineId: string; cwd: string; spawnId: string }): void {
    // The project label is the cwd's last path segment (either separator).
    const project =
      input.cwd
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() || input.cwd;
    this.#pendingSpawn = {
      machineId: input.machineId,
      cwd: input.cwd,
      project,
      spawnId: input.spawnId,
      status: "waiting",
    };
    this.#emit();
  }

  /** The in-flight spawn, or undefined when none is pending. */
  pendingSpawn(): PendingSpawn | undefined {
    return this.#pendingSpawn ? { ...this.#pendingSpawn } : undefined;
  }

  /** The id of the session that fulfils the pending spawn (its `spawnId`
   *  matches), or undefined while none has registered yet. */
  resolveSpawn(): string | undefined {
    const pending = this.#pendingSpawn;
    if (!pending || pending.status !== "waiting") return undefined;
    for (const machine of this.#machines.values())
      for (const session of machine.sessions)
        if (session.spawnId === pending.spawnId) return session.id;
    return undefined;
  }

  /** Mark the pending spawn failed (it never registered before the deadline). */
  failSpawn(): void {
    if (this.#pendingSpawn && this.#pendingSpawn.status === "waiting") {
      this.#pendingSpawn = { ...this.#pendingSpawn, status: "failed" };
      this.#emit();
    }
  }

  /** Drop the pending spawn (resolved, cancelled, or dismissed). */
  clearSpawn(): void {
    if (this.#pendingSpawn) {
      this.#pendingSpawn = undefined;
      this.#emit();
    }
  }

  /** Whether the session needs the user: the host flagged it (spec §5) or a
   *  pending interaction is waiting on an answer. Pending survives `select`. */
  needsAttention(sessionId: string): boolean {
    return (
      this.#attention.has(sessionId) || this.#pendingInteractions.has(sessionId)
    );
  }

  /** The selected session's metadata, or undefined if none/unknown. */
  selectedSession(): SessionMeta | undefined {
    const id = this.#state.selectedSessionId;
    if (id === undefined) return undefined;
    for (const m of this.#machines.values()) {
      const found = m.sessions.find((s) => s.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /** The machineId owning the selected session (for routing control frames). */
  selectedMachineId(): string | undefined {
    const id = this.#state.selectedSessionId;
    return id === undefined ? undefined : this.machineIdForSession(id);
  }

  /** The live transcript for a session, or undefined if none has streamed yet. */
  transcriptFor(sessionId: string): TranscriptState | undefined {
    return this.#transcripts.get(sessionId);
  }

  /**
   * Whether to ask the host for a deferred image's bytes now: true once per
   * announcement, marking the image asked for (see `claimMediaFetch`). Emits
   * nothing, since asking changes nothing on screen.
   */
  claimMediaFetch(sessionId: string, mediaId: string): boolean {
    const transcript = this.#transcripts.get(sessionId);
    return transcript !== undefined && claimMediaFetch(transcript, mediaId);
  }

  /**
   * A new relay socket opened: image transfers cut on the old one start over
   * (see `restartMediaTransfers`). Emits nothing; the next draw asks for them
   * one at a time, and the resync's re-announcements do not ask again.
   */
  restartMediaTransfers(): void {
    for (const transcript of this.#transcripts.values())
      restartMediaTransfers(transcript);
  }

  /**
   * Optimistically echo a just-sent prompt into its session transcript so the
   * user sees it immediately, before the agent's own message frame lands. A
   * mid-turn `steer` in particular is only echoed by the agent once consumed;
   * this bridges that gap. `reduceTranscript` adopts the entry in place when the
   * real `msg` frame arrives (matched by role + text), so it never duplicates.
   */
  addPendingPrompt(
    sessionId: string,
    text: string,
    mode: "steer" | "followUp",
  ): void {
    const transcript = this.#transcripts.get(sessionId) ?? emptyTranscript();
    this.#promptSeq += 1;
    transcript.entries.push({
      kind: "message",
      msgId: `pending-${this.#promptSeq}`,
      role: "user",
      text,
      streaming: false,
      pending: mode,
    });
    this.#transcripts.set(sessionId, transcript);
    this.#emit();
  }

  /**
   * The current machine → project → session tree (derived, sorted per §5). Each
   * machine shows the name given on this device, when there is one. Each
   * session's title is overlaid with the live title from its transcript, so the
   * list tracks the session's current title and updates instead of lagging on
   * "Untitled" (or a stale snapshot) once titles start landing.
   */
  tree(): MachineNode[] {
    return assembleTree(this.#displayedMachines());
  }

  /** Each machine's rows as the tree shows them: the name given on this device,
   *  whether it is offline, and every session's live title. */
  #displayedMachines(): MachineSessions[] {
    return [...this.#machines.values()].map((machine) => ({
      ...machine,
      label: this.#labels.get(machine.machineId) ?? machine.label,
      catalog: this.#machineCatalogs?.catalogFor(machine.machineId),
      ...(this.#stale.has(machine.machineId) ? { stale: true as const } : {}),
      ...(this.#offline.has(machine.machineId)
        ? { offline: true as const }
        : {}),
      sessions: machine.sessions.map((session) => {
        const live = this.#transcripts.get(session.id)?.footer?.title;
        return live ? { ...session, title: live } : session;
      }),
    }));
  }

  /** Write the list the tree now shows to the device cache. */
  #saveList(): void {
    this.#sessionCache?.save(this.#displayedMachines());
  }

  /**
   * Pending interactions for the session, in first-seen order (a shared, stable
   * empty array when none). The returned reference changes only when THIS
   * session's queue changes, so an unrelated mutation can't defeat a renderer's
   * memoization of the queue.
   */
  pendingInteractions(sessionId: string): readonly InteractionFrame[] {
    const queue = this.#pendingInteractions.get(sessionId);
    if (queue === undefined) return NO_PENDING;
    if (queue.snapshot === undefined) {
      queue.snapshot = [...queue.items.values()];
    }
    return queue.snapshot;
  }

  /**
   * Dismiss a specific interaction, dropping it from its session's queue and
   * emitting only when something changed. Shared by the reply-sent path
   * (`main.ts`, after a successful send) and an owning machine's `interactionEnd`
   * — both retire the same prompt. Drops the whole queue once empty so
   * `needsAttention` / `pendingInteractions` fall back to "none". No-op if the
   * session or id is unknown.
   */
  dismissInteraction(sessionId: string, id: string): void {
    const queue = this.#pendingInteractions.get(sessionId);
    if (queue === undefined || !queue.items.delete(id)) return;
    if (queue.items.size === 0) {
      this.#pendingInteractions.delete(sessionId);
    } else {
      queue.snapshot = undefined;
    }
    this.#emit();
  }
  /**
   * The model/role/effort catalog for a session, or a shared empty default
   * when the agent has not sent one yet.
   */
  catalogFor(sessionId: string): SessionCatalog {
    return this.#catalogs.get(sessionId) ?? NO_CATALOG;
  }

  /** Route inbound resource-transfer frames (upload progress/ready/error) to the
   *  attachment uploader. They are transient signals, never stored as state. */
  setResourceSink(sink: (frame: UplinkFrame) => void): void {
    this.#resourceSink = sink;
  }

  /**
   * Find the machineId owning the given session (for routing control frames).
   * Returns undefined if the session is not in any machine's current list.
   */
  machineIdForSession(sessionId: string): string | undefined {
    for (const m of this.#machines.values())
      if (m.sessions.some((s) => s.id === sessionId)) return m.machineId;
    return undefined;
  }

  /**
   * Retire the attention flags and pending queues whose owning machine (and, for
   * a snapshot, session) satisfies `drop`. Shared by machine disconnect and a
   * machine's authoritative snapshot; the caller emits once afterwards.
   */
  #retire(drop: (owner: string, sessionId: string) => boolean): void {
    for (const [sessionId, owner] of this.#attention)
      if (drop(owner, sessionId)) this.#attention.delete(sessionId);
    for (const [sessionId, queue] of this.#pendingInteractions)
      if (drop(queue.machineId, sessionId))
        this.#pendingInteractions.delete(sessionId);
    for (const [sessionId, entry] of this.#catalogs)
      if (drop(entry.machineId, sessionId)) this.#catalogs.delete(sessionId);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
