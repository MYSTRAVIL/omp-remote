/**
 * Reconciles the machine's live Collab rooms into bridged sessions. On each
 * refresh it lists the local Collab hosts, attaches a {@link CollabAdapter} for
 * any newly seen room (fetching its control link), and stops adapters for rooms
 * that vanished. Every attached room enters the AgentService registry, so it
 * appears in the phone's existing session list and is driven over the existing
 * prompt/interrupt/interactionReply contract — no new phone frame required.
 *
 * The omp CLI calls (`collab list` / `collab link`) are injected so the
 * controller is pure and unit-testable; main.ts supplies the real shells.
 */
import { basename } from "node:path";
import type { SessionMeta } from "@omp-remote/protocol";
import { type AgentDiagnosticSink, noAgentDiagnostic } from "../diagnostics";
import { CollabAdapter, type CollabSessionSink } from "./adapter";
import type { GuestSocketFactory } from "./guest";

/** True when `pid` is a live OS process. Signal 0 probes existence without
 *  delivering a signal; EPERM means it exists but is not signalable by us. A
 *  non-positive or non-integer pid is treated as live so a bad value never reaps. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

/** One live Collab host on this machine (a projection of `omp collab list --json`). */
export interface CollabHostInfo {
  instanceId: string;
  /** Room number within the process; omp bumps it on an in-process session switch. */
  generation: number;
  sessionId: string;
  cwd: string;
  model: string;
  sessionName: string | null;
  pid: number;
  startedAt: number;
}

export interface CollabControllerOptions {
  service: CollabSessionSink;
  /** Enumerate live Collab hosts (wraps `omp collab list --json`). */
  listHosts: () => Promise<CollabHostInfo[]>;
  /** Fetch a control link for a host (wraps `omp collab link <instanceId> --json`). */
  linkFor: (instanceId: string) => Promise<string>;
  /** True while a pid is a live process. A room that vanished from the host
   *  list is only detached once its process is gone; injected in tests. */
  isAlive?: (pid: number) => boolean;
  /** Passed to each adapter's guest; overridden in tests. */
  socketFactory?: GuestSocketFactory;
  /** A session id to never bridge (e.g. the agent's own control session). */
  excludeSessionId?: string;
  /** Poll interval for {@link CollabController.start}; default 5s. */
  intervalMs?: number;
  /** Privacy-safe operational diagnostics. */
  diagnostic?: AgentDiagnosticSink;
}

function toMeta(host: CollabHostInfo): SessionMeta {
  return {
    id: host.sessionId,
    cwd: host.cwd,
    project: basename(host.cwd) || host.cwd,
    model: host.model,
    title: host.sessionName ?? "",
    pid: host.pid,
    startedAt: host.startedAt,
  };
}

export class CollabController {
  readonly #opts: CollabControllerOptions;
  /** Attached rooms keyed by instanceId, with the room generation they bridge. */
  readonly #adapters = new Map<
    string,
    { adapter: CollabAdapter; generation: number }
  >();
  #timer: Timer | undefined;
  #refreshing = false;
  readonly #diagnostic: AgentDiagnosticSink;
  #discoveryFailure:
    | { code: "list-failed" | "refresh-failed"; suppressedCount: number }
    | undefined;
  readonly #attachFailures = new Set<string>();
  readonly #isAlive: (pid: number) => boolean;

  constructor(opts: CollabControllerOptions) {
    this.#opts = opts;
    this.#diagnostic = opts.diagnostic ?? noAgentDiagnostic;
    this.#isAlive = opts.isAlive ?? processAlive;
  }

  /** Begin periodic reconciliation. Safe to call once; a running controller ignores it. */
  start(): void {
    if (this.#timer) return;
    this.#diagnostic({ event: "collab_discovery_started" });
    void this.refresh();
    this.#timer = setInterval(
      () => void this.refresh(),
      this.#opts.intervalMs ?? 5000,
    );
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    for (const { adapter } of this.#adapters.values()) adapter.stop();
    this.#adapters.clear();
    this.#diagnostic({ event: "collab_discovery_stopped" });
  }

  /** Current bridged instance ids (for tests/inspection). */
  get attached(): string[] {
    return [...this.#adapters.keys()];
  }

  /** One reconciliation pass: attach newly seen rooms, detach vanished ones. */
  async refresh(): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      let hosts: CollabHostInfo[];
      try {
        hosts = await this.#opts.listHosts();
      } catch {
        this.#reportDiscoveryFailure("list-failed");
        return;
      }
      this.#reportDiscoveryRecovery();

      const seen = new Set<string>();
      const pending: CollabHostInfo[] = [];
      for (const host of hosts) {
        if (host.sessionId === this.#opts.excludeSessionId) continue;
        // The IPC bridge (fallback) owns this session; don't double-bridge it.
        if (this.#opts.service.hasIpcSession(host.sessionId)) continue;
        seen.add(host.instanceId);
        const current = this.#adapters.get(host.instanceId);
        if (current?.generation === host.generation) continue;
        // Same process, new room (/new, /resume, fork): the old room is gone,
        // so drop its adapter before bridging the new session.
        if (current) this.#detach(host.instanceId, current.adapter);
        pending.push(host);
      }
      // Attach every newly seen room concurrently: each link fetch + guest
      // connect is independent I/O, and one slow or wedged host must not stall
      // the others. Failures are swallowed per host, so this never rejects.
      await Promise.all(pending.map((host) => this.#attachHost(host)));
      for (const [instanceId, { adapter }] of this.#adapters) {
        if (seen.has(instanceId)) continue;
        // A room can vanish from the host list transiently (relay reconnect or
        // re-host) while its process is alive; keep such a session bridged and
        // listed, and detach only once the process is gone.
        if (this.#isAlive(adapter.pid)) continue;
        this.#detach(instanceId, adapter);
      }
    } catch {
      this.#reportDiscoveryFailure("refresh-failed");
    } finally {
      this.#refreshing = false;
    }
  }

  #detach(instanceId: string, adapter: CollabAdapter): void {
    adapter.stop();
    this.#adapters.delete(instanceId);
    this.#diagnostic({
      event: "collab_session_detached",
      sessionId: adapter.sessionId,
      code: "not-discovered",
    });
  }

  async #attach(host: CollabHostInfo): Promise<void> {
    const link = await this.#opts.linkFor(host.instanceId);
    const adapter = new CollabAdapter({
      meta: toMeta(host),
      link,
      service: this.#opts.service,
      socketFactory: this.#opts.socketFactory,
      diagnostic: this.#diagnostic,
    });
    try {
      await adapter.start();
      this.#adapters.set(host.instanceId, {
        adapter,
        generation: host.generation,
      });
    } catch (error) {
      adapter.stop();
      throw error;
    }
  }

  /** Attach one host, logging its attach failure once per session until it recovers. */
  async #attachHost(host: CollabHostInfo): Promise<void> {
    try {
      await this.#attach(host);
      this.#attachFailures.delete(host.sessionId);
    } catch {
      if (this.#attachFailures.has(host.sessionId)) return;
      this.#attachFailures.add(host.sessionId);
      this.#diagnostic({
        event: "collab_attach_failed",
        sessionId: host.sessionId,
        code: "attach-failed",
      });
    }
  }

  #reportDiscoveryFailure(code: "list-failed" | "refresh-failed"): void {
    if (this.#discoveryFailure?.code === code) {
      this.#discoveryFailure.suppressedCount += 1;
      return;
    }
    this.#discoveryFailure = { code, suppressedCount: 0 };
    this.#diagnostic({ event: "collab_discovery_failed", code });
  }

  #reportDiscoveryRecovery(): void {
    const failure = this.#discoveryFailure;
    if (!failure) return;
    this.#discoveryFailure = undefined;
    this.#diagnostic({
      event: "collab_discovery_recovered",
      suppressedCount: failure.suppressedCount,
    });
  }
}
