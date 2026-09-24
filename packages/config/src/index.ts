import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type SecretOptions,
  restrictToOwner,
  stateDir,
} from "@omp-remote/protocol/ipc";
import { Config } from "./schema";

export { AgentSection, Config, MachineId, ServerSection } from "./schema";

/** A config file that is missing, unreadable, or fails the schema. The message names the path. */
export class ConfigError extends Error {}

export function configPath(): string {
  return join(stateDir(), "config.json");
}

function inState(name: string): string {
  return join(stateDir(), name);
}

/** Secret and state files beside config.json. Getters so OMP_REMOTE_STATE_DIR is read at use. */
export const secretPaths = {
  get sessionSecret() {
    return inState("session-secret");
  },
  get agentToken() {
    return inState("agent-token");
  },
  get credentials() {
    return inState("credentials.json");
  },
  get password() {
    return inState("password.json");
  },
  get machines() {
    return inState("machines.json");
  },
  get vapid() {
    return inState("vapid.json");
  },
  get pushSubscriptions() {
    return inState("push-subscriptions.json");
  },
  get pairing() {
    return inState("pairing.json");
  },
};

/**
 * Write via a temp file + rename so a crash never leaves a half-written file.
 * Owner-only: 0600 on POSIX; on Windows the temp file is restricted to the
 * current user before the rename carries its ACL to `path`, and a failure to
 * is reported to `opts.onAclFailure`, never thrown, as for `loadOrCreateSecret`.
 */
export async function writeFileAtomic(
  path: string,
  content: string,
  opts: SecretOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600 });
    if (process.platform === "win32") {
      const failure = await restrictToOwner(temp);
      if (failure) opts.onAclFailure?.(failure);
    }
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

export async function saveConfig(c: Config): Promise<void> {
  await writeFileAtomic(
    configPath(),
    `${JSON.stringify(Config.parse(c), null, 2)}\n`,
  );
}

export async function loadConfig(): Promise<Config> {
  const path = configPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT")
      throw new ConfigError(
        `no config at ${path}; run \`omp-remote init\` or \`omp-remote join <url>\``,
      );
    throw new ConfigError(`cannot read ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  const result = Config.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`${path}: ${issues}`);
  }
  return result.data;
}
