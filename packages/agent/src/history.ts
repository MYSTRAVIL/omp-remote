import { type FileHandle, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type HistoryEntry, StoredSessionId } from "@omp-remote/protocol";
import { z } from "zod";

/** Where omp keeps its session store, and how cwds compare on this host. */
export interface SessionStoreOptions {
  /** omp's agent directory; defaults to `PI_CODING_AGENT_DIR`, else `~/.omp/agent`. */
  agentDir?: string;
  /** Override platform detection (tests only): win32 compares cwds loosely. */
  platform?: NodeJS.Platform;
}

export interface ListStoredSessionsOptions extends SessionStoreOptions {
  /** Session ids to leave out: the sessions running on the machine now. */
  exclude: ReadonlySet<string>;
  /** Most entries returned, newest activity first. */
  limit?: number;
}

/** Bytes read from the start of each session file. The title record and the
 *  session header open the file; the transcript after them is never read. */
const HEAD_BYTES = 8 * 1024;

/** omp's live title record: line 1 when present, rewritten in place. */
const TitleRecord = z.object({ type: z.literal("title"), title: z.string() });
/** omp's session header: line 1, or line 2 after a title record. */
const SessionHeader = z.object({
  type: z.literal("session"),
  id: z.string(),
  timestamp: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
});
/** Any persisted transcript entry that is a message (user/assistant/toolResult).
 *  Its presence in the head means the session is not a header-only stub. */
const MessageEntry = z.object({ type: z.literal("message") });

/** The comparable form of a cwd. omp's store-directory encoding is lossy, so
 *  the header `cwd` is matched instead: exactly on POSIX; on win32 without case,
 *  with `/` read as `\` and trailing separators dropped (a drive root keeps its). */
function cwdKey(platform: NodeJS.Platform, cwd: string): string {
  if (platform !== "win32") return cwd;
  const unified = cwd.replace(/\//g, "\\").toLowerCase();
  const trimmed = unified.replace(/\\+$/, "");
  return /^[a-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

function parseLine<T>(schema: z.ZodType<T>, line: string): T | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** One session file's entry, when its head names a session of `key`'s cwd.
 *  An unreadable or malformed file yields nothing. */
async function readEntry(
  file: string,
  key: string,
  platform: NodeJS.Platform,
): Promise<HistoryEntry | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, "r");
    const { mtimeMs } = await handle.stat();
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    const lines = buf.toString("utf8", 0, bytesRead).split("\n");
    // A full head may end mid-line; that last piece is not a record.
    if (bytesRead === HEAD_BYTES) lines.pop();
    const first = lines[0] ?? "";
    const title = parseLine(TitleRecord, first);
    const header = parseLine(SessionHeader, title ? (lines[1] ?? "") : first);
    if (!header || cwdKey(platform, header.cwd) !== key) return undefined;
    if (!StoredSessionId.safeParse(header.id).success) return undefined;
    const startedAt = Date.parse(header.timestamp);
    if (Number.isNaN(startedAt)) return undefined;
    const name = title ? title.title : header.title;
    // Match omp's resume picker (`isEmptySession`): an untitled, header-only
    // session with no persisted message is a `newSession()`/`ensureOnDisk()`
    // stub — drop it. A title, or any message (a first prompt worth resuming or
    // an assistant turn), keeps it. The first message follows the header, so the
    // head already read decides; a stub has no message anywhere.
    if (!name) {
      const hasMessage = lines
        .slice(title ? 2 : 1)
        .some((line) => parseLine(MessageEntry, line) !== undefined);
      if (!hasMessage) return undefined;
    }
    return {
      sessionId: header.id,
      ...(name ? { title: name } : {}),
      startedAt,
      lastActiveAt: Math.floor(mtimeMs),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Every stored session of `cwd`, in no particular order. Scans every project
 *  directory of the store: the directory names cannot be decoded reliably. A
 *  missing store is empty; any other failure to list it rejects. */
async function scan(
  cwd: string,
  opts: SessionStoreOptions,
): Promise<HistoryEntry[]> {
  const platform = opts.platform ?? process.platform;
  const root = join(
    opts.agentDir ??
      (process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent")),
    "sessions",
  );
  const projects = await readdir(root, { withFileTypes: true }).catch(
    (err: unknown) => {
      if (err instanceof Error && "code" in err && err.code === "ENOENT")
        return [];
      throw err;
    },
  );
  const key = cwdKey(platform, cwd);
  const perProject = await Promise.all(
    projects
      .filter((d) => d.isDirectory())
      .map(async (d) => {
        const dir = join(root, d.name);
        const files = await readdir(dir, { withFileTypes: true }).catch(
          () => [],
        );
        return Promise.all(
          files
            .filter((f) => f.isFile() && f.name.endsWith(".jsonl"))
            .map((f) => readEntry(join(dir, f.name), key, platform)),
        );
      }),
  );
  const entries: HistoryEntry[] = [];
  for (const project of perProject)
    for (const entry of project) if (entry) entries.push(entry);
  return entries;
}

/**
 * The stored omp sessions of `cwd` for a phone's history request: newest
 * `lastActiveAt` first, at most `limit`, without the `exclude`d (running) ids.
 * Only the head of each session file is read.
 */
export async function listStoredSessions(
  cwd: string,
  { exclude, limit = 50, ...opts }: ListStoredSessionsOptions,
): Promise<HistoryEntry[]> {
  const entries = (await scan(cwd, opts)).filter(
    (e) => !exclude.has(e.sessionId),
  );
  entries.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return entries.slice(0, limit);
}

/** The stored session `id` of `cwd`, or undefined when that project has none
 *  by that id: a resume spawn is refused unless the store holds it. */
export async function findStoredSession(
  cwd: string,
  id: string,
  opts: SessionStoreOptions = {},
): Promise<HistoryEntry | undefined> {
  return (await scan(cwd, opts)).find((e) => e.sessionId === id);
}
