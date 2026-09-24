import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CredentialStore } from "@omp-remote/aggregator/src/credential-store";
import { startServer } from "@omp-remote/aggregator/src/main";
import { Config, saveConfig, secretPaths } from "@omp-remote/config";
import { z } from "zod";
import { main } from "../src/main";
import { cleanUp, cleanups, cliDeps, freshState } from "./helpers/cli";

afterEach(cleanUp);

const PASSWORD = "correct horse battery";
const Methods = z.object({ password: z.boolean(), passkey: z.boolean() });

/**
 * A server machine whose owner turned password sign-in off, and a server
 * config on `port`: 0 until a test starts the server on a real one.
 */
async function passwordSignInOff(): Promise<Config> {
  const dir = await freshState();
  await writeFile(join(dir, "index.html"), "shell");
  const store = await CredentialStore.load(secretPaths.credentials);
  await store.setPasswordSignIn(false, Date.now());
  return Config.parse({
    version: 1,
    machineId: "box",
    server: { listen: { host: "127.0.0.1", port: 0 }, webRoot: dir },
  });
}

/** Start the server for `cfg` and point config.json at the port it bound. */
async function serve(cfg: Config) {
  const server = await startServer(cfg);
  cleanups.push(() => server.stop());
  const listen = { host: "127.0.0.1", port: server.port };
  await saveConfig(Config.parse({ ...cfg, server: { ...cfg.server, listen } }));
  return { server, base: `http://127.0.0.1:${server.port}` };
}

async function methods(base: string): Promise<z.infer<typeof Methods>> {
  return Methods.parse(await (await fetch(`${base}/auth/methods`)).json());
}

test("passwd --enable-password-sign-in turns password sign-in back on while the server is stopped", async () => {
  const cfg = await passwordSignInOff();
  const { server, base } = await serve(cfg);
  expect((await methods(base)).password).toBe(false);
  await server.stop();

  const { deps, out } = cliDeps({ readStdin: async () => PASSWORD });
  const code = await main(
    ["passwd", "--password-stdin", "--enable-password-sign-in"],
    deps,
  );

  expect(code).toBe(0);
  expect(out).toContain("Password sign-in is on.");
  // The next server offers the password form again, and the password works.
  const next = await serve(cfg);
  expect(await methods(next.base)).toEqual({ password: true, passkey: false });
  const login = await fetch(`${next.base}/auth/login/password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(login.status).toBe(200);
});

test("passwd --enable-password-sign-in refuses a running server and changes nothing", async () => {
  const cfg = await passwordSignInOff();
  const { base } = await serve(cfg);
  const before = await readFile(secretPaths.credentials, "utf8");

  const { deps, err } = cliDeps({ readStdin: async () => PASSWORD });
  const code = await main(
    ["passwd", "--password-stdin", "--enable-password-sign-in"],
    deps,
  );

  expect(code).toBe(1);
  expect(err.join("\n")).toContain(`the server at ${base} is running`);
  expect(await readFile(secretPaths.credentials, "utf8")).toBe(before);
  expect(await Bun.file(secretPaths.password).exists()).toBe(false);
  expect((await methods(base)).password).toBe(false);
});
