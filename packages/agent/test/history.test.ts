import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStoredSession, listStoredSessions } from "../src/history";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function agentDir(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-remote-history-"));
  roots.push(root);
  return root;
}

interface Stored {
  id: string;
  cwd: string;
  /** The live title record (line 1); omitted = no title record. */
  title?: string;
  /** The header's own title. */
  headerTitle?: string;
  startedAt?: number;
  /** File mtime, epoch ms. */
  lastActiveAt: number;
  /** Encoded project directory; omp's encoding is lossy, so any name works. */
  dir?: string;
}

/** Write one session file in omp's store layout. */
function store(root: string, s: Stored): string {
  const dir = join(root, "sessions", s.dir ?? "-proj");
  mkdirSync(dir, { recursive: true });
  const started = new Date(s.startedAt ?? 1_000);
  const lines: string[] = [];
  if (s.title !== undefined)
    lines.push(
      JSON.stringify({
        type: "title",
        v: 1,
        title: s.title,
        source: "auto",
        updatedAt: started.toISOString(),
        pad: " ".repeat(130),
      }),
    );
  lines.push(
    JSON.stringify({
      type: "session",
      version: 3,
      id: s.id,
      timestamp: started.toISOString(),
      cwd: s.cwd,
      ...(s.headerTitle === undefined ? {} : { title: s.headerTitle }),
    }),
  );
  lines.push(JSON.stringify({ type: "model_change", id: "m1", model: "x/y" }));
  const file = join(
    dir,
    `${started.toISOString().replace(/[:.]/g, "-")}_${s.id}.jsonl`,
  );
  writeFileSync(file, `${lines.join("\n")}\n`);
  const at = new Date(s.lastActiveAt);
  utimesSync(file, at, at);
  return file;
}

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

test("lists only the sessions whose header cwd is the requested one, across store dirs", async () => {
  const root = agentDir();
  store(root, { id: A, cwd: "/home/me/proj", title: "A", lastActiveAt: 5_000 });
  // Same project, a differently encoded directory: the header decides.
  store(root, {
    id: B,
    cwd: "/home/me/proj",
    title: "B",
    lastActiveAt: 6_000,
    dir: "-other",
  });
  // The lossy encoding collides for another project; it is filtered out.
  store(root, { id: C, cwd: "/home/me-proj", title: "C", lastActiveAt: 7_000 });

  const entries = await listStoredSessions("/home/me/proj", {
    agentDir: root,
    exclude: new Set(),
    platform: "linux",
  });
  expect(entries).toEqual([
    { sessionId: B, title: "B", startedAt: 1_000, lastActiveAt: 6_000 },
    { sessionId: A, title: "A", startedAt: 1_000, lastActiveAt: 5_000 },
  ]);
});

test("POSIX cwd matching is exact", async () => {
  const root = agentDir();
  store(root, { id: A, cwd: "/home/me/Proj", lastActiveAt: 5_000 });
  const opts = {
    agentDir: root,
    exclude: new Set<string>(),
    platform: "linux",
  } as const;
  expect(await listStoredSessions("/home/me/proj", opts)).toEqual([]);
  expect(await listStoredSessions("/home/me/Proj/", opts)).toEqual([]);
  expect(await listStoredSessions("/home/me/Proj", opts)).toHaveLength(1);
});

test("win32 cwd matching ignores case, slash direction and trailing separators", async () => {
  const root = agentDir();
  store(root, {
    id: A,
    cwd: "C:\\Users\\Me\\Proj",
    lastActiveAt: 5_000,
  });
  for (const cwd of [
    "c:/users/me/proj",
    "C:\\USERS\\ME\\PROJ\\",
    "C:/Users/Me/Proj//",
  ])
    expect(
      await listStoredSessions(cwd, {
        agentDir: root,
        exclude: new Set(),
        platform: "win32",
      }),
    ).toHaveLength(1);
  expect(
    await listStoredSessions("C:\\Users\\Me\\Proj2", {
      agentDir: root,
      exclude: new Set(),
      platform: "win32",
    }),
  ).toEqual([]);
});

test("the title record wins, the header title is the fallback, and an empty title is omitted", async () => {
  const root = agentDir();
  store(root, {
    id: A,
    cwd: "/p",
    title: "Renamed",
    headerTitle: "First",
    lastActiveAt: 3_000,
  });
  store(root, {
    id: B,
    cwd: "/p",
    headerTitle: "Header only",
    lastActiveAt: 2_000,
  });
  store(root, {
    id: C,
    cwd: "/p",
    title: "",
    headerTitle: "",
    lastActiveAt: 1_000,
  });

  const entries = await listStoredSessions("/p", {
    agentDir: root,
    exclude: new Set(),
    platform: "linux",
  });
  expect(entries.map((e) => [e.sessionId, e.title])).toEqual([
    [A, "Renamed"],
    [B, "Header only"],
    [C, undefined],
  ]);
  expect("title" in (entries[2] ?? {})).toBe(false);
});

test("running sessions are excluded and ids outside StoredSessionId are dropped", async () => {
  const root = agentDir();
  store(root, { id: A, cwd: "/p", lastActiveAt: 3_000 });
  store(root, { id: B, cwd: "/p", lastActiveAt: 2_000 });
  store(root, { id: "NOT-A-VALID-ID&calc", cwd: "/p", lastActiveAt: 1_000 });

  const entries = await listStoredSessions("/p", {
    agentDir: root,
    exclude: new Set([A]),
    platform: "linux",
  });
  expect(entries.map((e) => e.sessionId)).toEqual([B]);
});

test("entries sort by last activity, newest first, capped at the limit", async () => {
  const root = agentDir();
  const ids = Array.from(
    { length: 6 },
    (_, i) => `${i}0000000-0000-4000-8000-00000000000${i}`,
  );
  ids.forEach((id, i) =>
    store(root, {
      id,
      cwd: "/p",
      lastActiveAt: ([4, 1, 6, 3, 5, 2][i] ?? 0) * 1_000,
    }),
  );
  const entries = await listStoredSessions("/p", {
    agentDir: root,
    exclude: new Set(),
    limit: 3,
    platform: "linux",
  });
  expect(entries.map((e) => e.lastActiveAt)).toEqual([6_000, 5_000, 4_000]);
});

test("malformed, truncated and unrelated files are skipped without failing the list", async () => {
  const root = agentDir();
  store(root, { id: A, cwd: "/p", title: "good", lastActiveAt: 3_000 });
  const dir = join(root, "sessions", "-proj");
  writeFileSync(join(dir, "garbage.jsonl"), "not json at all\n{");
  writeFileSync(join(dir, "empty.jsonl"), "");
  writeFileSync(
    join(dir, "no-header.jsonl"),
    `${JSON.stringify({ type: "title", v: 1, title: "orphan" })}\n`,
  );
  writeFileSync(
    join(dir, "bad-time.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: B, timestamp: "never", cwd: "/p" })}\n`,
  );
  writeFileSync(join(dir, "notes.txt"), "ignored");
  // A stray file where a project directory is expected.
  writeFileSync(join(root, "sessions", "stray.jsonl"), "x");

  const entries = await listStoredSessions("/p", {
    agentDir: root,
    exclude: new Set(),
    platform: "linux",
  });
  expect(entries.map((e) => e.sessionId)).toEqual([A]);
});

test("a header past the read head is not read, so a huge transcript costs only its head", async () => {
  const root = agentDir();
  const dir = join(root, "sessions", "-proj");
  mkdirSync(dir, { recursive: true });
  // A first line longer than the head: the header cannot be found in it.
  writeFileSync(
    join(dir, "huge.jsonl"),
    `${JSON.stringify({ type: "title", v: 1, title: "x", pad: " ".repeat(64 * 1024) })}\n${JSON.stringify({ type: "session", version: 3, id: A, timestamp: new Date(0).toISOString(), cwd: "/p" })}\n`,
  );
  expect(
    await listStoredSessions("/p", {
      agentDir: root,
      exclude: new Set(),
      platform: "linux",
    }),
  ).toEqual([]);
});

test("a missing session store lists nothing", async () => {
  expect(
    await listStoredSessions("/p", {
      agentDir: join(agentDir(), "absent"),
      exclude: new Set(),
    }),
  ).toEqual([]);
});

test("findStoredSession finds an id only under its own cwd", async () => {
  const root = agentDir();
  store(root, { id: A, cwd: "/p", title: "A", lastActiveAt: 3_000 });
  store(root, { id: B, cwd: "/other", lastActiveAt: 2_000 });
  const opts = { agentDir: root, platform: "linux" } as const;
  expect(await findStoredSession("/p", A, opts)).toEqual({
    sessionId: A,
    title: "A",
    startedAt: 1_000,
    lastActiveAt: 3_000,
  });
  expect(await findStoredSession("/p", B, opts)).toBeUndefined();
  expect(await findStoredSession("/p", C, opts)).toBeUndefined();
});
