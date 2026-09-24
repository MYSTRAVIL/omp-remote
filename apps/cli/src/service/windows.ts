import { win32 } from "node:path";

export interface ServiceFile {
  path: string;
  content: string;
}

export interface WindowsServiceOptions {
  /** Absolute path of bun.exe. The supervisor runs it directly, so not a `.cmd` shim. */
  bunPath: string;
  /** Absolute path of `apps/cli/src/main.ts` in the checkout the service runs from. */
  cliEntry: string;
  /** The state dir `run` reads. The supervisor lives in it and runs with it as the cwd. */
  stateDir: string;
  /** Where the supervisor appends `run`'s output. */
  logPath: string;
  /** `%USERPROFILE%`: `<home>\.omp-remote` is the default state dir. */
  home: string;
  /** `%APPDATA%`: the launcher goes to its Startup folder. */
  appData: string;
}

export interface WindowsServicePaths {
  /** The restart loop, `<stateDir>\omp-remote-supervisor.cmd`. */
  supervisor: string;
  /** The Startup-folder `.vbs` that starts the supervisor hidden at logon. */
  startup: string;
}

/** `%APPDATA%`'s Startup folder: Windows runs what it holds at logon. */
function startupFolder(appData: string): string {
  return win32.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
}

export function windowsServicePaths(opts: {
  stateDir: string;
  appData: string;
}): WindowsServicePaths {
  return {
    supervisor: win32.join(opts.stateDir, "omp-remote-supervisor.cmd"),
    startup: win32.join(startupFolder(opts.appData), "omp-remote.vbs"),
  };
}

/**
 * The launcher chain the retired `install-agent.ps1` set up: the Startup
 * `omp-remote-agent.vbs` starts `supervise-agent.cmd`, which calls
 * `run-agent.cmd` with the paths in `agent-env.cmd`, all three in
 * `%LOCALAPPDATA%\omp-remote`. The agent entry point it runs is gone, so the
 * chain would restart a no-op agent every few seconds, forever.
 */
export interface LegacyWindowsLaunchers {
  /** The batch files a legacy cmd.exe runs, supervisor first. */
  scripts: string[];
  /** Every legacy launcher file to delete; `agent.log` beside them stays. */
  files: string[];
}

export function legacyWindowsLaunchers(opts: {
  appData: string;
  localAppData: string;
}): LegacyWindowsLaunchers {
  const dir = win32.join(opts.localAppData, "omp-remote");
  const scripts = [
    win32.join(dir, "supervise-agent.cmd"),
    win32.join(dir, "run-agent.cmd"),
  ];
  return {
    scripts,
    files: [
      win32.join(startupFolder(opts.appData), "omp-remote-agent.vbs"),
      ...scripts,
      win32.join(dir, "agent-env.cmd"),
    ],
  };
}

/** One row of the `Win32_Process` listing. */
export interface WindowsProcess {
  ProcessId: number;
  ParentProcessId: number;
  CommandLine: string | null;
}

/**
 * The processes that make up a supervisor chain, to stop one by one:
 * every process whose command line names one of `scripts` (the cmd.exe
 * running it), then their direct children, plus a `run` of `cliEntry` whose
 * parent is gone. Supervisors come first so none respawns a child meanwhile.
 * Never grandchildren: omp sessions an agent started must survive.
 */
export function supervisorChain(
  processes: readonly WindowsProcess[],
  scripts: readonly string[],
  cliEntry: string,
): number[] {
  const live = new Set(processes.map((p) => p.ProcessId));
  const names = scripts.map((script) => script.toLowerCase());
  const runLine = `"${cliEntry}" run`.toLowerCase();
  const supervisors = new Set<number>();
  for (const p of processes) {
    const line = p.CommandLine?.toLowerCase();
    if (line !== undefined && names.some((name) => line.includes(name)))
      supervisors.add(p.ProcessId);
  }
  const children = processes
    .filter(
      (p) =>
        !supervisors.has(p.ProcessId) &&
        (supervisors.has(p.ParentProcessId) ||
          (!live.has(p.ParentProcessId) &&
            p.CommandLine?.toLowerCase().includes(runLine) === true)),
    )
    .map((p) => p.ProcessId);
  return [...supervisors, ...children];
}

/**
 * Paths are pasted into a batch file with delayed expansion on, which cannot
 * carry `%` or `!`; a quote or a control character would break the quoting.
 */
function launcherPath(value: string): string {
  if (/[%!"]/.test(value) || [...value].some((c) => c < " "))
    throw new Error(
      `cmd.exe cannot carry '%' or '!' in a launcher path: ${value}`,
    );
  if (!win32.isAbsolute(value))
    throw new Error(`launcher paths must be absolute: ${value}`);
  return value;
}

/**
 * The supervisor `.cmd` and the Startup `.vbs` that keep `omp-remote run`
 * alive without admin rights: the `.vbs` starts the supervisor hidden at
 * logon, the supervisor restarts `run` after every exit. The backoff is the
 * one the host-agent launchers used: 2 s after a clean exit, doubling to a
 * 60 s cap after a crash. `wt.exe` session spawning stays in the agent.
 */
export function renderWindowsService(opts: WindowsServiceOptions): {
  files: ServiceFile[];
} {
  const bun = launcherPath(opts.bunPath);
  if (!/\.exe$/i.test(bun))
    throw new Error(`bunPath must be bun.exe, not a shim: ${bun}`);
  const entry = launcherPath(opts.cliEntry);
  const stateDir = launcherPath(opts.stateDir);
  const log = launcherPath(opts.logPath);
  const logName = win32.basename(log);
  const paths = windowsServicePaths({
    stateDir,
    appData: launcherPath(opts.appData),
  });
  const defaultStateDir = win32.join(opts.home, ".omp-remote");
  const stateDirEnv =
    win32.resolve(stateDir).toLowerCase() ===
    win32.resolve(defaultStateDir).toLowerCase()
      ? []
      : [`set "OMP_REMOTE_STATE_DIR=${stateDir}"`];

  const supervisor = [
    "@echo off",
    // cmd.exe decodes a batch file in the console code page, line by line:
    // switch to UTF-8 before the first line that holds a path.
    "chcp 65001 >nul",
    "setlocal EnableDelayedExpansion",
    "REM omp-remote supervisor, written by `omp-remote install`: rerun that instead of editing.",
    "REM Started hidden at logon by omp-remote.vbs in the Startup folder. Restarts",
    "REM `omp-remote run` after every exit: 2s after a clean exit, doubling to 60s",
    "REM after a crash. OMP_REMOTE_SUPERVISE_MAX bounds the loop for smoke tests.",
    `set "LOG_FILE=${log}"`,
    ...stateDirEnv,
    `cd /d "${stateDir}"`,
    "set /a DELAY=2",
    "set /a COUNT=0",
    "",
    ":loop",
    "set /a COUNT+=1",
    "call :rotate",
    'echo [%DATE% %TIME%] omp-remote supervisor: starting omp-remote run (run #!COUNT!) >> "%LOG_FILE%"',
    `"${bun}" --no-env-file "${entry}" run >> "%LOG_FILE%" 2>&1`,
    'set "EXIT_CODE=!ERRORLEVEL!"',
    'echo [%DATE% %TIME%] omp-remote supervisor: omp-remote run exited code !EXIT_CODE! (run #!COUNT!); restarting in !DELAY!s >> "%LOG_FILE%"',
    "if defined OMP_REMOTE_SUPERVISE_MAX if !COUNT! GEQ %OMP_REMOTE_SUPERVISE_MAX% goto done",
    // ping, not timeout.exe: timeout fails without console input.
    "ping -n !DELAY! 127.0.0.1 >nul 2>&1",
    'if "!EXIT_CODE!"=="0" (',
    "  set /a DELAY=2",
    ") else (",
    "  set /a DELAY=DELAY*2",
    "  if !DELAY! GTR 60 set /a DELAY=60",
    ")",
    "goto loop",
    "",
    ":done",
    "endlocal",
    "exit /b 0",
    "",
    ":rotate",
    "REM At launch only: a log at or above 10 MiB moves to .1, and .1 to .2.",
    'if not exist "%LOG_FILE%" exit /b 0',
    'for %%F in ("%LOG_FILE%") do if %%~zF LSS 10485760 exit /b 0',
    'del /f /q "%LOG_FILE%.2" >nul 2>&1',
    `if exist "%LOG_FILE%.1" ren "%LOG_FILE%.1" "${logName}.2" >nul 2>&1`,
    `ren "%LOG_FILE%" "${logName}.1" >nul 2>&1 || echo [%DATE% %TIME%] omp-remote diagnostic event=log_rotation_failed code=io-failed >> "%LOG_FILE%"`,
    "exit /b 0",
    "",
  ];

  // `cmd /s /c ""<path>""` keeps the inner quotes whatever the path holds
  // (spaces, parentheses, `&`); `/d` skips the user's AutoRun commands.
  const run = `cmd /d /s /c ""${paths.supervisor}""`;
  const startup = [
    "' omp-remote: start the supervisor hidden at logon (no admin; survives reboot).",
    "' Written by `omp-remote install`: rerun that instead of editing.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${run.replaceAll('"', '""')}", 0, False`,
    "",
  ];

  return {
    files: [
      { path: paths.supervisor, content: supervisor.join("\r\n") },
      { path: paths.startup, content: startup.join("\r\n") },
    ],
  };
}

/**
 * The bytes to write for a rendered file. The `.vbs` is UTF-16LE with a BOM so
 * Windows Script Host reads any path; the `.cmd` is UTF-8 (it switches cmd.exe
 * to code page 65001 before any path).
 */
export function windowsFileBytes(file: ServiceFile): Uint8Array {
  if (!file.path.toLowerCase().endsWith(".vbs"))
    return Buffer.from(file.content, "utf8");
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(file.content, "utf16le"),
  ]);
}
