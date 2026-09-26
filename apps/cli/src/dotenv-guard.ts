import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The files Bun autoloads from the working directory into `process.env`
 * unless started with `--no-env-file`: `.env`, `.env.local` and the
 * `NODE_ENV`-specific pair, for every `NODE_ENV` it knows.
 */
const AUTOLOADED = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
] as const;

/**
 * The `.env` files Bun may have loaded from `cwd` into this process: none when
 * it ran with `--no-env-file`. omp-remote takes no config from the
 * environment, so any of them means a directory the user may not trust could
 * have set `OMP_REMOTE_STATE_DIR`, a proxy, or TLS settings.
 */
export function autoloadedEnvFiles(
  cwd: string,
  execArgv: readonly string[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (execArgv.includes("--no-env-file")) return [];
  return AUTOLOADED.map((name) => join(cwd, name)).filter(exists);
}
