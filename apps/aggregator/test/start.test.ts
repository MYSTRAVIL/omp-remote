import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, secretPaths } from "@omp-remote/config";
import { type RunningServer, startServer } from "../src/main";
import { generateVapidKeys } from "../src/vapid";
import { writeCheapPassword } from "./helpers/password";

const savedStateDir = process.env.OMP_REMOTE_STATE_DIR;
const dirs: string[] = [];
let running: RunningServer | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
  if (savedStateDir === undefined)
    Reflect.deleteProperty(process.env, "OMP_REMOTE_STATE_DIR");
  else process.env.OMP_REMOTE_STATE_DIR = savedStateDir;
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

/**
 * Start a server on a free loopback port from a fresh state dir, after
 * `prepare` seeds it. The dir doubles as an empty web root, so a route the
 * server does not serve answers 404 rather than the SPA.
 */
async function start(prepare?: () => Promise<void>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-remote-start-"));
  dirs.push(dir);
  process.env.OMP_REMOTE_STATE_DIR = dir;
  await prepare?.();
  running = await startServer(
    Config.parse({
      version: 1,
      machineId: "box",
      server: { listen: { host: "127.0.0.1", port: 0 }, webRoot: dir },
    }),
  );
  return `http://127.0.0.1:${running.port}`;
}

test("startServer offers the password once password.json exists, and no passkeys without a publicUrl", async () => {
  const base = await start();
  expect(await (await fetch(`${base}/auth/methods`)).json()).toEqual({
    password: false,
    passkey: false,
  });

  await writeCheapPassword(secretPaths.password, "correct horse", Date.now());
  expect(await (await fetch(`${base}/auth/methods`)).json()).toEqual({
    password: true,
    passkey: false,
  });
});

test("startServer serves push only when vapid.json exists", async () => {
  const bare = await start();
  expect((await fetch(`${bare}/push/vapid`)).status).toBe(404);
  await running?.stop();

  const keys = await generateVapidKeys("mailto:unused@example.com");
  const withPush = await start(() =>
    writeFile(
      secretPaths.vapid,
      JSON.stringify({
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
      }),
    ),
  );
  expect(await (await fetch(`${withPush}/push/vapid`)).json()).toEqual({
    publicKey: keys.publicKey,
  });
});
