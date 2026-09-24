/**
 * Version gate for Collab discovery. Host enumeration and link resolution are
 * now handled in-process by {@link CollabRegistryClient}; the only thing that
 * still shells out to the omp CLI is the `--version` probe that decides whether
 * this omp is new enough to expose the local Collab host registry at all.
 */

export const MIN_OMP_VERSION = "18.1.20";

/** Extract a semver triple from arbitrary version text (e.g. `omp/18.1.20`). */
function parseSemver(
  text: string,
): { major: number; minor: number; patch: number } | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** True when `version` is at or above the Collab min-omp floor. */
export function meetsMinOmp(
  version: string,
  floor: string = MIN_OMP_VERSION,
): boolean {
  const v = parseSemver(version);
  const f = parseSemver(floor);
  if (!v || !f) return false;
  if (v.major !== f.major) return v.major > f.major;
  if (v.minor !== f.minor) return v.minor > f.minor;
  return v.patch >= f.patch;
}

/** Read the installed omp version string (e.g. `omp/18.2.5`) from `bin`. */
export async function ompVersion(bin: string): Promise<string> {
  const proc = Bun.spawn([bin, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim();
}
