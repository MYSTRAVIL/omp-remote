import { parseArgs } from "node:util";
import { MachineStore } from "@omp-remote/aggregator/src/machine-store";
import { setPassword } from "@omp-remote/aggregator/src/password";
import { generateVapidKeys } from "@omp-remote/aggregator/src/vapid";
import {
  Config,
  MachineId,
  ServerSection,
  configPath,
  saveConfig,
  secretPaths,
  writeFileAtomic,
} from "@omp-remote/config";
import { loadOrCreateSecret } from "@omp-remote/protocol/ipc";
import type { CliDeps } from "../deps";
import { phoneUrls } from "../urls";
import { readNewPassword } from "./passwd";

const DEFAULT_PORT = 8788;

/** `os.hostname()` as a machine name: runs of other characters become `-`. */
export function defaultMachineName(hostname: string): string {
  const name = hostname
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return name === "" ? "machine" : name;
}

/** `raw` as a machine name, or an error saying what a name may hold. */
export function parseMachineName(raw: string): string {
  const parsed = MachineId.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `invalid machine name "${raw}": use 1-64 letters, digits, '.', '_' or '-'`,
    );
  return parsed.data;
}

/** Throw unless `force` when this machine already has a config. */
export async function refuseExistingConfig(force: boolean): Promise<void> {
  if (!force && (await Bun.file(configPath()).exists()))
    throw new Error(
      `${configPath()} already exists; pass --force to replace it`,
    );
}

/** The origin a public HTTPS reverse proxy serves, as the config requires. */
function parsePublicUrl(raw: string): string {
  if (!raw.startsWith("https://") || !URL.canParse(raw))
    throw new Error(`the public URL must be an https:// URL, got ${raw}`);
  return raw;
}

/**
 * `omp-remote init`: set this machine up as the host (server and agent, on the
 * local network) or as a public server only. Every flag is checked, and every
 * answer collected, before the first file is written; the config is written
 * last, so a failed init leaves no config behind.
 */
export async function init(args: string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      role: { type: "string" },
      "public-url": { type: "string" },
      port: { type: "string" },
      "password-stdin": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (
    values.role !== undefined &&
    values.role !== "host" &&
    values.role !== "server"
  )
    throw new Error(`--role must be host or server, got ${values.role}`);
  let publicUrl =
    values["public-url"] === undefined
      ? undefined
      : parsePublicUrl(values["public-url"]);
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!/^\d+$/.test(values.port ?? "0") || port < 1 || port > 65535)
    throw new Error(`--port must be from 1 to 65535, got ${values.port}`);
  const flagName =
    values.name === undefined ? undefined : parseMachineName(values.name);
  const fromStdin = values["password-stdin"];
  await refuseExistingConfig(values.force);

  // With --password-stdin, stdin carries the password: nothing else is asked.
  const fallbackName = defaultMachineName(deps.hostname());
  const machineId =
    flagName ??
    (fromStdin
      ? fallbackName
      : parseMachineName(await deps.ask("Machine name", fallbackName)));
  let role = values.role;
  if (role === undefined) {
    if (fromStdin)
      throw new Error("--role host|server is required with --password-stdin");
    const choice = await deps.choose("What will this machine do?", [
      "This machine hosts omp-remote (local network)",
      "Public server only",
    ]);
    role = choice === 0 ? "host" : "server";
    if (role === "server" && publicUrl === undefined) {
      const answer = await deps.ask(
        "Public https:// URL your reverse proxy serves (Enter for none)",
      );
      publicUrl = answer === "" ? undefined : parsePublicUrl(answer);
    }
  }
  const password = await readNewPassword(fromStdin, deps);

  const server = ServerSection.parse({
    // Behind a public HTTPS proxy only the proxy needs to reach the server.
    listen: {
      host:
        role === "server" && publicUrl !== undefined ? "127.0.0.1" : "0.0.0.0",
      port,
    },
    publicUrl,
  });
  const cfg = Config.parse({
    version: 1,
    machineId,
    server,
    agent:
      role === "host" ? { serverUrl: `http://127.0.0.1:${port}` } : undefined,
  });

  await loadOrCreateSecret(secretPaths.sessionSecret);
  // Existing push keys stay: every browser subscription is bound to them.
  if (!(await Bun.file(secretPaths.vapid).exists())) {
    const { publicKey, privateKey } = await generateVapidKeys(
      server.pushSubject,
    );
    await writeFileAtomic(
      secretPaths.vapid,
      `${JSON.stringify({ publicKey, privateKey }, null, 2)}\n`,
    );
  }
  await setPassword(secretPaths.password, password, deps.now());
  if (cfg.agent !== undefined) {
    const machines = await MachineStore.load(secretPaths.machines);
    await writeFileAtomic(
      secretPaths.agentToken,
      await machines.issue(machineId, deps.now()),
    );
  }
  await saveConfig(cfg);

  deps.print(`Wrote ${configPath()}.`);
  if (cfg.agent !== undefined) {
    deps.print(
      "Next: `omp-remote run` starts the server and agent here and shows a QR code to pair your phone.",
    );
    deps.print("Then `omp-remote install` starts omp-remote at every login.");
    return 0;
  }
  deps.print(
    "Next: `omp-remote run` starts the server; `omp-remote install` starts it at every login.",
  );
  if (publicUrl !== undefined)
    deps.print(
      `Point your HTTPS reverse proxy for ${publicUrl} at http://127.0.0.1:${port}.`,
    );
  const [joinUrl] = phoneUrls(
    server,
    port,
    deps.networkInterfaces(),
    await deps.defaultRouteAddress(),
  );
  deps.print(
    `On each machine to control: omp-remote join ${joinUrl?.url ?? "<server URL>"}`,
  );
  return 0;
}
