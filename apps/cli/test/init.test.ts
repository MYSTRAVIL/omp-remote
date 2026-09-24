import { afterEach, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { MachineStore } from "@omp-remote/aggregator/src/machine-store";
import { PasswordFile } from "@omp-remote/aggregator/src/password";
import { loadConfig, secretPaths } from "@omp-remote/config";
import { readSecret } from "@omp-remote/protocol/ipc";
import { z } from "zod";
import { main } from "../src/main";
import { cleanUp, cliDeps, freshState } from "./helpers/cli";

afterEach(cleanUp);

const PASSWORD = "correct horse battery";

/** Every file in `dir` with its content, to prove a refused init wrote nothing. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of (await readdir(dir)).sort())
    files.set(name, await readFile(join(dir, name), "utf8"));
  return files;
}

test("init --role host writes both sections, the secrets, and a machine token the server accepts", async () => {
  await freshState();
  const { deps } = cliDeps({ readStdin: async () => PASSWORD });

  const code = await main(
    ["init", "--role", "host", "--name", "box", "--password-stdin"],
    deps,
  );

  expect(code).toBe(0);
  const cfg = await loadConfig();
  expect(cfg.machineId).toBe("box");
  expect(cfg.server?.listen).toEqual({ host: "0.0.0.0", port: 8788 });
  expect(cfg.agent?.serverUrl).toBe("http://127.0.0.1:8788");
  const password = PasswordFile.parse(
    JSON.parse(await readFile(secretPaths.password, "utf8")),
  );
  expect(await Bun.password.verify(PASSWORD, password.hash)).toBe(true);
  expect(await readSecret(secretPaths.sessionSecret)).toBeDefined();
  z.object({
    publicKey: z.string().min(1),
    privateKey: z.string().min(1),
  }).parse(JSON.parse(await readFile(secretPaths.vapid, "utf8")));
  const machines = await MachineStore.load(secretPaths.machines);
  const token = await readFile(secretPaths.agentToken, "utf8");
  expect(machines.authenticate(token)).toBe("box");
});

test("a second init without --force exits 1 and leaves every file as it was", async () => {
  const dir = await freshState();
  const first = cliDeps({ readStdin: async () => PASSWORD });
  expect(
    await main(
      ["init", "--role", "host", "--name", "box", "--password-stdin"],
      first.deps,
    ),
  ).toBe(0);
  const before = await snapshot(dir);

  const second = cliDeps({ readStdin: async () => "a different password" });
  const code = await main(
    ["init", "--role", "server", "--name", "other", "--password-stdin"],
    second.deps,
  );

  expect(code).toBe(1);
  expect(second.err.join("\n")).toContain("--force");
  expect(await snapshot(dir)).toEqual(before);
});

test("init refuses a public URL that is not https and writes nothing", async () => {
  const dir = await freshState();
  const { deps, err } = cliDeps({ readStdin: async () => PASSWORD });

  const code = await main(
    [
      "init",
      "--role",
      "server",
      "--public-url",
      "http://x",
      "--password-stdin",
    ],
    deps,
  );

  expect(code).toBe(1);
  expect(err.join("\n")).toContain("https://");
  expect(await readdir(dir)).toEqual([]);
});

test("init --role server behind a public URL listens on loopback and runs no agent", async () => {
  await freshState();
  const { deps } = cliDeps({ readStdin: async () => PASSWORD });

  const code = await main(
    [
      "init",
      "--role",
      "server",
      "--name",
      "vps",
      "--public-url",
      "https://remote.example.com",
      "--password-stdin",
    ],
    deps,
  );

  expect(code).toBe(0);
  const cfg = await loadConfig();
  expect(cfg.server?.listen.host).toBe("127.0.0.1");
  expect(cfg.server?.publicUrl).toBe("https://remote.example.com");
  expect(cfg.agent).toBeUndefined();
  expect(await readSecret(secretPaths.agentToken)).toBeUndefined();
});
