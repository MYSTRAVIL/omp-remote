/**
 * In-process client for omp's local Collab host registry (protocol v1), the
 * replacement for the old `omp collab list --json` / `omp collab link` shells.
 *
 * omp publishes one owner-only `<entryId>.json` per live Collab host under
 * `~/.omp/run/collab-hosts`, each recording a private IPC endpoint and a token.
 * We read that directory, skip dead pids, and query the survivors in parallel
 * over the endpoint (one NDJSON request per connection). Every metadata file
 * and every response line is Zod-parsed — the registry is a trust boundary.
 *
 * Windows twist: probing a *wedged* pipe pins a libuv threadpool thread for
 * ~30s. A per-entry deadline bounds a single probe, and a cooldown keeps a
 * timed-out endpoint out of the next few lists so repeated 5s reconciles never
 * drain the threadpool and stall the filesystem. We never delete omp's files.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type Scheduler, defaultScheduler } from "@omp-remote/protocol";
import { z } from "zod";
import { type CollabHostInfo, processAlive } from "./controller";

/** Discovery metadata / IPC protocol version. Mixed omp versions fail safely. */
const COLLAB_REGISTRY_VERSION = 1;
/** Reject responses beyond this size (a valid snapshot is well under it). */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Per-entry connect+response deadline while listing. */
const DEFAULT_QUERY_TIMEOUT_MS = 1_500;
/** How long a timed-out endpoint stays un-probed after a wedge. */
const DEFAULT_COOLDOWN_MS = 60_000;

const INSTANCE_ID_PATTERN = /^[a-z0-9-]{8,64}$/;

/**
 * Discovery metadata directory, mirroring omp's `collabHostsRuntimeDir()`:
 * `path.join(getBaseConfigRoot(), "run", "collab-hosts")` where the base config
 * root is `~/<PI_CONFIG_DIR or .omp>`. Deliberately profile-independent so a
 * host started under any profile is discoverable from any other.
 */
export function collabHostsRuntimeDir(): string {
  const configDirName = process.env.PI_CONFIG_DIR || ".omp";
  return path.join(os.homedir(), configDirName, "run", "collab-hosts");
}

const DiscoveryMetadataSchema = z.object({
  version: z.number(),
  instanceId: z.string().regex(INSTANCE_ID_PATTERN),
  pid: z.number().int().positive(),
  endpoint: z.string().min(1),
  createdAt: z.number(),
  token: z.string().min(1),
});
type DiscoveryMetadata = z.infer<typeof DiscoveryMetadataSchema>;

const SnapshotSchema = z.object({
  instanceId: z.string().regex(INSTANCE_ID_PATTERN),
  generation: z.number().int().min(1),
  pid: z.number().int(),
  sessionId: z.string(),
  sessionName: z.string().nullable(),
  cwd: z.string(),
  model: z.object({ provider: z.string(), id: z.string() }).nullable(),
  startedAt: z.number(),
  participants: z.number(),
  relayConnected: z.boolean(),
  inputRequired: z.boolean(),
  access: z.enum(["view", "control"]),
});
type CollabHostSnapshot = z.infer<typeof SnapshotSchema>;

/** The envelope common to every reply; the op-specific payload is parsed next. */
const ResponseEnvelopeSchema = z
  .object({ ok: z.boolean(), error: z.string().optional() })
  .passthrough();
const SnapshotResponseSchema = z.object({ snapshot: SnapshotSchema });
const LinkResponseSchema = z.object({ url: z.string().min(1) });

function parseDiscoveryMetadata(text: string): DiscoveryMetadata | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = DiscoveryMetadataSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type QueryResult =
  | { status: "ok"; value: unknown }
  | { status: "dead" }
  | { status: "timeout" }
  | { status: "skip"; error?: string };

/**
 * One request over one connection: connect, send `{v, token, ...request}` as a
 * single NDJSON line, read one bounded response line, then close. `timeout`
 * distinguishes a wedged endpoint (never answers) from a dead one (refused) so
 * the caller can cool down only the former; the socket is destroyed regardless.
 */
function query(
  meta: DiscoveryMetadata,
  request: Record<string, unknown>,
  timeoutMs: number,
  scheduler: Scheduler,
): Promise<QueryResult> {
  const { promise, resolve } = Promise.withResolvers<QueryResult>();
  let buffer = "";
  let settled = false;
  const socket = net.createConnection({ path: meta.endpoint });
  const cancelTimer = scheduler.setTimer(
    () => finish({ status: "timeout" }),
    timeoutMs,
  );
  const finish = (result: QueryResult): void => {
    if (settled) return;
    settled = true;
    cancelTimer();
    socket.destroy();
    resolve(result);
  };
  socket.setEncoding("utf8");
  socket.once("error", (err: NodeJS.ErrnoException) => {
    // Endpoints die with their host process: a refused or missing socket means
    // the host is gone. Any other error says nothing about liveness.
    const code = err.code;
    finish({
      status: code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : "skip",
    });
  });
  socket.once("connect", () => {
    socket.write(
      `${JSON.stringify({ v: COLLAB_REGISTRY_VERSION, token: meta.token, ...request })}\n`,
    );
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
      finish({ status: "skip" });
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(buffer.slice(0, newline));
    } catch {
      finish({ status: "skip" });
      return;
    }
    const parsed = ResponseEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      finish({ status: "skip" });
      return;
    }
    if (parsed.data.ok !== true) {
      // Authentication failure or a structured error: an unrelated endpoint
      // cannot satisfy stale metadata without the matching token.
      finish({ status: "skip", error: parsed.data.error });
      return;
    }
    finish({ status: "ok", value: raw });
  });
  socket.once("close", () => finish({ status: "skip" }));
  return promise;
}

/** One resolved host: the snapshot the lister keeps, plus the metadata to link it. */
interface ListedEntry {
  meta: DiscoveryMetadata;
  snapshot: CollabHostSnapshot;
}

function toHostInfo(snapshot: CollabHostSnapshot): CollabHostInfo {
  return {
    instanceId: snapshot.instanceId,
    generation: snapshot.generation,
    sessionId: snapshot.sessionId,
    cwd: snapshot.cwd,
    model: snapshot.model?.id ?? "",
    sessionName: snapshot.sessionName,
    pid: snapshot.pid,
    startedAt: snapshot.startedAt,
  };
}

export interface CollabRegistryClientOptions {
  /** Override the discovery metadata directory (tests). */
  dir?: string;
  /** Per-entry query deadline in ms; default 1500. */
  timeoutMs?: number;
  /** How long a wedged (timed-out) endpoint is skipped; default 60000ms. */
  cooldownMs?: number;
  /** Clock for cooldown bookkeeping; defaults to `Date.now`. */
  now?: () => number;
  /** Timer source for the per-query deadline; defaults to the global timers. */
  scheduler?: Scheduler;
}

/**
 * Drop-in replacement for the CLI's `listHosts` / `linkFor` injected into
 * {@link CollabController}. `listHosts` reads the registry directory and probes
 * live hosts concurrently; `linkFor` reuses the metadata from the most recent
 * list (no re-listing) and resolves the control URL, throwing on any failure so
 * the controller's existing attach-failed path handles it.
 */
export class CollabRegistryClient {
  readonly #dir: string;
  readonly #timeoutMs: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #scheduler: Scheduler;
  /** endpoint -> epoch ms until which it must not be probed again. */
  readonly #cooldown = new Map<string, number>();
  /** instanceId -> the entry observed by the most recent successful list. */
  readonly #lastList = new Map<string, ListedEntry>();

  constructor(options: CollabRegistryClientOptions = {}) {
    this.#dir = options.dir ?? collabHostsRuntimeDir();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#now = options.now ?? Date.now;
    this.#scheduler = options.scheduler ?? defaultScheduler;
  }

  listHosts = async (): Promise<CollabHostInfo[]> => {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.#dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    // `.json.tmp` in-progress writes never match the `.json` filter.
    const candidates = names.filter((name) => name.endsWith(".json")).sort();

    // Metadata reads are cheap and small; parse them first, then probe the
    // live endpoints in parallel — the probe is the part that can wedge.
    const metas: DiscoveryMetadata[] = [];
    const present = new Set<string>();
    for (const name of candidates) {
      let text: string;
      try {
        text = await fs.promises.readFile(path.join(this.#dir, name), "utf8");
      } catch {
        continue;
      }
      const meta = parseDiscoveryMetadata(text);
      if (!meta) continue;
      if (meta.version !== COLLAB_REGISTRY_VERSION) continue;
      if (!processAlive(meta.pid)) continue;
      metas.push(meta);
      present.add(meta.endpoint);
    }

    const now = this.#now();
    const probed = await Promise.all(
      metas.map((meta) => this.#probe(meta, now)),
    );
    const live = probed.filter((entry): entry is ListedEntry => entry !== null);
    live.sort(
      (a, b) =>
        a.snapshot.startedAt - b.snapshot.startedAt ||
        a.snapshot.pid - b.snapshot.pid ||
        a.snapshot.instanceId.localeCompare(b.snapshot.instanceId),
    );

    // Forget cooldowns for endpoints that have left the registry so the map
    // stays bounded to hosts we could still see.
    for (const endpoint of this.#cooldown.keys()) {
      if (!present.has(endpoint)) this.#cooldown.delete(endpoint);
    }

    this.#lastList.clear();
    for (const entry of live)
      this.#lastList.set(entry.snapshot.instanceId, entry);
    return live.map((entry) => toHostInfo(entry.snapshot));
  };

  linkFor = async (instanceId: string): Promise<string> => {
    const entry = this.#lastList.get(instanceId);
    if (!entry) {
      throw new Error(`no listed Collab host for instance ${instanceId}`);
    }
    const result = await query(
      entry.meta,
      { op: "link", access: "control", generation: entry.snapshot.generation },
      this.#timeoutMs,
      this.#scheduler,
    );
    if (result.status === "ok") {
      const parsed = LinkResponseSchema.safeParse(result.value);
      if (parsed.success) return parsed.data.url;
      throw new Error(
        `Collab host ${instanceId} returned an invalid link response`,
      );
    }
    if (result.status === "skip" && result.error === "stale_generation") {
      throw new Error(
        `Collab host ${instanceId} started a new room since it was listed`,
      );
    }
    throw new Error(
      `Collab host ${instanceId} did not answer the link request`,
    );
  };

  /** Probe one endpoint, honoring and maintaining the wedged-endpoint cooldown. */
  async #probe(
    meta: DiscoveryMetadata,
    now: number,
  ): Promise<ListedEntry | null> {
    const cooledUntil = this.#cooldown.get(meta.endpoint);
    // A cooled-down endpoint is simply omitted; the controller keeps any room
    // it already attached while the pid is alive, so nothing is lost.
    if (cooledUntil !== undefined && now < cooledUntil) return null;

    const result = await query(
      meta,
      { op: "snapshot" },
      this.#timeoutMs,
      this.#scheduler,
    );
    if (result.status === "timeout") {
      this.#cooldown.set(meta.endpoint, now + this.#cooldownMs);
      return null;
    }
    if (result.status !== "ok") return null;
    this.#cooldown.delete(meta.endpoint);
    const parsed = SnapshotResponseSchema.safeParse(result.value);
    if (!parsed.success) return null;
    return { meta, snapshot: parsed.data.snapshot };
  }
}
