import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type SecretOptions, restrictToOwner } from "@omp-remote/protocol/ipc";

/**
 * Replace the file at `path` with `data` so a crash at any point leaves either
 * the old file or the new one whole, never a torn mix. The bytes go to a fresh
 * temp file beside `path` (same directory, so the rename never crosses a
 * filesystem), created with `mode` from the first byte and fsynced, which then
 * renames over `path`. On Windows, where `mode` means nothing, the temp file is
 * first restricted to the current user — the rename carries its ACL to `path`
 * — and a failure to is reported to `opts.onAclFailure`, never thrown, as for
 * `loadOrCreateSecret`. A failed write removes its temp file and leaves `path`
 * untouched; a crash may leave one stray `*.tmp` beside it, which no load ever
 * reads. Once the rename lands this never rejects: on POSIX it then fsyncs the
 * directory so the rename survives a power loss, best effort, since the new
 * state is already what `path` holds.
 */
export async function writeFileAtomic(
  path: string,
  data: string,
  mode: number,
  opts: SecretOptions = {},
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    // `wx`: never follow or reuse an existing file at the temp name.
    await writeFile(temp, data, { mode, flag: "wx" });
    await fsync(temp, "r+");
    if (process.platform === "win32") {
      const failure = await restrictToOwner(temp);
      if (failure) opts.onAclFailure?.(failure);
    }
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  // Windows cannot open a directory to flush it; NTFS journals the rename.
  if (process.platform !== "win32")
    await fsync(dir, "r").catch(() => undefined);
}

async function fsync(path: string, flags: string): Promise<void> {
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
