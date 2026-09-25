import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import {
  type ApprovalMode,
  type SpawnThinkingLevel,
  StoredSessionId,
} from "@omp-remote/protocol";

export interface SpawnOptions {
  cwd: string;
  model?: string;
  /** A stored session of `cwd` to reopen (`omp --resume <id>`); omp restores
   *  that session's own model, so `model` is ignored then. */
  resume?: string;
  /** omp `--thinking` for the spawned session (thinking effort). */
  thinkingLevel?: SpawnThinkingLevel;
  /** omp `--approval-mode` for the spawned session (spec §8 v1). */
  approvalMode?: ApprovalMode;
  /**
   * Phone-generated correlation nonce. Exported to the spawned omp as
   * `OMP_REMOTE_SPAWN_ID` so the bridge echoes it back in `SessionMeta.spawnId`,
   * letting the PWA open exactly the session it asked for.
   */
  spawnId?: string;
  /** The omp executable, `omp` by default. On win32 it is resolved to an
   *  absolute path on the host-agent's PATH before anything starts. */
  ompBin?: string;
  /**
   * win32 only: the Windows Terminal launcher (`wt.exe`) to open omp in, or
   * `null` to use conhost. Defaults to `wt.exe` resolved on the host-agent's
   * PATH, falling back to conhost when it is not installed. Tests pass it.
   */
  windowsTerminal?: string | null;
  /** Override platform detection (tests only). */
  platform?: NodeJS.Platform;
  /** Override the process launcher (tests only). */
  launch?: typeof launchDetached;
}
export interface SpawnHandle {
  pid: number;
  kill(): void;
}

/**
 * The `--model` values a spawn accepts: an omp model id (`provider/id`, a bare
 * id, `:variant` / `@version` suffixes) or an `@role` alias, at most 128
 * characters. Every allowed character is inert to cmd.exe, conhost, POSIX
 * shells, AppleScript strings and terminal `-e` parsing, and the value never
 * starts with `-`, so it cannot pose as another omp flag.
 */
const MODEL_ID = /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,127}$/;

/** A fully qualified Windows path: `C:\…`, `C:/…` or UNC `\\server\share…`.
 *  Drive-relative (`C:dir`) and root-relative (`\dir`) forms are refused: they
 *  resolve against the host-agent's own drive and directory. */
const WIN32_FULLY_QUALIFIED = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/** A drive-letter path `C:\…` / `C:/…`: the only form a phone-chosen win32
 *  cwd may take. UNC and device paths (`\\host\share`, `\\?\`, `\\.\`) are
 *  refused so a phone cannot make the host `stat` a remote SMB share (which
 *  would send the host user's NTLM credentials to that server). */
const WIN32_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Characters refused in every win32 omp argument. Windows Terminal and conhost
 * both expand `%VAR%` in the command line they start, and Windows Terminal
 * splits its own command line into subcommands at every `;` (`--model x;new-tab`
 * opened a second tab); both measured on Windows 10 22H2 with Windows Terminal.
 * When omp resolves to a `.cmd`/`.bat` shim (npm-style install) CreateProcess
 * re-parses the line through cmd.exe, whose operators, escapes and delayed
 * expansion are the rest.
 */
const WIN32_UNSAFE_ARG = /[%";!^&|<>()\p{Cc}]/u;

/** conhost.exe by absolute path: spawn resolves a bare command name in the
 *  child's cwd (the phone-chosen project) before PATH, so a project directory
 *  could otherwise shadow the launcher. */
const CONHOST = win32.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "conhost.exe",
);

/**
 * The omp CLI flags for a spawn (pure — the testable core of the argv). Throws
 * when the model is not a {@link MODEL_ID} or the resume id is not a
 * `StoredSessionId`, before any command line exists. A resume drops the model.
 */
export function spawnArgs(
  opts: Pick<
    SpawnOptions,
    "model" | "approvalMode" | "thinkingLevel" | "resume"
  >,
): string[] {
  const args: string[] = [];
  if (opts.resume !== undefined) {
    if (!StoredSessionId.safeParse(opts.resume).success)
      throw new Error(
        `spawn: resume ${JSON.stringify(opts.resume)} is not a stored session id`,
      );
    args.push("--resume", opts.resume);
  } else if (opts.model) {
    if (!MODEL_ID.test(opts.model))
      throw new Error(
        `spawn: model ${JSON.stringify(opts.model)} is not a valid omp model id`,
      );
    args.push("--model", opts.model);
  }
  if (opts.thinkingLevel) args.push("--thinking", opts.thinkingLevel);
  if (opts.approvalMode) args.push("--approval-mode", opts.approvalMode);
  return args;
}

/**
 * Refuse a spawn `cwd` that is not fully qualified (on win32: not a
 * drive-letter path), or that carries a control
 * character (Terminal.app's `do script` types the line into a shell, where a
 * control acts as an editing key) or, on win32, a `"`. Pure: `spawnSession`
 * separately requires an existing directory. cmd.exe metacharacters are
 * allowed: the win32 launch passes the cwd only as the launcher's working
 * directory, never on a command line.
 */
export function assertSpawnCwd(platform: NodeJS.Platform, cwd: string): void {
  const qualified =
    platform === "win32" ? WIN32_DRIVE_PATH.test(cwd) : posix.isAbsolute(cwd);
  if (!qualified)
    throw new Error(
      `spawn: cwd ${JSON.stringify(cwd)} is not an absolute path`,
    );
  if (/\p{Cc}/u.test(cwd) || (platform === "win32" && cwd.includes('"')))
    throw new Error(
      `spawn: cwd ${JSON.stringify(cwd)} contains a control character or quote`,
    );
}

export interface TerminalCommand {
  command: string;
  args: string[];
}

/** POSIX single-quote a value for embedding in a Unix shell command line. */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the OS command that opens `omp` as an interactive TUI in its own
 * terminal window with `cwd` as the working directory. omp's globally-installed
 * bridge extension registers the new session over loopback IPC, so it appears on
 * the phone — the same path an adopted desk session takes. Pure and
 * platform-parameterised so it is unit-testable; the impure launch lives in
 * {@link spawnSession}.
 *
 * win32 opens omp in a new Windows Terminal window:
 * `wt.exe -w new new-tab -d . -- <omp> <args>`, with no cmd.exe in the chain.
 * `-d .` makes the tab start in the launch's working directory, so the
 * phone-chosen `cwd` never appears on a command line (measured with a cwd
 * containing `;`, `&` and `%OS%`); `--` ends Windows Terminal's own options.
 * Windows Terminal renders omp's TUI correctly, which conhost does not. Without
 * `windowsTerminal` (not installed) it falls back to `conhost.exe -- <omp>
 * <args>`. Both launchers expand `%VAR%` and Windows Terminal splits on `;`, so
 * `ompBin` must be fully qualified (a bare name would be searched in the
 * project cwd first) and free of `%`, `;` and `"`, and the arguments are held
 * to {@link WIN32_UNSAFE_ARG}. The former `cmd.exe /c start "" /D <cwd> …`
 * parsed both the cwd and the model with cmd's rules, so a model like `x&calc`
 * ran a second command.
 *
 * The darwin/linux forms use the standard terminal-launch incantations;
 * `spawnSession` also sets `cwd` on the child so the launched shell inherits the
 * working directory.
 */
export function terminalCommand(
  platform: NodeJS.Platform,
  ompBin: string,
  ompArgs: readonly string[],
  cwd: string,
  windowsTerminal: string | null = null,
): TerminalCommand {
  if (platform === "win32") {
    if (!WIN32_FULLY_QUALIFIED.test(ompBin) || /[%;"\p{Cc}]/u.test(ompBin))
      throw new Error(
        `spawn: omp path ${JSON.stringify(ompBin)} must be absolute and free of %, ; and quotes`,
      );
    const unsafe = ompArgs.find((arg) => WIN32_UNSAFE_ARG.test(arg));
    if (unsafe !== undefined)
      throw new Error(
        `spawn: argument ${JSON.stringify(unsafe)} would not reach omp verbatim`,
      );
    if (windowsTerminal !== null) {
      if (!WIN32_FULLY_QUALIFIED.test(windowsTerminal))
        throw new Error(
          `spawn: Windows Terminal path ${JSON.stringify(windowsTerminal)} must be absolute`,
        );
      return {
        command: windowsTerminal,
        args: ["-w", "new", "new-tab", "-d", ".", "--", ompBin, ...ompArgs],
      };
    }
    // `--` ends conhost's own options; everything after it is the client's
    // command line.
    return { command: CONHOST, args: ["--", ompBin, ...ompArgs] };
  }
  if (platform === "darwin") {
    // Terminal.app `do script` runs a login shell; cd + exec binds the window to
    // omp so closing omp closes the window.
    const line = [
      `cd ${shSingleQuote(cwd)} &&`,
      `exec ${shSingleQuote(ompBin)}`,
      ...ompArgs.map(shSingleQuote),
    ].join(" ");
    const script = `tell application "Terminal" to do script "${line
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')}"`;
    return { command: "osascript", args: ["-e", script] };
  }
  // linux/other: the Debian-alternatives terminal; the working directory comes
  // from the child process cwd that `spawnSession` sets.
  return { command: "x-terminal-emulator", args: ["-e", ompBin, ...ompArgs] };
}

/**
 * Start a detached launcher process. Resolves once the OS reports the process
 * started and rejects on the child's `error` event (e.g. ENOENT for a missing
 * terminal). Without that listener a failed launch is an unhandled `error`
 * event, which kills the host-agent. `windowsHide` stays false: it would hide
 * the new terminal window along with the session.
 */
export function launchDetached(
  { command, args }: TerminalCommand,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnHandle> {
  const { promise, resolve, reject } = Promise.withResolvers<SpawnHandle>();
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env,
  });
  // Stays attached for the child's lifetime: a later error (e.g. from `kill`)
  // must not become an unhandled `error` event either.
  child.on("error", reject);
  child.once("spawn", () => {
    child.unref();
    const pid = child.pid;
    if (typeof pid !== "number") {
      reject(new Error("spawn produced no pid"));
      return;
    }
    resolve({ pid, kill: () => child.kill() });
  });
  return promise;
}

/**
 * Launch omp for a phone `spawn` frame. Everything the phone sent is checked
 * before any process starts; a refusal rejects, which the service reports as a
 * failed spawn.
 */
export async function spawnSession(opts: SpawnOptions): Promise<SpawnHandle> {
  const platform = opts.platform ?? process.platform;
  assertSpawnCwd(platform, opts.cwd);
  const info = await stat(opts.cwd).catch(() => undefined);
  if (!info?.isDirectory())
    throw new Error(
      `spawn: cwd ${JSON.stringify(opts.cwd)} is not an existing directory`,
    );
  const ompArgs = spawnArgs(opts);
  const requested = opts.ompBin ?? "omp";
  // With no shell in the win32 launch, omp is found here on the host-agent's
  // PATH (Bun.which never searches the cwd), and a missing omp fails now rather
  // than as a console window that flashes and closes.
  const ompBin = platform === "win32" ? Bun.which(requested) : requested;
  if (ompBin === null)
    throw new Error(
      `spawn: ${JSON.stringify(requested)} is not on the host-agent's PATH`,
    );
  const env = opts.spawnId
    ? { ...process.env, OMP_REMOTE_SPAWN_ID: opts.spawnId }
    : process.env;
  // Windows Terminal is found on the host-agent's PATH like omp (never in the
  // cwd); without it the session opens in a plain conhost console.
  const windowsTerminal =
    platform === "win32"
      ? opts.windowsTerminal === undefined
        ? Bun.which("wt.exe")
        : opts.windowsTerminal
      : null;
  // On win32 `pid` is the launcher (wt.exe hands the tab to the running
  // Windows Terminal and exits; conhost hosts omp's console), so `kill` is
  // best-effort; the handle is retained for interface parity with the Unix path.
  return (opts.launch ?? launchDetached)(
    terminalCommand(platform, ompBin, ompArgs, opts.cwd, windowsTerminal),
    opts.cwd,
    env,
  );
}
