import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { type Config, loadConfig, secretPaths } from "@omp-remote/config";
import { PairingStore } from "@omp-remote/crypto";
import { checkOwnerOnly, ipcPath, readSecret } from "@omp-remote/protocol/ipc";
import { bridgeInstallPath } from "../service/bridge";

export interface CheckResult {
  name: string;
  ok: boolean;
  /** For a failure: what is wrong and how to fix it. */
  detail?: string;
}

type Check = () => Promise<CheckResult>;

/** Where the server answers on this machine: a wildcard bind is reached over loopback. */
function localServerBase(cfg: Config): string | undefined {
  const listen = cfg.server?.listen;
  if (listen === undefined) return undefined;
  const host =
    listen.host === "0.0.0.0" || listen.host === "::"
      ? "127.0.0.1"
      : listen.host;
  return `http://${host}:${listen.port}`;
}

/** The HTTP base the agent dials, from `agent.serverUrl` (ws/wss mapped back). */
function agentHttpBase(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url.toString().replace(/\/+$/, "");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * What is wrong with who may read the secret at `path`, with the fix, or
 * `undefined` when only its owner may. Unix: no group or other mode bits.
 * Windows: `icacls` lists one principal, the current user, as install's
 * `restrictToOwner` leaves it; mode bits mean nothing there.
 */
async function sharedSecret(path: string): Promise<string | undefined> {
  if (process.platform !== "win32")
    return ((await stat(path)).mode & 0o077) === 0
      ? undefined
      : `${path} is readable by others → chmod 600 ${path}`;
  const failure = await checkOwnerOnly(path);
  if (failure === undefined) return undefined;
  const fix = "omp-remote install re-applies owner-only access";
  return failure === "acl-command-failed"
    ? `icacls cannot read the access list of ${path} → ${fix}`
    : `${path} is open to accounts other than ${userInfo().username} → ${fix}`;
}

function pass(name: string): CheckResult {
  return { name, ok: true };
}
function fail(name: string, detail: string): CheckResult {
  return { name, ok: false, detail };
}

function secretCheck(name: string, path: string, fix: string): Check {
  return async () => {
    if (!(await exists(path))) return fail(name, `${path} is missing → ${fix}`);
    const shared = await sharedSecret(path);
    return shared === undefined ? pass(name) : fail(name, shared);
  };
}

/**
 * Does the server accept this machine token? A plain GET to `/agent` is checked
 * like an upgrade: a bad token is 401, a good one reaches the upgrade and gets
 * 426. Nothing registers, so a running agent keeps its route.
 */
async function probeToken(
  httpBase: string,
  token: string,
): Promise<"ok" | "unauthorized" | "unreachable"> {
  try {
    const res = await fetch(`${httpBase}/agent`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 426) return "ok";
    return res.status === 401 ? "unauthorized" : "unreachable";
  } catch {
    return "unreachable";
  }
}

async function reachIpc(path: string): Promise<boolean> {
  const { promise, resolve: done } = Promise.withResolvers<boolean>();
  const socket = createConnection(path);
  socket.once("connect", () => {
    done(true);
    socket.destroy();
  });
  socket.once("error", () => done(false));
  return promise;
}

/** The checks for this machine's config, in the order a broken setup should be fixed. */
export function doctorChecks(cfg: Config): Check[] {
  const checks: Check[] = [];
  const server = cfg.server;
  if (server !== undefined) {
    const base = localServerBase(cfg);
    checks.push(
      secretCheck(
        "session secret",
        secretPaths.sessionSecret,
        "omp-remote init --force",
      ),
      async () =>
        (await exists(secretPaths.password)) || server.publicUrl !== undefined
          ? pass("sign-in method")
          : fail(
              "sign-in method",
              "no password is set and passkeys are off (no https publicUrl) → omp-remote passwd",
            ),
      async () => {
        const index = resolve(
          server.webRoot ?? resolve(import.meta.dir, "../../../web/dist"),
          "index.html",
        );
        return (await exists(index))
          ? pass("web app build")
          : fail(
              "web app build",
              `${index} is missing → omp-remote run builds it, or bun run --cwd apps/web build`,
            );
      },
      async () => {
        try {
          const res = await fetch(`${base}/auth/methods`);
          return res.ok
            ? pass("server answers")
            : fail(
                "server answers",
                `${base}/auth/methods returned ${res.status}`,
              );
        } catch {
          return fail(
            "server answers",
            `nothing listens on ${base} → omp-remote run (or omp-remote install)`,
          );
        }
      },
    );
  }
  const agent = cfg.agent;
  if (agent !== undefined) {
    checks.push(
      // `pair` re-issues the token whatever the role; `join --force` would
      // rewrite a host's config as agent-only and drop its server.
      secretCheck("machine token", secretPaths.agentToken, "omp-remote pair"),
      async () => {
        const token = await readSecret(secretPaths.agentToken);
        if (token === undefined)
          return fail(
            "machine accepted by server",
            "no machine token → omp-remote pair",
          );
        const base = agentHttpBase(agent.serverUrl);
        const outcome = await probeToken(base, token);
        if (outcome === "ok") return pass("machine accepted by server");
        return fail(
          "machine accepted by server",
          outcome === "unauthorized"
            ? "the server refused this machine's token (revoked?) → omp-remote pair"
            : `cannot reach ${base} → start the server, or check agent.serverUrl`,
        );
      },
      async () => {
        const store = new PairingStore(secretPaths.pairing);
        try {
          await store.load();
        } catch {
          return fail(
            "paired phone",
            `${secretPaths.pairing} is unreadable → omp-remote pair`,
          );
        }
        return store.peers().length > 0
          ? pass("paired phone")
          : fail(
              "paired phone",
              "no phone is paired with this machine → omp-remote pair",
            );
      },
      async () =>
        (await exists(bridgeInstallPath()))
          ? pass("omp bridge extension")
          : fail(
              "omp bridge extension",
              `${bridgeInstallPath()} is missing → omp-remote install`,
            ),
      async () =>
        (await reachIpc(ipcPath()))
          ? pass("host-agent running")
          : fail(
              "host-agent running",
              "the host-agent is not listening → omp-remote run (or omp-remote install)",
            ),
    );
  }
  return checks;
}

/** Run every check, print one line each, and return the exit code (1 on any failure). */
export async function doctor(
  opts: { load?: () => Promise<Config>; print?: (line: string) => void } = {},
): Promise<number> {
  const print = opts.print ?? console.log;
  let cfg: Config;
  try {
    cfg = await (opts.load ?? loadConfig)();
  } catch (err) {
    print(`FAIL config: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  print("ok   config");
  let failed = false;
  for (const check of doctorChecks(cfg)) {
    const result = await check();
    if (result.ok) print(`ok   ${result.name}`);
    else {
      failed = true;
      print(`FAIL ${result.name}: ${result.detail ?? ""}`);
    }
  }
  return failed ? 1 : 0;
}
