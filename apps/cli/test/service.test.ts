import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitHealthy } from "../src/commands/install";
import { renderLinuxUnit } from "../src/service/linux";
import {
  legacyWindowsLaunchers,
  renderWindowsService,
  supervisorChain,
  windowsFileBytes,
  windowsServicePaths,
} from "../src/service/windows";

const home = "C:\\Users\\Ada Lovelace";
const windows = {
  bunPath: "C:\\Program Files (x86)\\Bun\\bun.exe",
  cliEntry: "C:\\src\\omp remote\\apps\\cli\\src\\main.ts",
  stateDir: `${home}\\.omp-remote`,
  logPath: `${home}\\.omp-remote\\omp-remote.log`,
  home,
  appData: `${home}\\AppData\\Roaming`,
};

test("Windows: supervisor .cmd with the restart backoff, and a hidden Startup .vbs", () => {
  expect(renderWindowsService(windows).files).toEqual([
    {
      path: `${home}\\.omp-remote\\omp-remote-supervisor.cmd`,
      content: [
        "@echo off",
        "chcp 65001 >nul",
        "setlocal EnableDelayedExpansion",
        "REM omp-remote supervisor, written by `omp-remote install`: rerun that instead of editing.",
        "REM Started hidden at logon by omp-remote.vbs in the Startup folder. Restarts",
        "REM `omp-remote run` after every exit: 2s after a clean exit, doubling to 60s",
        "REM after a crash. OMP_REMOTE_SUPERVISE_MAX bounds the loop for smoke tests.",
        `set "LOG_FILE=${home}\\.omp-remote\\omp-remote.log"`,
        `cd /d "${home}\\.omp-remote"`,
        "set /a DELAY=2",
        "set /a COUNT=0",
        "",
        ":loop",
        "set /a COUNT+=1",
        "call :rotate",
        'echo [%DATE% %TIME%] omp-remote supervisor: starting omp-remote run (run #!COUNT!) >> "%LOG_FILE%"',
        '"C:\\Program Files (x86)\\Bun\\bun.exe" --no-env-file "C:\\src\\omp remote\\apps\\cli\\src\\main.ts" run >> "%LOG_FILE%" 2>&1',
        'set "EXIT_CODE=!ERRORLEVEL!"',
        'echo [%DATE% %TIME%] omp-remote supervisor: omp-remote run exited code !EXIT_CODE! (run #!COUNT!); restarting in !DELAY!s >> "%LOG_FILE%"',
        "if defined OMP_REMOTE_SUPERVISE_MAX if !COUNT! GEQ %OMP_REMOTE_SUPERVISE_MAX% goto done",
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
        'if exist "%LOG_FILE%.1" ren "%LOG_FILE%.1" "omp-remote.log.2" >nul 2>&1',
        'ren "%LOG_FILE%" "omp-remote.log.1" >nul 2>&1 || echo [%DATE% %TIME%] omp-remote diagnostic event=log_rotation_failed code=io-failed >> "%LOG_FILE%"',
        "exit /b 0",
        "",
      ].join("\r\n"),
    },
    {
      path: `${home}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\omp-remote.vbs`,
      content: [
        "' omp-remote: start the supervisor hidden at logon (no admin; survives reboot).",
        "' Written by `omp-remote install`: rerun that instead of editing.",
        'Set shell = CreateObject("WScript.Shell")',
        `shell.Run "cmd /d /s /c """"${home}\\.omp-remote\\omp-remote-supervisor.cmd""""", 0, False`,
        "",
      ].join("\r\n"),
    },
  ]);
});

test("Windows: a non-default state dir is passed on; cmd-hostile paths are refused", () => {
  const custom = renderWindowsService({
    ...windows,
    stateDir: "D:\\omp state",
  }).files[0]?.content;
  expect(custom).toContain(
    '\r\nset "OMP_REMOTE_STATE_DIR=D:\\omp state"\r\ncd /d "D:\\omp state"\r\n',
  );
  expect(
    renderWindowsService({ ...windows, stateDir: `${home}\\.OMP-REMOTE\\` })
      .files[0]?.content,
  ).not.toContain("OMP_REMOTE_STATE_DIR=");
  expect(() =>
    renderWindowsService({ ...windows, cliEntry: "C:\\100%\\main.ts" }),
  ).toThrow("cmd.exe cannot carry '%' or '!'");
  expect(() =>
    renderWindowsService({ ...windows, stateDir: "C:\\wow!\\state" }),
  ).toThrow("cmd.exe cannot carry '%' or '!'");
  expect(() =>
    renderWindowsService({ ...windows, bunPath: "C:\\dev\\bun.cmd" }),
  ).toThrow("bunPath must be bun.exe");
});

test("Windows: the .vbs is written as UTF-16LE with a BOM, the .cmd as UTF-8", () => {
  const [cmd, vbs] = renderWindowsService({
    ...windows,
    stateDir: "C:\\Users\\José\\.omp-remote",
  }).files;
  if (!cmd || !vbs) throw new Error("expected two files");
  expect(Buffer.from(windowsFileBytes(cmd)).toString("utf8")).toBe(cmd.content);
  const bytes = Buffer.from(windowsFileBytes(vbs));
  expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
  expect(bytes.subarray(2).toString("utf16le")).toBe(vbs.content);
});

const legacy = legacyWindowsLaunchers({
  appData: `${home}\\AppData\\Roaming`,
  localAppData: `${home}\\AppData\\Local`,
});

test("Windows: the legacy install-agent.ps1 launchers, where it put them", () => {
  const local = `${home}\\AppData\\Local\\omp-remote`;
  expect(legacy).toEqual({
    scripts: [`${local}\\supervise-agent.cmd`, `${local}\\run-agent.cmd`],
    files: [
      `${home}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\omp-remote-agent.vbs`,
      `${local}\\supervise-agent.cmd`,
      `${local}\\run-agent.cmd`,
      `${local}\\agent-env.cmd`,
    ],
  });
});

test("Windows: both supervisor chains stop, supervisors first; agents' children and unrelated processes stay", () => {
  const ours = windowsServicePaths(windows).supervisor;
  const bun = `"${windows.bunPath}"`;
  const run = `${bun} --no-env-file "${windows.cliEntry}" run`;
  const processes = [
    { ProcessId: 1, ParentProcessId: 0, CommandLine: "explorer.exe" },
    {
      ProcessId: 10,
      ParentProcessId: 1,
      CommandLine: `cmd /d /s /c ""${ours}""`,
    },
    { ProcessId: 11, ParentProcessId: 10, CommandLine: run },
    { ProcessId: 12, ParentProcessId: 11, CommandLine: "omp.exe" },
    // The legacy .vbs expands %LOCALAPPDATA% in its own case.
    {
      ProcessId: 20,
      ParentProcessId: 1,
      CommandLine: `cmd /c "${legacy.scripts[0]?.toUpperCase()}"`,
    },
    {
      ProcessId: 21,
      ParentProcessId: 20,
      CommandLine: `${bun} run src\\main.ts`,
    },
    { ProcessId: 22, ParentProcessId: 20, CommandLine: "ping -n 2 127.0.0.1" },
    { ProcessId: 23, ParentProcessId: 21, CommandLine: "omp.exe" },
    {
      ProcessId: 30,
      ParentProcessId: 1,
      CommandLine: `cmd /c "${legacy.scripts[1]}"`,
    },
    // A `run` whose supervisor is gone, and one started from a terminal.
    { ProcessId: 40, ParentProcessId: 99, CommandLine: run },
    { ProcessId: 41, ParentProcessId: 1, CommandLine: run },
    // Same file name, someone else's directory.
    {
      ProcessId: 50,
      ParentProcessId: 1,
      CommandLine: 'cmd /c "D:\\other\\supervise-agent.cmd"',
    },
    { ProcessId: 60, ParentProcessId: 99, CommandLine: null },
  ];
  expect(
    supervisorChain(processes, [ours, ...legacy.scripts], windows.cliEntry),
  ).toEqual([10, 20, 30, 11, 21, 22, 40]);
});

const linux = {
  bunPath: "/home/ada/.bun/bin/bun",
  cliEntry: "/home/ada/omp-remote/apps/cli/src/main.ts",
  stateDir: "/home/ada/.omp-remote",
  home: "/home/ada",
};

test("Linux: a systemd user unit with the default state dir", () => {
  expect(renderLinuxUnit(linux)).toEqual({
    path: "/home/ada/.config/systemd/user/omp-remote.service",
    content: [
      "[Unit]",
      "Description=omp-remote",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "WorkingDirectory=/home/ada/.omp-remote",
      'ExecStart="/home/ada/.bun/bin/bun" --no-env-file "/home/ada/omp-remote/apps/cli/src/main.ts" run',
      "Restart=on-failure",
      "RestartSec=3",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  });
});

test("Linux: a custom state dir sets OMP_REMOTE_STATE_DIR; % and $ are escaped", () => {
  const { content } = renderLinuxUnit({
    ...linux,
    cliEntry: "/opt/omp $remote/apps/cli/src/main.ts",
    stateDir: "/srv/omp remote/100%",
  });
  expect(content).toContain(
    [
      "WorkingDirectory=/srv/omp remote/100%%",
      'Environment="OMP_REMOTE_STATE_DIR=/srv/omp remote/100%%"',
      'ExecStart="/home/ada/.bun/bin/bun" --no-env-file "/opt/omp $$remote/apps/cli/src/main.ts" run',
    ].join("\n"),
  );
});

test("waitHealthy stops at the first passing check and gives up after `attempts`", async () => {
  let calls = 0;
  let pauses = 0;
  const pause = async (): Promise<void> => {
    pauses++;
  };
  const passesOnThird = async (): Promise<boolean> => ++calls === 3;
  expect(await waitHealthy(passesOnThird, 5, pause)).toBe(true);
  expect([calls, pauses]).toEqual([3, 2]);

  calls = 0;
  pauses = 0;
  expect(await waitHealthy(async () => ++calls < 0, 4, pause)).toBe(false);
  expect([calls, pauses]).toEqual([4, 3]);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform !== "win32")(
  "Windows: the rendered supervisor rotates the log, runs `run`, logs its exit and honors OMP_REMOTE_SUPERVISE_MAX",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-remote-svc-"));
    roots.push(root);
    // Spaces and parentheses exercise the quoting.
    const stateDir = join(root, "state (test)");
    const repo = join(root, "omp remote");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const cliEntry = join(repo, "main.ts");
    writeFileSync(
      cliEntry,
      "console.log(`entry argv=${process.argv.slice(2).join(' ')} cwd=${process.cwd()}`);\nprocess.exit(7);\n",
    );
    const logPath = join(stateDir, "omp-remote.log");
    writeFileSync(logPath, "old");
    truncateSync(logPath, 10 * 1024 * 1024);
    const [supervisor] = renderWindowsService({
      bunPath: process.execPath,
      cliEntry,
      stateDir,
      logPath,
      home: root,
      appData: root,
    }).files;
    if (!supervisor) throw new Error("expected the supervisor");
    writeFileSync(supervisor.path, windowsFileBytes(supervisor));

    const proc = Bun.spawn(["cmd.exe", "/d", "/c", supervisor.path], {
      env: { ...process.env, OMP_REMOTE_SUPERVISE_MAX: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);

    expect(statSync(`${logPath}.1`).size).toBe(10 * 1024 * 1024);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("starting omp-remote run (run #1)");
    expect(log).toContain(`entry argv=run cwd=${stateDir}`);
    expect(log).toContain(
      "omp-remote run exited code 7 (run #1); restarting in 2s",
    );
    expect(log).not.toContain("run #2");
    expect(existsSync(`${logPath}.2`)).toBe(false);
  },
);
