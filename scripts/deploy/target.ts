/**
 * Deploy target for `deploy:web` and `deploy:aggregator`, read from the
 * environment. Bun loads the gitignored repo-root `.env` when these run from the
 * repo root; `.env.example` lists the names. There is no default host: a deploy
 * with no configured target stops before building or connecting anywhere.
 */
export interface DeployTarget {
  /** ssh destination of the VPS (host alias or user@host). */
  host: string;
  /** Public base URL of the hosted PWA, without a trailing slash. */
  publicUrl: string;
}

function required(name: string, example: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  console.error(
    `${name} is not set. Add it to the repo-root .env (see .env.example), for example ${name}=${example}`,
  );
  process.exit(1);
}

export function deployTarget(): DeployTarget {
  const host = required("OMP_DEPLOY_HOST", "my-vps");
  const publicUrl = required(
    "OMP_DEPLOY_URL",
    "https://omp-remote.example.com",
  ).replace(/\/$/, "");
  return { host, publicUrl };
}
