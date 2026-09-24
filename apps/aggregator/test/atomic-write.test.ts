import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/atomic-write";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

test.skipIf(process.platform !== "win32")(
  "a rewrite on Windows leaves the file granted to the current user alone, whatever the directory grants",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-atomic-"));
    dirs.push(dir);
    const path = join(dir, "machines.json");
    // An earlier file with the directory's inherited ACL, as before the fix.
    await writeFile(path, "old");
    const failures: string[] = [];
    await writeFileAtomic(path, "new", 0o600, {
      onAclFailure: (f) => failures.push(f),
    });
    expect(failures).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("new");
    // Read the ACL back independently: one ACE, for the current user.
    const listing = Bun.spawnSync(["icacls", path]).stdout.toString();
    const aces = listing
      .slice(path.length)
      .split(/\r?\n/)
      .map((line) => line.trim());
    const granted = aces.slice(0, aces.indexOf(""));
    expect(granted).toHaveLength(1);
    expect(granted[0]?.toLowerCase()).toContain(
      `\\${userInfo().username.toLowerCase()}:`,
    );
  },
);
