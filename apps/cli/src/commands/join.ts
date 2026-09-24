import { parseArgs } from "node:util";
import { Config, configPath, saveConfig } from "@omp-remote/config";
import type { CliDeps } from "../deps";
import { httpBaseUrl } from "../urls";
import {
  defaultMachineName,
  parseMachineName,
  refuseExistingConfig,
} from "./init";
import { pairPhone } from "./pair";

/**
 * `omp-remote join <url>`: make this machine an agent of the server at `url`
 * and pair a phone with it. The config is written once the pairing succeeds,
 * so a failed join leaves none behind and can simply run again.
 */
export async function join(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      force: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  const [serverUrl, ...extra] = positionals;
  if (serverUrl === undefined || extra.length > 0)
    throw new Error(
      "usage: omp-remote join <server-url> [--name <name>] [--force]",
    );
  const baseUrl = httpBaseUrl(serverUrl);
  const flagName =
    values.name === undefined ? undefined : parseMachineName(values.name);
  await refuseExistingConfig(values.force);
  const machineId =
    flagName ??
    parseMachineName(
      await deps.ask("Machine name", defaultMachineName(deps.hostname())),
    );

  const paired = await pairPhone(
    { machineId, serverUrl, phoneUrl: baseUrl, renew: false },
    deps,
  );
  await saveConfig(
    Config.parse({
      version: 1,
      machineId,
      agent: { serverUrl, phoneId: paired.phonePub },
    }),
  );
  deps.print(`Joined ${baseUrl} as ${machineId}; wrote ${configPath()}.`);
  deps.print(
    "Next: `omp-remote install` starts the agent now and at every login (`omp-remote run` tries it in the foreground).",
  );
  return 0;
}
