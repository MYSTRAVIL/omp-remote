import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MachineStore } from "@omp-remote/aggregator/src/machine-store";
import { Config, saveConfig, secretPaths } from "@omp-remote/config";
import { PairingStore, newIdentity } from "@omp-remote/crypto";
import { MachinesMsg } from "@omp-remote/protocol";
import { z } from "zod";
import { writeCheapPassword } from "../../aggregator/test/helpers/password";
import { main } from "../src/main";
import { cleanUp, cleanups, cliDeps, freshState } from "./helpers/cli";

afterEach(cleanUp);

const PASSWORD = "correct horse battery";

test("run starts server and agent from one config; the machine comes online; stop ends both", async () => {
  const dir = await freshState();
  await writeFile(join(dir, "index.html"), "<!doctype html>");
  // What init and a pairing leave behind: a machine token, a trusted phone, a password.
  const machines = await MachineStore.load(secretPaths.machines);
  await writeFile(
    secretPaths.agentToken,
    await machines.issue("box", Date.now()),
  );
  const phone = await newIdentity();
  const pairing = new PairingStore(secretPaths.pairing);
  await pairing.load();
  await pairing.trust({ id: phone.publicKey, publicKey: phone.publicKey });
  // A second back: `iat` has second granularity.
  await writeCheapPassword(secretPaths.password, PASSWORD, Date.now() - 1000);
  await saveConfig(
    Config.parse({
      version: 1,
      machineId: "box",
      server: { listen: { host: "127.0.0.1", port: 0 }, webRoot: dir },
      // Nothing listens here: the in-process agent must dial the bound port.
      agent: { serverUrl: "http://127.0.0.1:1" },
    }),
  );

  const stop = Promise.withResolvers<void>();
  const listening = Promise.withResolvers<string>();
  const { deps, err } = cliDeps({ stopRequested: () => stop.promise });
  const print = deps.print;
  deps.print = (text) => {
    print(text);
    const url = /^\s+(http:\/\/127\.0\.0\.1:\d+)\s/.exec(text)?.[1];
    if (url !== undefined) listening.resolve(url);
  };
  const running = main(["run"], deps);
  const base = await Promise.race([
    listening.promise,
    running.then((code) => {
      throw new Error(`run exited ${code}: ${err.join(" ")}`);
    }),
  ]);

  // The owner signs in, attaches to the machine's route and asks who is online.
  const login = await fetch(`${base}/auth/login/password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const { token } = z.object({ token: z.string() }).parse(await login.json());
  const socket = new WebSocket(
    `${base.replace("http:", "ws:")}/client?token=${encodeURIComponent(token)}`,
  );
  const closed = Promise.withResolvers<void>();
  socket.addEventListener("close", () => closed.resolve(), { once: true });
  const online = Promise.withResolvers<void>();
  socket.addEventListener("message", (ev) => {
    const msg = MachinesMsg.safeParse(JSON.parse(String(ev.data)));
    if (msg.success && msg.data.machineIds.includes("box")) online.resolve();
  });
  const opened = Promise.withResolvers<void>();
  socket.addEventListener("open", () => opened.resolve(), { once: true });
  await opened.promise;
  // Attach first so a later registration is announced; `list` covers an earlier one.
  socket.send(JSON.stringify({ type: "attach", machineId: "box" }));
  socket.send(JSON.stringify({ type: "list" }));
  await online.promise;

  // Close the phone first: a client socket still open when its server stops
  // has crashed Bun 1.4.2 (segfault in the next test file) on Windows.
  socket.close();
  await closed.promise;
  stop.resolve();
  expect(await running).toBe(0);
  expect(err).toEqual([]);
  await expect(fetch(`${base}/auth/methods`)).rejects.toThrow();
});

test("run shows a fresh pairing code when one expires and keeps serving until stopped", async () => {
  const dir = await freshState();
  await writeFile(join(dir, "index.html"), "<!doctype html>");
  await writeCheapPassword(secretPaths.password, PASSWORD, Date.now() - 1000);
  // No machine token yet: run must pair a phone before the agent can start.
  await saveConfig(
    Config.parse({
      version: 1,
      machineId: "box",
      server: { listen: { host: "127.0.0.1", port: 0 }, webRoot: dir },
      agent: { serverUrl: "http://127.0.0.1:1" },
    }),
  );

  const stop = Promise.withResolvers<void>();
  const listening = Promise.withResolvers<string>();
  const reissued = Promise.withResolvers<void>();
  const codes: string[] = [];
  let skew = 0;
  const { deps, out, err } = cliDeps({
    stopRequested: () => stop.promise,
    now: () => Date.now() + skew,
    // The first code's wait jumps past its lifetime; the second one's never ends.
    sleep: async () => {
      if (codes.length > 1) return Promise.withResolvers<void>().promise;
      skew += 60 * 60_000;
    },
  });
  const print = deps.print;
  deps.print = (text) => {
    print(text);
    const url = /^\s+(http:\/\/127\.0\.0\.1:\d+)\s/.exec(text)?.[1];
    if (url !== undefined) listening.resolve(url);
    const code = /^Pairing code: (\S+)$/.exec(text)?.[1];
    if (code === undefined) return;
    codes.push(code);
    if (codes.length === 2) reissued.resolve();
  };
  const running = main(["run"], deps);
  const exited = running.then((code) => {
    throw new Error(`run exited ${code}: ${err.join(" ")}`);
  });
  const base = await Promise.race([listening.promise, exited]);
  await Promise.race([reissued.promise, exited]);

  expect(codes).toHaveLength(2);
  expect(out).toContain("The pairing code expired; here is a fresh one.");
  expect((await fetch(`${base}/auth/methods`)).ok).toBe(true);

  stop.resolve();
  expect(await running).toBe(0);
  expect(err).toEqual([]);
  await expect(fetch(`${base}/auth/methods`)).rejects.toThrow();
});
