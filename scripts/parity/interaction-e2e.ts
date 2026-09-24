// Live end-to-end smoke of the INTEGRATED bridge (kept, like smoke.ts; run on omp bumps).
// Loads the REAL bundled bridge into a live `omp` session and answers a model question over
// the REAL IPC transport, standing in for the host-agent with a bare IpcServer on an isolated
// pipe (OMP_REMOTE_IPC_PATH). Proves the whole plumbing chain end to end:
//   model calls `ask` → shadow tool → SessionBridge.raiseInteraction → interaction frame over
//   IPC → (fake host answers) → interactionReply → bridge resolves → answer reaches the model.
//
// Run:
//   OMP_BIN=<omp> BRIDGE_BUNDLE=<bundled bridge> SPIKE_MODEL=<model> bun run scripts/parity/interaction-e2e.ts

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "../../packages/protocol/src/frames";
import { type IpcConn, IpcServer } from "../../packages/protocol/src/ipc";
import { RpcProbeClient } from "./probe-client";

const MODEL = process.env.SPIKE_MODEL ?? "openai-codex/gpt-5.6-luna";
const BRIDGE = process.env.BRIDGE_BUNDLE;
const TOKEN = "e2e-token";
const TURN_TIMEOUT_MS = Number(process.env.SPIKE_TURN_TIMEOUT_MS ?? "180000");
const IPC =
  process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-e2e-${Date.now().toString(36)}`
    : join(tmpdir(), `omp-remote-e2e-${Date.now().toString(36)}.sock`);

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  — ${detail}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  if (!BRIDGE || !existsSync(BRIDGE)) {
    throw new Error(`BRIDGE_BUNDLE not found: ${BRIDGE}`);
  }
  console.log(`model: ${MODEL}\nipc:   ${IPC}\n`);

  const server = new IpcServer();
  let sawHello = false;
  const gotInteraction = Promise.withResolvers<Frame>();
  server.onConnection((conn: IpcConn) => {
    conn.onFrame((f) => {
      if (f.t === "hello") {
        sawHello = f.token === TOKEN;
      } else if (f.t === "interaction") {
        gotInteraction.resolve(f);
        conn.send({
          t: "interactionReply",
          sessionId: f.sessionId,
          id: f.id,
          response: { kind: "ask", answers: ["E2E_ANSWER"] },
        });
      }
    });
  });
  await server.listen(IPC);

  const client = new RpcProbeClient({
    extraArgs: ["-e", BRIDGE, "--model", MODEL],
    env: { OMP_REMOTE_IPC_PATH: IPC, OMP_REMOTE_TOKEN: TOKEN },
    readyTimeoutMs: 60_000,
    requestTimeoutMs: TURN_TIMEOUT_MS,
  });

  try {
    await client.start();
    void client
      .prompt(
        "Call the `ask` tool exactly once with a single question 'Pick a letter' " +
          "offering options 'A' and 'B'. Do not write files. After you get my answer, " +
          "reply with exactly: DONE <answer>.",
      )
      .catch(() => undefined);

    const timeout = new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), TURN_TIMEOUT_MS),
    );
    const frame = await Promise.race([gotInteraction.promise, timeout]);

    check(
      "bridge connected over IPC (hello)",
      sawHello,
      sawHello ? "hello received with the expected token" : "no hello frame",
    );
    check(
      "shadow ask raised an interaction over IPC",
      frame !== undefined && frame.t === "interaction",
      frame && frame.t === "interaction"
        ? `interaction id=${frame.id} payload=${JSON.stringify(frame.payload)}`
        : `no interaction frame | stderr: ${client.getStderr().slice(-400)}`,
    );

    if (frame && frame.t === "interaction") {
      const deadline = Date.now() + 60_000;
      let reached = false;
      while (Date.now() < deadline) {
        if (
          client.events.some((e) => JSON.stringify(e).includes("E2E_ANSWER"))
        ) {
          reached = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      check(
        "our answer round-tripped back to the model",
        reached,
        reached
          ? "tool result E2E_ANSWER observed in the model stream"
          : "answer not seen in stream",
      );
    }

    console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  } finally {
    await client.close();
    await server.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

await main();
