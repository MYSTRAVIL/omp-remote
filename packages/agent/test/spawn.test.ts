import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import {
  type SpawnHandle,
  type SpawnOptions,
  type TerminalCommand,
  assertSpawnCwd,
  launchDetached,
  spawnArgs,
  spawnSession,
  terminalCommand,
} from "../src/spawn";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A launcher double that records what it was asked to start. */
function recordingLauncher() {
  const launched: {
    command: TerminalCommand;
    cwd: string;
    spawnId?: string;
  }[] = [];
  const launch = async (
    command: TerminalCommand,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<SpawnHandle> => {
    launched.push({ command, cwd, spawnId: env.OMP_REMOTE_SPAWN_ID });
    return { pid: 1, kill: () => {} };
  };
  return { launched, launch };
}

test("spawnArgs passes --model and --approval-mode", () => {
  expect(spawnArgs({ model: "opus", approvalMode: "yolo" })).toEqual([
    "--model",
    "opus",
    "--approval-mode",
    "yolo",
  ]);
});

test("spawnArgs includes --thinking when thinkingLevel is set", () => {
  expect(
    spawnArgs({ model: "opus", thinkingLevel: "high", approvalMode: "write" }),
  ).toEqual([
    "--model",
    "opus",
    "--thinking",
    "high",
    "--approval-mode",
    "write",
  ]);
});

test("spawnArgs omits flags that are not set", () => {
  expect(spawnArgs({})).toEqual([]);
  expect(spawnArgs({ approvalMode: "write" })).toEqual([
    "--approval-mode",
    "write",
  ]);
});

test("spawnArgs refuses a model that could break out of the launch command", () => {
  for (const model of [
    "x&calc",
    "a|b",
    "50%PATH%",
    'a"b',
    "two words",
    "--help",
    "a\nb",
    "a".repeat(129),
  ])
    expect(() => spawnArgs({ model })).toThrow();
});

test("spawnArgs passes realistic omp model ids through verbatim", () => {
  for (const model of [
    "opus",
    "anthropic/claude-opus-4-5",
    "litellm-local/qwen38-27b-w8a16:low",
    "openrouter/meta-llama/llama-3.1-70b-instruct:free",
    "claude-opus-4-1@20250805",
    "hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_XL",
    "@worker",
    "a".repeat(128),
  ])
    expect(spawnArgs({ model })).toEqual(["--model", model]);
});

test("a win32 cwd must be a drive-letter path, without quotes or control characters", () => {
  for (const cwd of [
    "proj",
    ".\\proj",
    "C:proj",
    "\\Users\\me\\proj",
    // UNC/device paths: stat() on them would dial an SMB server.
    "\\\\server\\share\\app",
    "\\\\?\\C:\\Users\\me\\proj",
    "\\\\.\\pipe\\x",
    'C:\\Users\\me\\a"b',
    "C:\\Users\\me\\a\nb",
  ])
    expect(() => assertSpawnCwd("win32", cwd)).toThrow();
  // cmd.exe metacharacters are fine: the cwd never reaches a command line.
  for (const cwd of [
    "C:\\Users\\me\\My Projects\\app",
    "C:/Users/me/app",
    "D:\\work",
    "C:\\Users\\me\\R&D 100% (old) ^!",
  ])
    expect(() => assertSpawnCwd("win32", cwd)).not.toThrow();
});

test("a posix cwd must be absolute and free of control characters", () => {
  // Ctrl-U would erase the typed `cd` line in Terminal.app's `do script`.
  for (const cwd of ["proj", "./proj", "/Users/me/a\nb", "/Users/me/a\u0015b"])
    expect(() => assertSpawnCwd("darwin", cwd)).toThrow();
  expect(() =>
    assertSpawnCwd("darwin", `/Users/me/My Projects/it's "here" & 100%`),
  ).not.toThrow();
});

const WT = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";

test("win32 opens omp in a new Windows Terminal window with the cwd off the command line", () => {
  expect(
    terminalCommand(
      "win32",
      "C:\\Tools\\omp\\omp.exe",
      ["--model", "anthropic/claude-opus-4-5"],
      "C:\\Users\\me\\R&D 100%;x",
      WT,
    ),
  ).toEqual({
    command: WT,
    args: [
      "-w",
      "new",
      "new-tab",
      "-d",
      ".",
      "--",
      "C:\\Tools\\omp\\omp.exe",
      "--model",
      "anthropic/claude-opus-4-5",
    ],
  });
});

test("win32 falls back to conhost when Windows Terminal is not installed", () => {
  const { command, args } = terminalCommand(
    "win32",
    "C:\\Tools\\omp\\omp.exe",
    ["--model", "anthropic/claude-opus-4-5"],
    "C:\\Users\\me\\R&D 100%",
  );
  expect(win32.isAbsolute(command)).toBe(true);
  expect(win32.basename(command).toLowerCase()).toBe("conhost.exe");
  expect(args).toEqual([
    "--",
    "C:\\Tools\\omp\\omp.exe",
    "--model",
    "anthropic/claude-opus-4-5",
  ]);
});

test("win32 refuses a command the terminal or a cmd shim would rewrite", () => {
  const cwd = "C:\\proj";
  for (const terminal of [WT, null]) {
    // Windows Terminal and conhost expand %VAR% in the command line.
    expect(() =>
      terminalCommand(
        "win32",
        "C:\\omp\\omp.exe",
        ["--model", "50%PATH%"],
        cwd,
        terminal,
      ),
    ).toThrow();
    // Windows Terminal splits its command line into subcommands at `;`.
    expect(() =>
      terminalCommand(
        "win32",
        "C:\\omp\\omp.exe",
        ["--model", "x;new-tab"],
        cwd,
        terminal,
      ),
    ).toThrow();
    expect(() =>
      terminalCommand("win32", "C:\\o;mp\\omp.exe", ["-p"], cwd, terminal),
    ).toThrow();
    // A .cmd shim runs through cmd.exe.
    expect(() =>
      terminalCommand(
        "win32",
        "C:\\npm\\omp.cmd",
        ["--model", "a&b"],
        cwd,
        terminal,
      ),
    ).toThrow();
    // A bare name would be searched in the project cwd before PATH.
    expect(() =>
      terminalCommand("win32", "omp", ["--model", "opus"], cwd, terminal),
    ).toThrow();
  }
  // A bare terminal name would be searched in the project cwd too.
  expect(() =>
    terminalCommand("win32", "C:\\omp\\omp.exe", [], cwd, "wt.exe"),
  ).toThrow();
});

test("darwin drives Terminal.app to cd into cwd and exec omp", () => {
  const { command, args } = terminalCommand(
    "darwin",
    "omp",
    ["--approval-mode", "write"],
    "/Users/me/proj",
  );
  expect(command).toBe("osascript");
  expect(args[0]).toBe("-e");
  expect(args[1]).toContain('tell application "Terminal" to do script');
  expect(args[1]).toContain("cd '/Users/me/proj'");
  expect(args[1]).toContain("exec 'omp' '--approval-mode' 'write'");
});

test("linux launches the alternatives terminal with omp", () => {
  expect(terminalCommand("linux", "omp", ["--model", "opus"], "/x")).toEqual({
    command: "x-terminal-emulator",
    args: ["-e", "omp", "--model", "opus"],
  });
});

test("spawnSession refuses a cwd that is not an existing directory, launching nothing", async () => {
  const { launched, launch } = recordingLauncher();
  const root = mkdtempSync(join(tmpdir(), "omp-remote-spawn-"));
  roots.push(root);
  const file = join(root, "f.txt");
  writeFileSync(file, "");
  await expect(
    spawnSession({ cwd: join(root, "does-not-exist"), launch }),
  ).rejects.toThrow();
  await expect(spawnSession({ cwd: file, launch })).rejects.toThrow();
  expect(launched).toEqual([]);
});

test("spawnSession refuses an injecting model before launching anything", async () => {
  const { launched, launch } = recordingLauncher();
  const request: SpawnOptions = {
    cwd: tmpdir(),
    approvalMode: "write",
    ompBin: process.execPath,
    launch,
  };
  await expect(spawnSession({ ...request, model: "x&calc" })).rejects.toThrow();
  expect(launched).toEqual([]);
  // The same request with a real model id does launch.
  await spawnSession({ ...request, model: "anthropic/claude-opus-4-5" });
  expect(launched).toHaveLength(1);
});

test.skipIf(process.platform !== "win32")(
  "spawnSession fails before launching when omp is not on PATH",
  async () => {
    const { launched, launch } = recordingLauncher();
    await expect(
      spawnSession({
        cwd: tmpdir(),
        ompBin: "omp-remote-no-such-omp-xyz",
        launch,
      }),
    ).rejects.toThrow();
    expect(launched).toEqual([]);
  },
);

test.skipIf(process.platform !== "win32")(
  "spawnSession launches omp in Windows Terminal in a cwd cmd.exe would have parsed",
  async () => {
    const { launched, launch } = recordingLauncher();
    const cwd = mkdtempSync(join(tmpdir(), "omp remote R&D 100% (x) ^!;"));
    roots.push(cwd);
    await spawnSession({
      cwd,
      model: "anthropic/claude-opus-4-5",
      thinkingLevel: "high",
      approvalMode: "write",
      spawnId: "nonce-1",
      ompBin: process.execPath,
      windowsTerminal: WT,
      launch,
    });
    expect(launched).toEqual([
      {
        command: {
          command: WT,
          args: [
            "-w",
            "new",
            "new-tab",
            "-d",
            ".",
            "--",
            process.execPath,
            "--model",
            "anthropic/claude-opus-4-5",
            "--thinking",
            "high",
            "--approval-mode",
            "write",
          ],
        },
        cwd,
        spawnId: "nonce-1",
      },
    ]);
  },
);

test("a launcher that cannot start rejects instead of crashing the agent", async () => {
  // Without an `error` listener this ENOENT is an unhandled event that kills
  // the process (and fails this test run).
  await expect(
    launchDetached(
      { command: "omp-remote-no-such-terminal-xyz", args: [] },
      tmpdir(),
      process.env,
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
