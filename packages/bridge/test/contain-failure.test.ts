import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame, SessionMeta } from "@omp-remote/protocol";
import { IpcServer, connectIpc } from "@omp-remote/protocol/ipc";
import type { BridgeDiagnostic } from "../src/diagnostics";
import { containFailure, wireCompact } from "../src/index";
import { SessionBridge } from "../src/session-bridge";

let server: IpcServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function addr() {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omp-remote-cf-${Math.random().toString(36).slice(2)}`
    : join(
        tmpdir(),
        `omp-remote-cf-${Math.random().toString(36).slice(2)}.sock`,
      );
}
const meta: SessionMeta = {
  id: "s1",
  cwd: "/x/p",
  project: "p",
  model: "m",
  title: "T",
  pid: 9,
  startedAt: 0,
};

test("a rejected compaction reaches the phone as a controlError", async () => {
  const path = addr();
  server = new IpcServer({ token: "tok" });
  const reported = Promise.withResolvers<Frame>();
  server.onConnection((conn) =>
    conn.onFrame((frame) => {
      if (frame.t === "hello")
        conn.send({ t: "compact", sessionId: meta.id, instructions: "trim" });
      if (frame.t === "controlError") reported.resolve(frame);
    }),
  );
  await server.listen(path);

  const bridge = new SessionBridge({
    token: "tok",
    path,
    meta,
    connect: connectIpc,
  });
  const diagnostics: BridgeDiagnostic[] = [];
  const asked: (string | undefined)[] = [];
  wireCompact(
    bridge,
    (instructions) => {
      asked.push(instructions);
      return Promise.reject(new Error("compaction failed"));
    },
    (event) => diagnostics.push(event),
  );
  await bridge.start();

  expect(await reported.promise).toEqual({
    t: "controlError",
    sessionId: meta.id,
    action: "compact",
    code: "control-failed",
    message: "Compaction failed.",
  });
  expect(asked).toEqual(["trim"]);
  expect(diagnostics).toContainEqual({
    event: "bridge_operation_failed",
    code: "compact-failed",
  });
  bridge.stop();
});

test("a synchronous throw and a throwing reporter are contained too", async () => {
  await expect(
    containFailure(
      () => {
        throw new Error("no session");
      },
      () => {
        throw new Error("ipc gone");
      },
    ),
  ).resolves.toBeUndefined();
});

test("a successful operation does not report a failure", async () => {
  let failures = 0;
  await containFailure(
    () => Promise.resolve(),
    () => {
      failures += 1;
    },
  );
  expect(failures).toBe(0);
});
