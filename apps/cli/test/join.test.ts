import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MachineStore } from "@omp-remote/aggregator/src/machine-store";
import { startServer } from "@omp-remote/aggregator/src/main";
import { Config, loadConfig, secretPaths } from "@omp-remote/config";
import { newIdentity, pairingSas, phoneCommitment } from "@omp-remote/crypto";
import { PairClaimResponse } from "@omp-remote/protocol";
import { z } from "zod";
import { writeCheapPassword } from "../../aggregator/test/helpers/password";
import { main } from "../src/main";
import { renderQr } from "../src/qr";
import { pairLink } from "../src/urls";
import { cleanUp, cleanups, cliDeps, tempDir } from "./helpers/cli";

afterEach(cleanUp);

const PASSWORD = "correct horse battery";

test("join pairs through a running server and ends with a machine token it accepts", async () => {
  // The server machine: its own state dir, a password, a random port.
  const serverDir = await tempDir();
  process.env.OMP_REMOTE_STATE_DIR = serverDir;
  // A second back: `iat` has second granularity, and a session issued in the
  // same second as the password would count as issued before it.
  await writeCheapPassword(secretPaths.password, PASSWORD, Date.now() - 1000);
  const server = await startServer(
    Config.parse({
      version: 1,
      machineId: "server",
      server: { listen: { host: "127.0.0.1", port: 0 }, webRoot: serverDir },
    }),
  );
  cleanups.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;

  // The owner's phone signs in; its session gates the claim.
  const login = await fetch(`${base}/auth/login/password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const { token } = z.object({ token: z.string() }).parse(await login.json());
  const phone = await newIdentity();
  let phoneSas: string | undefined;
  const claimPairing = async (code: string): Promise<void> => {
    const { rendezvousId, mac } = await phoneCommitment(code, phone.publicKey);
    const res = await fetch(`${base}/pair/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        rendezvousId,
        phonePub: phone.publicKey,
        phoneMac: mac,
      }),
    });
    if (!res.ok) throw new Error(`claim failed: ${res.status}`);
    const claim = PairClaimResponse.parse(await res.json());
    phoneSas = await pairingSas(
      code,
      claim.machineId,
      claim.hostPub,
      phone.publicKey,
    );
  };

  // The joining machine: a state dir of its own. The phone claims as soon as
  // the code is shown; the host's poll waits on that claim, not on a timer.
  const agentDir = await tempDir();
  process.env.OMP_REMOTE_STATE_DIR = agentDir;
  const claimed = Promise.withResolvers<void>();
  let code: string | undefined;
  const { deps, out } = cliDeps({ sleep: () => claimed.promise });
  const print = deps.print;
  deps.print = (text) => {
    print(text);
    const shown = /^Pairing code: (\S+)$/.exec(text)?.[1];
    if (shown === undefined) return;
    code = shown;
    claimed.resolve(claimPairing(shown));
  };

  const exit = await main(["join", base, "--name", "box"], deps);

  expect(exit).toBe(0);
  if (code === undefined) throw new Error("no pairing code was shown");
  expect(out).toContain(renderQr(pairLink(base, code)));
  expect(out).toContain(`SAS: ${phoneSas}`);
  const machines = await MachineStore.load(join(serverDir, "machines.json"));
  const agentToken = await readFile(join(agentDir, "agent-token"), "utf8");
  expect(machines.authenticate(agentToken)).toBe("box");
  const cfg = await loadConfig();
  expect(cfg.server).toBeUndefined();
  expect(cfg.agent?.serverUrl).toBe(base);
  expect(cfg.agent?.phoneId).toBe(phone.publicKey);
});
