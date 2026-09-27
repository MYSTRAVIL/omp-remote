import {
  type AttentionFrame,
  type CatalogModel,
  type CatalogRole,
  type HistoryEntry,
  type InteractionFrame,
  type ReplayEndFrame,
  type SealedFrame,
  type SessionMeta,
  type UplinkFrame,
  attentionSettledBy,
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
  type SentImage,
  type TranscriptState,
  claimMediaFetch,
  emptyTranscript,
  failLocalEcho,
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
  /** The stored session this spawn reopens; omp keeps its id on resume. */
  resume?: string;
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

/**
 * A session's host said it waits on the user (`attention`): for its turn
 * (`idle`, the agent settled) or for a tool approval asked at the desk
 * (`approval`). Each flag is a new wait.
 */
interface AttentionWait {
  machineId: string;
  reason: AttentionFrame["reason"];
  /** The host's `at`, when the frame carries one: its host-agent retains the
   *  wait and replays it with that `at` until a frame settles it. */
  at: number | undefined;
}

/**
 * A replay a machine is sending, between its `replayStart` and `replayEnd`,
 * checked against the interactions and waits shown from it before it began.
 */
interface ReplayCheck {
  /** Interactions shown before the replay and not re-sent yet, by session. */
  readonly unconfirmed: Map<string, Set<string>>;
  /**
   * Waits shown before the replay and not re-sent yet, by session. A replay
   * sends a session's history before its wait, so until then a frame for that
   * session may be history from before the wait and settles nothing.
   */
  readonly doubted: Map<string, AttentionWait>;
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
  /** Sessions the host flagged as waiting on the user (spec §5), with the
   *  machine that raised the flag so a disconnect/removal can retire it.
   *  Opening a session clears its flag, and so does its agent starting work
   *  again after an `idle` one; a still-pending interaction keeps
   *  `needsAttention` lit anyway. */
  readonly #attention = new Map<string, AttentionWait>();
  /** Pending user decisions per session; see {@link PendingQueue}. */
  readonly #pendingInteractions = new Map<string, PendingQueue>();
  /** Waits the user saw here (opened, or flagged while open), by session: the
   *  host's `at` of each, so a replay re-sending one does not flag it again. */
  readonly #seenWaits = new Map<string, { machineId: string; at: number }>();
  /** Replays machines are sending now, by machine; see {@link ReplayCheck}. */
  readonly #replays = new Map<string, ReplayCheck>();
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
  /** Prompts this phone sent that no replay has settled yet, by `clientId`:
   *  the session, its machine then, and the `#promptSeq` of the send. */
  readonly #sent = new Map<
    string,
    { sessionId: string; machineId: string | undefined; seq: number }
  >();
  /** Per machine, the last `sync` this phone sent it and the `#promptSeq`
   *  then; see {@link noteSync}. */
  readonly #syncs = new Map<string, { id: string; upTo: number }>();
  /** A phone-initiated spawn awaiting the host to report its session. */
  #pendingSpawn: PendingSpawn | undefined;
  /** Names given to machines on this device (`MachineLabels`), by machineId. */
  #labels: ReadonlyMap<string, string> = new Map();
  /** Each machine's last answer to Past sessions, by project cwd (memory only). */
  readonly #history = new Map<string, Map<string, readonly HistoryEntry[]>>();
  /**
   * Sessions that said `bye` this load, with the machine and meta they had.
   * The host stops listing them at once; this keeps an ended session's tab
   * open (with Continue) while it stays selected, and tells a resumed session
   * (same id, new process) from a stale listing of the ended one.
   */
  readonly #ended = new Map<string, { machineId: string; meta: SessionMeta }>();

  /** Last-known catalog per machine, for the new-session dialog. */
  readonly #machineCatalogs: MachineCatalogs | undefined;
  /** The device's copy of the last session list, painted on a cold load. */
  readonly #sessionCache: SessionListCache | undefined;
  /** When this device last saw each machine online, for Settings. */
  readonly #presence: MachinePresence | undefined;
  /** Machines whose rows still come from that cache (no live snapshot yet). */
  readonly #stale = new Set<string>();
  /**
   * Machines whose rows await a live snapshot: rows from that cache, a machine
   * just listed, or rows the relay link may have missed changes to (see
   * `awaitSnapshots` and `doubtLists`). The tree shows them as syncing.
   */
  readonly #syncing = new Set<string>();
  /**
   * Machines `doubtLists` marked syncing whose rows were current until then:
   * the resume probe's pong (`confirmLists`) makes them current again.
   */
  readonly #doubted = new Set<string>();
  /** Cached machines no live machine list or frame has named yet this load. */
  readonly #cachedOnly = new Set<string>();
  /**
   * Machines seen online this load that the relay's live machine list no
   * longer carries: kept with their last rows, marked offline, until a later
   * list or any frame shows them back.
   */
  readonly #offline = new Set<string>();
  /**
   * Machines whose host-agent said it could not open this phone's lines: it
   * serves another pairing, so this phone has to pair with it again. Kept
   * across reconnects and machine lists, until a sealed exchange with the
   * machine succeeds (its ack, or a frame that opened under this phone's
   * keys) or the machine is forgotten here.
   */
  readonly #unpaired = new Set<string>();
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
   * cached machine is marked stale (and syncing) until its live snapshot
   * replaces its rows; one the first live machine list does not carry is
   * dropped, never having been seen online this load. Machines the store
   * already holds live data for are left alone.
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
      this.#syncing.add(machine.machineId);
      this.#cachedOnly.add(machine.machineId);
      changed = true;
    }
    if (changed) this.#emit();
  }

  /** True until this load's first live machine list or snapshot arrives. */
  connecting(): boolean {
    return !this.#live;
  }

  /**
   * The relay link carrying every machine's frames was lost: the new one's
   * sync resends each list, and until then every machine's rows may be out of
   * date, so each syncs until its next snapshot. A pong can no longer vouch
   * for rows `doubtLists` marked, and a replay still being checked lost the
   * rest of its frames with the socket.
   */
  awaitSnapshots(): void {
    this.#doubted.clear();
    this.#replays.clear();
    let changed = false;
    for (const id of this.#machines.keys()) {
      if (this.#syncing.has(id)) continue;
      this.#syncing.add(id);
      changed = true;
    }
    if (changed) this.#emit();
  }

  /**
   * The app came back from the background and the relay link is being
   * checked: the rows may be out of date if it died meanwhile, so each machine
   * with current rows syncs until the check's pong (`confirmLists`) or its next
   * snapshot, whichever comes first.
   */
  doubtLists(): void {
    let changed = false;
    for (const id of this.#machines.keys()) {
      if (this.#syncing.has(id)) continue;
      this.#syncing.add(id);
      this.#doubted.add(id);
      changed = true;
    }
    if (changed) this.#emit();
  }

  /**
   * The relay answered the check: the link stayed up, so every frame sent
   * before the pong has landed and the rows `doubtLists` marked are current.
   * Rows that were already awaiting a snapshot keep waiting.
   */
  confirmLists(): void {
    let changed = false;
    for (const id of this.#doubted)
      changed = this.#syncing.delete(id) || changed;
    this.#doubted.clear();
    if (changed) this.#emit();
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
   * drops. A newly listed machine gets an empty entry, syncing until its
   * first snapshot, so it shows in the tree before then. A machine seen online
   * this load that the list no longer carries keeps its rows, marked offline,
   * so its sessions (and an open one's draft) stay put until it returns; a
   * cached machine never seen online this load is dropped. A disconnected
   * machine takes the attention flags and pending interactions it owned with
   * it; its replay brings the pending ones back. Every listed machine counts
   * as seen online now.
   */
  setMachineList(machineIds: string[]): void {
    this.#presence?.observe(machineIds, this.#now());
    const connected = new Set(machineIds);
    for (const id of [...this.#machines.keys()]) {
      if (connected.has(id)) continue;
      this.#replays.delete(id);
      if (this.#cachedOnly.delete(id)) {
        this.#machines.delete(id);
        this.#stale.delete(id);
        this.#syncing.delete(id);
      } else this.#offline.add(id);
    }
    this.#retire((owner) => !connected.has(owner));
    for (const id of machineIds) {
      this.#cachedOnly.delete(id);
      this.#offline.delete(id);
      if (!this.#machines.has(id)) {
        this.#machines.set(id, { machineId: id, label: id, sessions: [] });
        this.#syncing.add(id);
      }
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
   * interaction and catalog it owned. Unlike a disconnect, nothing is kept
   * for a return — the rebuilt client never attaches to it again.
   */
  forgetMachine(machineId: string): void {
    // A paired-but-offline machine has no entry but may still have a cached
    // catalog and a last-seen time.
    this.#machineCatalogs?.forget(machineId);
    this.#presence?.forget(machineId);
    this.#history.delete(machineId);
    this.#replays.delete(machineId);
    this.#forgetSeenWaits(machineId, () => true);
    for (const [sessionId, gone] of this.#ended)
      if (gone.machineId === machineId) {
        this.#ended.delete(sessionId);
        this.#transcripts.delete(sessionId);
      }
    this.#unpaired.delete(machineId);
    const machine = this.#machines.get(machineId);
    if (machine === undefined) return;
    this.#machines.delete(machineId);
    this.#stale.delete(machineId);
    this.#syncing.delete(machineId);
    this.#doubted.delete(machineId);
    this.#cachedOnly.delete(machineId);
    this.#offline.delete(machineId);
    for (const session of machine.sessions)
      this.#transcripts.delete(session.id);
    this.#retire((owner) => owner === machineId);
    this.#saveList();
    this.#emit();
  }

  /**
   * `machineId`'s host-agent said it could not open this phone's lines: it
   * serves another pairing. The tree asks the user to pair this phone with it
   * again, and stops waiting for its snapshot, until `markPaired`.
   */
  markUnpaired(machineId: string): void {
    if (this.#unpaired.has(machineId)) return;
    this.#unpaired.add(machineId);
    this.#emit();
  }

  /**
   * A sealed exchange with `machineId` succeeded (its ack, or a frame, opened
   * under this phone's keys): the pairing holds after all.
   */
  markPaired(machineId: string): void {
    if (this.#unpaired.delete(machineId)) this.#emit();
  }

  /**
   * Apply a sealed frame received for `machineId`; any frame shows the machine
   * online now, since only its live agent sends one, and paired with this
   * phone, since it opened here. A `sessions` snapshot moves the machine tree
   * and retires the sender's own attention + pending for any session it no
   * longer lists; `attention` starts a new wait on the user; `interaction`
   * queues a decision and `interactionEnd` (only from the owning machine)
   * dismisses one;
   * `msg`/`tool`/`state`/`jobs`/`controlError`/`bye` build the owning
   * session's transcript, a `state` at work again ends a wait for the user's
   * turn, and a `bye` retires that session's attention + pending. A `history`
   * answer is held per machine and project for Past sessions. `replayStart`
   * and `replayEnd` bracket a replay (see `#beginReplay`), and inside one a
   * re-sent interaction or attention confirms what it names. Everything else
   * is ignored.
   */
  applyFrame(machineId: string, frame: SealedFrame): void {
    this.#presence?.observe([machineId], this.#now());
    this.#cachedOnly.delete(machineId);
    if (this.#offline.delete(machineId)) this.#emit();
    this.markPaired(machineId);
    if (frame.t === "replayStart") {
      this.#beginReplay(machineId);
      return;
    }
    if (frame.t === "replayEnd") {
      this.#endReplay(machineId);
      this.#settlePrompts(machineId, frame);
      return;
    }
    const check = this.#replays.get(machineId);
    if (frame.t === "interaction")
      check?.unconfirmed.get(frame.sessionId)?.delete(frame.id);
    // A re-sent attention decides its session's wait: the same `at` continues
    // it, a new one replaces it.
    if (frame.t === "attention") check?.doubted.delete(frame.sessionId);
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
      // A resumed session comes back under its old id in a new process: its
      // transcript is live again. Entry ids are omp's own, so the replay
      // lands on the kept entries instead of doubling them.
      for (const session of frame.sessions) {
        const gone = this.#ended.get(session.id);
        if (gone === undefined || gone.meta.pid === session.pid) continue;
        this.#ended.delete(session.id);
        const transcript = this.#transcripts.get(session.id);
        if (transcript) transcript.ended = false;
      }
      this.#retire(
        (owner, sessionId) => owner === machineId && !listed.has(sessionId),
      );
      // The waits the user saw there went with them.
      this.#forgetSeenWaits(machineId, (sessionId) => !listed.has(sessionId));
      this.#stale.delete(machineId);
      this.#syncing.delete(machineId);
      this.#doubted.delete(machineId);
      this.#live = true;
      this.#saveList();
      this.#emit();
      return;
    }
    if (frame.t === "history") {
      let projects = this.#history.get(machineId);
      if (projects === undefined) {
        projects = new Map();
        this.#history.set(machineId, projects);
      }
      projects.set(frame.cwd, frame.entries);
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
      this.#flagWait(machineId, frame);
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
        // The session asks something new: it no longer waits on its flag.
        this.#settleWait(machineId, frame, undefined);
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
      const wasStreaming = current.footer?.streaming;
      reduceTranscript(current, frame);
      this.#transcripts.set(frame.sessionId, current);
      if (frame.t === "msg" || frame.t === "tool" || frame.t === "state")
        this.#settleWait(machineId, frame, wasStreaming);
      // A session that says goodbye takes its attention + pending + catalog
      // with it.
      if (frame.t === "bye") {
        this.#attention.delete(frame.sessionId);
        this.#pendingInteractions.delete(frame.sessionId);
        this.#catalogs.delete(frame.sessionId);
        this.#forgetSeenWaits(
          machineId,
          (sessionId) => sessionId === frame.sessionId,
        );
        const meta = this.#machines
          .get(machineId)
          ?.sessions.find((s) => s.id === frame.sessionId);
        if (meta) this.#ended.set(frame.sessionId, { machineId, meta });
      }
      // The tree shows the live title; keep the cached list in step with it.
      if (current.footer?.title !== title) this.#saveList();
      this.#emit();
    }
  }

  select(sessionId: string | undefined): void {
    // Opening a session ends the wait its host flagged (the user has seen it,
    // so a replay re-sending it does not flag it again); a still-pending
    // interaction keeps `needsAttention` true — that decision outlives a glance.
    if (sessionId !== undefined) {
      const wait = this.#attention.get(sessionId);
      this.#attention.delete(sessionId);
      if (wait?.at !== undefined)
        this.#seenWaits.set(sessionId, {
          machineId: wait.machineId,
          at: wait.at,
        });
    }
    this.#state = { ...this.#state, selectedSessionId: sessionId };
    this.#emit();
  }

  /** Record a phone-initiated spawn and show its waiting screen until the host
   *  reports a session carrying the matching `spawnId` (or, resuming, the
   *  stored session's own id). */
  beginSpawn(input: {
    machineId: string;
    cwd: string;
    spawnId: string;
    resume?: string;
  }): void {
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
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      status: "waiting",
    };
    this.#emit();
  }

  /** The in-flight spawn, or undefined when none is pending. */
  pendingSpawn(): PendingSpawn | undefined {
    return this.#pendingSpawn ? { ...this.#pendingSpawn } : undefined;
  }

  /** The id of the session that fulfils the pending spawn (its `spawnId`
   *  matches, or it is the resumed session on the spawn's machine), or
   *  undefined while none has registered yet. */
  resolveSpawn(): string | undefined {
    const pending = this.#pendingSpawn;
    if (!pending || pending.status !== "waiting") return undefined;
    for (const machine of this.#machines.values())
      for (const session of machine.sessions)
        if (
          session.spawnId === pending.spawnId ||
          (session.id === pending.resume &&
            machine.machineId === pending.machineId)
        )
          return session.id;
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

  /** A machine's last answer to Past sessions for `cwd`; undefined until one lands. */
  historyFor(
    machineId: string,
    cwd: string,
  ): readonly HistoryEntry[] | undefined {
    return this.#history.get(machineId)?.get(cwd);
  }

  /** Drop the held answer for `cwd` before asking again, so Past sessions shows
   *  loading until the fresh one lands rather than a stale list. */
  clearHistory(machineId: string, cwd: string): void {
    if (this.#history.get(machineId)?.delete(cwd)) this.#emit();
  }

  /** Whether the session needs the user: the host flagged it (spec §5) or a
   *  pending interaction is waiting on an answer. Pending survives `select`. */
  needsAttention(sessionId: string): boolean {
    return (
      this.#attention.has(sessionId) || this.#pendingInteractions.has(sessionId)
    );
  }

  /**
   * How many listed sessions wait on the user (a pending interaction, or its
   * host's flag): the app badge. Undefined while a machine's list is in
   * doubt, since waits may then be missing or stale; a machine this phone has
   * to pair with again sends no list to wait for.
   */
  waitingCount(): number | undefined {
    if (
      !this.#live ||
      [...this.#syncing].some(
        (id) => !this.#offline.has(id) && !this.#unpaired.has(id),
      )
    )
      return undefined;
    let count = 0;
    for (const machine of this.#displayedMachines())
      for (const { id } of machine.sessions)
        if (
          this.#pendingInteractions.get(id)?.machineId === machine.machineId ||
          this.#attention.get(id)?.machineId === machine.machineId
        )
          count += 1;
    return count;
  }

  /** The selected session's metadata, or undefined if none/unknown. An ended
   *  session stays selected (its tab open) after the host stops listing it. */
  selectedSession(): SessionMeta | undefined {
    const id = this.#state.selectedSessionId;
    if (id === undefined) return undefined;
    for (const m of this.#machines.values()) {
      const found = m.sessions.find((s) => s.id === id);
      if (found) return found;
    }
    return this.#ended.get(id)?.meta;
  }

  /** A session that ended this load and is no longer listed: the machine it
   *  ran on and its last meta, for Continue. */
  endedSession(
    sessionId: string,
  ): { machineId: string; meta: SessionMeta } | undefined {
    if (this.machineIdForSession(sessionId) !== undefined) return undefined;
    return this.#ended.get(sessionId);
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
   * this bridges that gap. The echo waits last until the host's user message
   * confirms it (by `clientId`, or by text from an older host), so it never
   * duplicates; see `reduceTranscript`. The photos sent with it show in it
   * from this phone's own copies, which the host's copies take over.
   */
  addPendingPrompt(
    sessionId: string,
    text: string,
    mode: "steer" | "followUp",
    clientId?: string,
    images: readonly SentImage[] = [],
  ): void {
    const transcript = this.#transcripts.get(sessionId) ?? emptyTranscript();
    this.#promptSeq += 1;
    const msgId = `pending-${this.#promptSeq}`;
    transcript.entries.push({
      kind: "message",
      msgId,
      role: "user",
      text,
      streaming: false,
      pending: mode,
      ...(clientId === undefined ? {} : { clientId }),
      ...(images.length === 0
        ? {}
        : {
            media: images.map((image, i) => ({
              mediaId: `${msgId}:${i}`,
              name: image.name,
              mimeType: image.mimeType,
              size: image.size,
              totalChunks: 0,
              chunks: [],
              received: 0,
              status: "ready" as const,
              dataUrl: image.url,
              local: true as const,
            })),
          }),
    });
    if (clientId !== undefined)
      this.#sent.set(clientId, {
        sessionId,
        machineId: this.machineIdForSession(sessionId),
        seq: this.#promptSeq,
      });
    this.#transcripts.set(sessionId, transcript);
    this.#emit();
  }

  /**
   * The prompt sent as `clientId` never left this phone: `PhoneClient`
   * held it for a live link and dropped it (the link did not come back in
   * time, or the client stopped). Its echo stops waiting and shows as not
   * delivered.
   */
  failPrompt(clientId: string): void {
    const sent = this.#sent.get(clientId);
    if (sent === undefined) return;
    this.#sent.delete(clientId);
    const transcript = this.#transcripts.get(sent.sessionId);
    if (transcript && failLocalEcho(transcript, clientId)) this.#emit();
  }

  /**
   * This phone asks `machineId` for a replay with the `sync` named `id`. The
   * host handles this phone's frames in order, so the replay answering it
   * knows every prompt sent before it: see `#settlePrompts`.
   */
  noteSync(machineId: string, id: string): void {
    this.#syncs.set(machineId, { id, upTo: this.#promptSeq });
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
   *  whether it is offline or has to pair with this phone again, and every
   *  listed session with its live title. */
  #displayedMachines(): MachineSessions[] {
    return [...this.#machines.values()].map((machine) => ({
      ...machine,
      label: this.#labels.get(machine.machineId) ?? machine.label,
      catalog: this.#machineCatalogs?.catalogFor(machine.machineId),
      ...(this.#stale.has(machine.machineId) ? { stale: true as const } : {}),
      ...(this.#unpaired.has(machine.machineId)
        ? { unpaired: true as const }
        : this.#syncing.has(machine.machineId)
          ? { syncing: true as const }
          : {}),
      ...(this.#offline.has(machine.machineId)
        ? { offline: true as const }
        : {}),
      sessions: machine.sessions
        // A headless run (`omp -p`, rpc) its host cannot reach is not listed:
        // nothing on the host shows it and no room carries it, so its row
        // could only say "Unreachable". An interactive one keeps its row.
        .filter((s) => !(s.headless === true && s.reachable === false))
        .map((session) => {
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
   * emitting only when something changed. Shared by the
   * reply-sent path (`main.ts`, after a successful send) and an owning
   * machine's `interactionEnd` — both retire the same prompt. Drops the whole
   * queue once empty so `needsAttention` / `pendingInteractions` fall back to
   * "none". No-op if the session or id is unknown.
   */
  dismissInteraction(sessionId: string, id: string): void {
    const queue = this.#pendingInteractions.get(sessionId);
    if (queue !== undefined && this.#dropInteraction(queue, sessionId, id))
      this.#emit();
  }

  /** Drop an interaction that cleared; false when unknown. */
  #dropInteraction(
    queue: PendingQueue,
    sessionId: string,
    id: string,
  ): boolean {
    if (!queue.items.delete(id)) return false;
    if (queue.items.size === 0) this.#pendingInteractions.delete(sessionId);
    else queue.snapshot = undefined;
    return true;
  }

  /** Forget which waits the user saw in `machineId`'s sessions that `gone`
   *  matches (the session ended or was forgotten). */
  #forgetSeenWaits(
    machineId: string,
    gone: (sessionId: string) => boolean,
  ): void {
    for (const [sessionId, seen] of this.#seenWaits)
      if (seen.machineId === machineId && gone(sessionId))
        this.#seenWaits.delete(sessionId);
  }

  /**
   * A session's host says it waits on the user. A replay re-sending the wait
   * shown (the same host `at`) continues it; any other flag replaces it. The
   * session open on screen is not flagged, nor a wait the user already opened
   * here.
   */
  #flagWait(machineId: string, frame: AttentionFrame): void {
    const { sessionId, at } = frame;
    if (sessionId === this.#state.selectedSessionId) {
      if (at !== undefined) this.#seenWaits.set(sessionId, { machineId, at });
      return;
    }
    const seen = this.#seenWaits.get(sessionId);
    if (seen?.machineId === machineId && seen.at === at) return;
    const earlier = this.#attention.get(sessionId);
    if (
      at !== undefined &&
      earlier?.machineId === machineId &&
      earlier.at === at
    )
      return;
    this.#attention.set(sessionId, { machineId, reason: frame.reason, at });
    this.#emit();
  }

  /**
   * End the session's wait when `frame` from its host settles it (see
   * `attentionSettledBy`), as its host-agent does: the row, the badge,
   * the push and a later replay agree. A wait a replay has not re-sent yet
   * settles nothing: the frame may be history from before the wait began.
   */
  #settleWait(
    machineId: string,
    frame: UplinkFrame,
    wasStreaming: boolean | undefined,
  ): void {
    if (!("sessionId" in frame)) return;
    const { sessionId } = frame;
    const wait = this.#attention.get(sessionId);
    if (wait?.machineId !== machineId) return;
    if (this.#replays.get(machineId)?.doubted.has(sessionId)) return;
    if (!attentionSettledBy(wait.reason, frame, wasStreaming)) return;
    this.#attention.delete(sessionId);
  }

  /**
   * `machineId` starts a replay: its host re-sends everything it still
   * retains, then says `replayEnd`. Each interaction and wait shown from it
   * is unconfirmed until the replay re-sends it. A replay the phone did not
   * ask for (another phone's `sync`, the host's reconnect) is checked alike.
   * The host queues each replay whole on its one uplink, so replays never
   * interleave; a start while one is open means that one was cut short (its
   * socket dropped before the end), and this one takes its place.
   */
  #beginReplay(machineId: string): void {
    const unconfirmed = new Map<string, Set<string>>();
    for (const [sessionId, queue] of this.#pendingInteractions)
      if (queue.machineId === machineId)
        unconfirmed.set(sessionId, new Set(queue.items.keys()));
    const doubted = new Map<string, AttentionWait>();
    for (const [sessionId, wait] of this.#attention)
      if (wait.machineId === machineId) doubted.set(sessionId, wait);
    this.#replays.set(machineId, { unconfirmed, doubted });
  }

  /**
   * `machineId`'s replay is complete: what it showed from before that the
   * replay did not re-send settled while this phone could not hear (an ask
   * answered at the desk, a turn taken), so it goes. An end with no replay
   * open changes nothing.
   */
  #endReplay(machineId: string): void {
    const check = this.#replays.get(machineId);
    if (check === undefined) return;
    this.#replays.delete(machineId);
    let changed = false;
    for (const [sessionId, ids] of check.unconfirmed) {
      const queue = this.#pendingInteractions.get(sessionId);
      if (queue?.machineId !== machineId) continue;
      for (const id of ids)
        changed = this.#dropInteraction(queue, sessionId, id) || changed;
    }
    for (const [sessionId, wait] of check.doubted) {
      if (this.#attention.get(sessionId) !== wait) continue;
      this.#attention.delete(sessionId);
      changed = true;
    }
    if (changed) this.#emit();
  }

  /**
   * The replay answering this phone's last `sync` to `machineId` is complete:
   * a prompt sent there before that sync which the replay neither confirmed
   * (its user message) nor lists as still queued never reached the host —
   * lost with a dropped link — so its echo stops waiting and shows as not
   * delivered. A replay answering another phone's sync, or none, settles
   * nothing: a prompt of ours may still be on its way.
   */
  #settlePrompts(machineId: string, frame: ReplayEndFrame): void {
    const sync = this.#syncs.get(machineId);
    if (frame.syncId === undefined || sync?.id !== frame.syncId) return;
    this.#syncs.delete(machineId);
    const queued = new Set(frame.queued);
    let changed = false;
    for (const [clientId, sent] of this.#sent) {
      if (sent.machineId !== machineId || sent.seq > sync.upTo) continue;
      if (queued.has(clientId)) continue;
      this.#sent.delete(clientId);
      const transcript = this.#transcripts.get(sent.sessionId);
      if (transcript && failLocalEcho(transcript, clientId)) changed = true;
    }
    if (changed) this.#emit();
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
    for (const [sessionId, wait] of this.#attention)
      if (drop(wait.machineId, sessionId)) this.#attention.delete(sessionId);
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
