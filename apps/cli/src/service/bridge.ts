import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bridgeDir = fileURLToPath(
  new URL("../../../../packages/bridge/", import.meta.url),
);

/** OMP loads global extensions from `~/.omp/agent/extensions/`; OMP takes the `.ts` name. */
export function bridgeInstallPath(home: string = homedir()): string {
  return join(home, ".omp", "agent", "extensions", "omp-remote-bridge.ts");
}

/**
 * Build `packages/bridge` with its own `build.ts` and copy the bundle over the
 * installed extension, keeping the replaced file as `<name>.bak-<unix seconds>`.
 * Only omp sessions started afterwards load it. Returns the installed path.
 */
export async function installBridge(
  dest: string = bridgeInstallPath(),
): Promise<string> {
  const build = Bun.spawn([process.execPath, join(bridgeDir, "build.ts")], {
    cwd: bridgeDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(
      `bridge build failed (exit ${code}): ${(stderr || stdout).trim()}`,
    );
  await mkdir(dirname(dest), { recursive: true });
  if (await Bun.file(dest).exists())
    await copyFile(dest, `${dest}.bak-${Math.floor(Date.now() / 1000)}`);
  await copyFile(join(bridgeDir, "dist", "omp-remote-bridge.js"), dest);
  return dest;
}
