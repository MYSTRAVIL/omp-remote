import { existsSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, secretPaths } from "@omp-remote/config";
import {
  devClientSecretPath,
  ipcTokenPath,
  restrictToOwner,
  stateDir,
  windowsAccount,
} from "@omp-remote/protocol/ipc";
import { z } from "zod";
import { defaultRouteAddress } from "../deps";
import { installBridge } from "../service/bridge";
import { LINUX_UNIT_NAME, renderLinuxUnit } from "../service/linux";
import {
  type LegacyWindowsLaunchers,
  type WindowsServicePaths,
  legacyWindowsLaunchers,
  renderWindowsService,
  supervisorChain,
  windowsFileBytes,
  windowsServicePaths,
} from "../service/windows";
import { reachableUrls } from "../urls";

const cliEntry = fileURLToPath(new URL("../main.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

export interface InstallOptions {
  /** Health probe polled once the service is started; `doctor` supplies it. Omitted: no wait. */
  check?: () => Promise<boolean>;
  /** Probes, one second apart. Default 90: longer than the supervisor's 60 s backoff cap. */
  attempts?: number;
}

/**
 * Call `check` up to `attempts` times, calling `pause` between tries; true as
 * soon as one passes. `check` resolves false while not yet healthy.
 */
export async function waitHealthy(
  check: () => Promise<boolean>,
  attempts: number,
  pause: () => Promise<void> = () => Bun.sleep(1000),
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await pause();
    if (await check()) return true;
  }
  return false;
}

async function run(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(
      `${argv.slice(0, 3).join(" ")} exited ${code}: ${stderr.trim()}`,
    );
  return stdout;
}

function unsupported(): Error {
  return new Error(
    `omp-remote install supports Windows and Linux, not ${process.platform}; start \`omp-remote run\` from your own service manager`,
  );
}

/** Absolute, so the service finds the same dir whatever its cwd. */
function resolvedStateDir(): string {
  return resolve(stateDir());
}

function windowsPaths(): WindowsServicePaths {
  return windowsServicePaths({
    stateDir: resolvedStateDir(),
    appData: process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  });
}

function legacyLaunchers(): LegacyWindowsLaunchers {
  return legacyWindowsLaunchers({
    appData: process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    localAppData:
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
  });
}

const WinProcesses = z.array(
  z.object({
    ProcessId: z.number().int(),
    ParentProcessId: z.number().int(),
    CommandLine: z.string().nullable(),
  }),
);

/**
 * Stop the supervisor chains running `scripts` (ours and the legacy
 * launchers'): see {@link supervisorChain}. Processes are stopped one by one,
 * never as a tree: omp sessions the agent started must survive. Waits until
 * they are gone, since cmd.exe reads a running batch file from disk and must
 * not see it rewritten.
 */
async function stopWindowsService(scripts: readonly string[]): Promise<void> {
  // CIM through PowerShell is the one way to see command lines (wmic is gone).
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
    "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine)";
  const processes = WinProcesses.parse(
    JSON.parse(
      await run([
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ]),
    ),
  );
  const targets = supervisorChain(processes, scripts, cliEntry);
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGKILL");
      console.log(`  stopped pid ${pid}`);
    } catch {
      // Already gone.
    }
  }
  for (let i = 0; i < 50; i++) {
    const alive = targets.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("the running omp-remote service did not stop");
}

/** Delete the legacy launcher files that exist, once their chain is stopped. */
async function removeLegacyLaunchers(
  legacy: LegacyWindowsLaunchers,
): Promise<void> {
  for (const file of legacy.files) {
    if (!existsSync(file)) continue;
    await rm(file, { force: true });
    console.log(`  removed the legacy launcher ${file}`);
  }
}

/**
 * Restrict existing secret files to the current user. Files written before
 * anything restricted them keep the profile's inherited ACL. A failure is a
 * warning: the service still runs, and `doctor` reports it.
 */
async function restrictSecrets(): Promise<void> {
  const files = [
    ...Object.values(secretPaths),
    ipcTokenPath(),
    devClientSecretPath(),
  ];
  const account = windowsAccount();
  for (const file of files) {
    if (!existsSync(file)) continue;
    const failure = await restrictToOwner(file, undefined, account);
    if (failure)
      console.warn(
        `  warning: could not restrict ${basename(file)} to ${account} (${failure})`,
      );
  }
}

async function installWindows(): Promise<string> {
  const paths = windowsPaths();
  const logPath = join(resolvedStateDir(), "omp-remote.log");
  const { files } = renderWindowsService({
    bunPath: process.execPath,
    cliEntry,
    stateDir: resolvedStateDir(),
    logPath,
    home: homedir(),
    appData: process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  });
  // Machines set up by install-agent.ps1 also run its chain: stop it with
  // ours, and delete it, or it restarts a no-op agent at every logon.
  const legacy = legacyLaunchers();
  await stopWindowsService([paths.supervisor, ...legacy.scripts]);
  await removeLegacyLaunchers(legacy);
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, windowsFileBytes(file));
    console.log(`  wrote ${file.path}`);
  }
  await restrictSecrets();
  // A fresh chain also resets the restart backoff.
  await run(["wscript.exe", paths.startup]);
  console.log("  started the supervisor");
  return logPath;
}

async function installLinux(): Promise<string> {
  const unit = renderLinuxUnit({
    bunPath: process.execPath,
    cliEntry,
    stateDir: resolvedStateDir(),
    home: homedir(),
  });
  await mkdir(dirname(unit.path), { recursive: true });
  await writeFile(unit.path, unit.content);
  console.log(`  wrote ${unit.path}`);
  await run(["systemctl", "--user", "daemon-reload"]);
  await run(["systemctl", "--user", "enable", LINUX_UNIT_NAME]);
  // restart, not enable --now: a reinstall must pick up new code and config.
  await run(["systemctl", "--user", "restart", LINUX_UNIT_NAME]);
  console.log(`  enabled and restarted ${LINUX_UNIT_NAME}`);
  return "journalctl --user -u omp-remote";
}

/**
 * Register `omp-remote run` to start at login and (re)start it now, then
 * install the bridge extension. Windows: the supervisor `.cmd` plus a Startup
 * `.vbs`; Linux: a systemd user unit. Rerunning it restarts the service.
 */
export async function install(opts: InstallOptions = {}): Promise<void> {
  // A service without a valid config would only crash-loop.
  const cfg = await loadConfig();
  if (!existsSync(cliEntry))
    throw new Error(`missing CLI entry point: ${cliEntry}`);
  // The service runs from this checkout; a worktree is usually short-lived.
  if (statSync(join(repoRoot, ".git"), { throwIfNoEntry: false })?.isFile())
    throw new Error(
      `${repoRoot} is a git worktree; run omp-remote install from the main checkout`,
    );
  console.log("installing the omp-remote service");
  let output: string;
  if (process.platform === "win32") output = await installWindows();
  else if (process.platform === "linux") output = await installLinux();
  else throw unsupported();
  console.log(`  bridge: ${await installBridge()}`);

  if (opts.check && !(await waitHealthy(opts.check, opts.attempts ?? 90)))
    throw new Error(
      `omp-remote did not become healthy; run \`omp-remote doctor\` and read ${output}`,
    );

  if (cfg.server) {
    const port = cfg.server.listen.port;
    const urls = cfg.server.publicUrl
      ? [cfg.server.publicUrl]
      : [
          ...reachableUrls(
            networkInterfaces(),
            port,
            await defaultRouteAddress(),
          ).map((u) => u.url),
          `http://localhost:${port}`,
        ];
    console.log("Open omp-remote at:");
    for (const url of urls) console.log(`  ${url}`);
  }
  console.log(`Service output (pairing code and QR included): ${output}`);
  if (process.platform === "linux")
    console.log(
      `To keep it running after logout: loginctl enable-linger ${userInfo().username}`,
    );
}

/** Stop the service and remove its login entry. Config, secrets, logs and the bridge stay. */
export async function uninstall(): Promise<void> {
  if (process.platform === "win32") {
    const paths = windowsPaths();
    const legacy = legacyLaunchers();
    await stopWindowsService([paths.supervisor, ...legacy.scripts]);
    for (const path of [paths.startup, paths.supervisor]) {
      await rm(path, { force: true });
      console.log(`  removed ${path}`);
    }
    await removeLegacyLaunchers(legacy);
  } else if (process.platform === "linux") {
    const unit = join(homedir(), ".config", "systemd", "user", LINUX_UNIT_NAME);
    if (existsSync(unit)) {
      await run(["systemctl", "--user", "disable", "--now", LINUX_UNIT_NAME]);
      await rm(unit, { force: true });
      await run(["systemctl", "--user", "daemon-reload"]);
      console.log(`  removed ${unit}`);
    }
  } else throw unsupported();
  console.log("omp-remote no longer starts at login");
}
