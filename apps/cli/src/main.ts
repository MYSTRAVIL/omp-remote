#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { doctor } from "./commands/doctor";
import { init } from "./commands/init";
import { install, uninstall } from "./commands/install";
import { join } from "./commands/join";
import { pair } from "./commands/pair";
import { passwd } from "./commands/passwd";
import { run } from "./commands/run";
import { type CliDeps, processDeps } from "./deps";
import { autoloadedEnvFiles } from "./dotenv-guard";

/** A command: its arguments after the command name in, an exit code out. */
type Command = (args: string[], deps: CliDeps) => Promise<number>;

const HELP = `omp-remote: control your omp sessions from your phone

Usage: omp-remote <command> [options]

Commands:
  init        Set this machine up as the host (server + agent) or a public server
                --name <name>        machine name (default: this computer's hostname)
                --role host|server   host: serve the local network and run the agent here
                                     server: public server only
                --public-url <url>   the https:// origin a reverse proxy serves (optional)
                --port <port>        server port (default 8788)
                --password-stdin     read the password from stdin instead of asking
                --force              replace an existing config
  run         Run the server and/or agent in the foreground; pairs a phone when none is
  join <url>  Add this machine to the server at <url> and pair a phone
                --name <name>, --force
  pair        Pair a phone with this machine (it replaces the phone the agent serves)
  passwd      Set or change the sign-in password (server machines)
                --password-stdin
                --enable-password-sign-in
                                     also turn password sign-in back on (server stopped)
  doctor      Check the setup and say how to fix what is broken
  install     Start omp-remote at login (and now), and install the omp bridge
  uninstall   Stop starting omp-remote at login

State lives in ~/.omp-remote; OMP_REMOTE_STATE_DIR moves it.`;

/** Parse `args` as "no arguments at all": a stray one is an error. */
function noArgs(args: string[]): void {
  parseArgs({ args, options: {}, strict: true, allowPositionals: false });
}

const COMMANDS: Record<string, Command> = {
  init,
  run,
  join,
  pair,
  passwd,
  doctor: async (args) => {
    noArgs(args);
    return doctor();
  },
  install: async (args) => {
    noArgs(args);
    await install({
      check: async () => (await doctor({ print: () => {} })) === 0,
    });
    return 0;
  },
  uninstall: async (args) => {
    noArgs(args);
    await uninstall();
    return 0;
  },
};

/**
 * Run the command `argv` names and return the exit code. A failure prints one
 * line on stderr, never a stack, and exits 1.
 */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const [name, ...args] = argv;
  if (
    name === undefined ||
    name === "help" ||
    name === "--help" ||
    name === "-h" ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    deps.print(HELP);
    return name === undefined ? 1 : 0;
  }
  // Own keys only: a typed name like `constructor` must find no command.
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) {
    deps.printError(
      `omp-remote: unknown command ${name}; see omp-remote --help`,
    );
    return 1;
  }
  try {
    return await command(args, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.printError(`omp-remote ${name}: ${message.replace(/\s*\n\s*/g, " ")}`);
    return 1;
  }
}

if (import.meta.main) {
  // Bun loads these before any code runs, and omp-remote cannot tell their
  // values from the shell's: refuse rather than act on an untrusted folder's.
  const envFiles = autoloadedEnvFiles(process.cwd(), process.execArgv);
  if (envFiles.length > 0) {
    processDeps.printError(
      `omp-remote: Bun loaded ${envFiles.join(", ")} into the environment, and omp-remote takes no settings from .env files. Run it from another folder, or as bun --no-env-file ${import.meta.path} …`,
    );
    process.exit(1);
  }
  process.exit(await main(process.argv.slice(2), processDeps));
}
