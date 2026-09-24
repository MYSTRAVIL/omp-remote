import { posix } from "node:path";

export const LINUX_UNIT_NAME = "omp-remote.service";

export interface LinuxServiceOptions {
  /** Absolute path of the bun binary. */
  bunPath: string;
  /** Absolute path of `apps/cli/src/main.ts` in the checkout the service runs from. */
  cliEntry: string;
  /** The state dir `run` reads; also the service's working directory. */
  stateDir: string;
  /** `$HOME`: the unit goes to `~/.config/systemd/user`, and `~/.omp-remote` is the default state dir. */
  home: string;
}

function unitPath(value: string): string {
  if ([...value].some((c) => c < " " || c === "\u007f"))
    throw new Error(`a unit file cannot carry control characters: ${value}`);
  if (!posix.isAbsolute(value))
    throw new Error(`unit paths must be absolute: ${value}`);
  return value;
}

/**
 * One C-quoted word for ExecStart=/Environment=. `%` starts a specifier in
 * both; `$` expands a variable in ExecStart= only.
 */
function quoted(value: string, dollars: boolean): string {
  const escaped = value
    .replaceAll("\\", () => "\\\\")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  return `"${dollars ? escaped.replaceAll("$", () => "$$") : escaped}"`;
}

/**
 * A systemd user unit that runs `omp-remote run` and restarts it on failure.
 * Output goes to the journal (`journalctl --user -u omp-remote`).
 */
export function renderLinuxUnit(opts: LinuxServiceOptions): {
  path: string;
  content: string;
} {
  const bun = unitPath(opts.bunPath);
  const entry = unitPath(opts.cliEntry);
  const stateDir = unitPath(opts.stateDir);
  const home = unitPath(opts.home);
  const custom = posix.resolve(stateDir) !== posix.resolve(home, ".omp-remote");
  const lines = [
    "[Unit]",
    "Description=omp-remote",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${stateDir.replaceAll("%", () => "%%")}`,
    ...(custom
      ? [`Environment=${quoted(`OMP_REMOTE_STATE_DIR=${stateDir}`, false)}`]
      : []),
    `ExecStart=${quoted(bun, true)} --no-env-file ${quoted(entry, true)} run`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return {
    path: posix.join(home, ".config", "systemd", "user", LINUX_UNIT_NAME),
    content: lines.join("\n"),
  };
}
