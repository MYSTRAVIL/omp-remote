import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectIpc } from "@omp-remote/protocol/ipc";
import type { CollabSessionSink } from "../src/collab";
import {
  CollabController,
  type CollabHostInfo,
} from "../src/collab/controller";
import type { GuestSocketFactory } from "../src/collab/guest";
import type { AgentDiagnostic } from "../src/diagnostics";
import { AgentService } from "../src/service";

const socketFactory: GuestSocketFactory = () => ({
  send: () => {},
  close: () => {},
  onOpen: () => {},
  onClose: () => {},
  onMessage: () => {},
  onError: () => {},
});

function fakeService(ipcSessions: Set<string> = new Set()) {
  const registered = new Set<string>();
  const closed = new Set<string>();
  const service: CollabSessionSink = {
    registerCollabSession(meta) {
      registered.add(meta.id);
      return {
        emit: () => {},
        close: () => {
          closed.add(meta.id);
        },
      };
    },
    hasIpcSession: (sessionId) => ipcSessions.has(sessionId),
  };
  return { service, registered, closed };
}

function fakeLink(): string {
  const secret = crypto.getRandomValues(new Uint8Array(48));
  const roomId = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("base64url");
  return `${roomId}.${Buffer.from(secret).toString("base64url")}`;
}

function host(
  instanceId: string,
  sessionId = `s-${instanceId}`,
  generation = 1,
): CollabHostInfo {
  return {
    instanceId,
    generation,
    sessionId,
    cwd: "/tmp/proj",
    model: "opus",
    sessionName: null,
    pid: 1,
    startedAt: 0,
  };
}

test("attaches newly seen rooms and detaches vanished ones", async () => {
  const { service, registered, closed } = fakeService();
  let hosts: CollabHostInfo[] = [host("A")];
  const controller = new CollabController({
    service,
    listHosts: async () => hosts,
    linkFor: async () => fakeLink(),
    socketFactory,
    isAlive: () => false,
  });

  await controller.refresh();
  expect(controller.attached).toEqual(["A"]);
  expect(registered.has("s-A")).toBe(true);

  hosts = [host("A"), host("B")];
  await controller.refresh();
  expect(new Set(controller.attached)).toEqual(new Set(["A", "B"]));

  hosts = [host("B")];
  await controller.refresh();
  expect(controller.attached).toEqual(["B"]);
  expect(closed.has("s-A")).toBe(true);
});

test("attaches newly seen rooms concurrently", async () => {
  const { service } = fakeService();
  let started = 0;
  // Resolves only if both link fetches are in flight before either returns:
  // `release` is held, so neither linkFor can resolve until we let it. A
  // sequential attach would reach `started === 1` and this promise would never
  // settle, timing the test out.
  const bothStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new CollabController({
    service,
    listHosts: async () => [host("A"), host("B")],
    linkFor: async () => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      await release.promise;
      return fakeLink();
    },
    socketFactory,
    isAlive: () => true,
  });

  const refreshed = controller.refresh();
  await bothStarted.promise;
  release.resolve();
  await refreshed;
  expect(new Set(controller.attached)).toEqual(new Set(["A", "B"]));
});

test("keeps a vanished room while its process is alive, detaches once gone", async () => {
  const { service, closed } = fakeService();
  let hosts: CollabHostInfo[] = [host("A")];
  let alive = true;
  const controller = new CollabController({
    service,
    listHosts: async () => hosts,
    linkFor: async () => fakeLink(),
    socketFactory,
    isAlive: () => alive,
  });

  await controller.refresh();
  expect(controller.attached).toEqual(["A"]);

  // The room drops out of `omp collab list` transiently, but its process lives.
  hosts = [];
  await controller.refresh();
  expect(controller.attached).toEqual(["A"]); // still bridged and listed
  expect(closed.has("s-A")).toBe(false); // never deregistered

  // Once the process exits, the next refresh detaches it.
  alive = false;
  await controller.refresh();
  expect(controller.attached).toEqual([]);
  expect(closed.has("s-A")).toBe(true);
});

test("a room already attached is not re-attached on the next refresh", async () => {
  const { service } = fakeService();
  let calls = 0;
  const controller = new CollabController({
    service,
    listHosts: async () => [host("A")],
    linkFor: async () => {
      calls++;
      return fakeLink();
    },
    socketFactory,
  });
  await controller.refresh();
  await controller.refresh();
  expect(calls).toBe(1);
  expect(controller.attached).toEqual(["A"]);
});

test("an in-process session switch (new generation) re-attaches to the new room", async () => {
  // omp keeps instanceId for the process lifetime; /new or /resume starts a new
  // room with a bumped generation and the new session id.
  const { service, registered, closed } = fakeService();
  let hosts: CollabHostInfo[] = [host("A", "s-old", 1)];
  let links = 0;
  const controller = new CollabController({
    service,
    listHosts: async () => hosts,
    linkFor: async () => {
      links++;
      return fakeLink();
    },
    socketFactory,
    isAlive: () => true,
  });
  await controller.refresh();

  hosts = [host("A", "s-new", 2)];
  await controller.refresh();

  expect(links).toBe(2);
  expect(controller.attached).toEqual(["A"]);
  expect(registered.has("s-new")).toBe(true);
  expect(closed.has("s-old")).toBe(true);
});

test("skips an excluded session id", async () => {
  const { service, registered } = fakeService();
  const controller = new CollabController({
    service,
    listHosts: async () => [host("A", "self"), host("B")],
    linkFor: async () => fakeLink(),
    socketFactory,
    excludeSessionId: "self",
  });
  await controller.refresh();
  expect(controller.attached).toEqual(["B"]);
  expect(registered.has("self")).toBe(false);
});

test("does not bridge a session the IPC fallback already owns", async () => {
  const { service, registered } = fakeService(new Set(["s-A"]));
  const controller = new CollabController({
    service,
    listHosts: async () => [host("A"), host("B")],
    linkFor: async () => fakeLink(),
    socketFactory,
  });
  await controller.refresh();
  expect(controller.attached).toEqual(["B"]); // A is IPC-bridged, so Collab skips it
  expect(registered.has("s-A")).toBe(false);
});

test("one rejected room lookup does not block healthy rooms and retries later", async () => {
  const { service, registered } = fakeService();
  let rejectA = true;
  const controller = new CollabController({
    service,
    listHosts: async () => [host("A"), host("B")],
    linkFor: async (instanceId) => {
      if (instanceId === "A" && rejectA) throw new Error("room disappeared");
      return fakeLink();
    },
    socketFactory,
  });

  await controller.refresh();
  expect(controller.attached).toEqual(["B"]);
  expect(registered.has("s-A")).toBe(false);
  expect(registered.has("s-B")).toBe(true);

  rejectA = false;
  await controller.refresh();
  expect(new Set(controller.attached)).toEqual(new Set(["A", "B"]));
  expect(registered.has("s-A")).toBe(true);
  controller.stop();
});

test("a discovery failure preserves attached rooms and recovers later", async () => {
  const { service, closed } = fakeService();
  let hosts = [host("A")];
  let rejectDiscovery = false;
  const controller = new CollabController({
    service,
    listHosts: async () => {
      if (rejectDiscovery) throw new Error("registry unavailable");
      return hosts;
    },
    linkFor: async () => fakeLink(),
    socketFactory,
    isAlive: () => false,
  });

  await controller.refresh();
  rejectDiscovery = true;
  await controller.refresh();
  expect(controller.attached).toEqual(["A"]);

  rejectDiscovery = false;
  hosts = [host("B")];
  await controller.refresh();
  expect(controller.attached).toEqual(["B"]);
  expect(closed.has("s-A")).toBe(true);
  controller.stop();
});

test("an unattended room lookup failure leaves the agent service available", async () => {
  const ipcPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\omp-remote-collab-${Math.random().toString(36).slice(2)}`
      : join(
          tmpdir(),
          `omp-remote-collab-${Math.random().toString(36).slice(2)}.sock`,
        );
  const service = new AgentService({
    token: "tok",
    ipcPath,
  });
  await service.start();
  const failed = Promise.withResolvers<void>();
  const controller = new CollabController({
    service,
    listHosts: async () => [host("A")],
    linkFor: async () => {
      throw new Error("room disappeared");
    },
    intervalMs: 60_000,
    diagnostic: (event) => {
      if (event.event === "collab_attach_failed") failed.resolve();
    },
  });

  try {
    controller.start();
    await failed.promise;
    // Still serving: a bridge can register and subscribers see it listed.
    const listed = Promise.withResolvers<void>();
    const unsubscribe = service.subscribe((msg) => {
      if (msg.t === "sessions" && msg.sessions.some((s) => s.id === "live"))
        listed.resolve();
    });
    const bridge = await connectIpc(ipcPath, "tok");
    bridge.send({
      t: "hello",
      token: "tok",
      session: {
        id: "live",
        cwd: "/x",
        project: "x",
        model: "m",
        title: "T",
        pid: 1,
        startedAt: 0,
      },
    });
    await listed.promise;
    unsubscribe();
    bridge.close();
  } finally {
    controller.stop();
    await service.stop();
  }
});

test("repeated discovery failures log once until recovery", async () => {
  const { service } = fakeService();
  const diagnostics: AgentDiagnostic[] = [];
  let failing = true;
  const controller = new CollabController({
    service,
    listHosts: async () => {
      if (failing)
        throw new Error(
          "PRIVATE_DISCOVERY_ERROR token=secret wss://relay/r/room#key",
        );
      return [];
    },
    linkFor: async () => fakeLink(),
    socketFactory,
    diagnostic: (event) => diagnostics.push(event),
  });

  await controller.refresh();
  await controller.refresh();
  await controller.refresh();
  failing = false;
  await controller.refresh();

  expect(diagnostics).toEqual([
    {
      event: "collab_discovery_failed",
      code: "list-failed",
    },
    {
      event: "collab_discovery_recovered",
      suppressedCount: 2,
    },
  ]);
  expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_DISCOVERY_ERROR");
  expect(JSON.stringify(diagnostics)).not.toContain("secret");
});

test("repeated room attach failures log once per session until success", async () => {
  const { service } = fakeService();
  const diagnostics: AgentDiagnostic[] = [];
  let failing = true;
  const controller = new CollabController({
    service,
    listHosts: async () => [host("PRIVATE_INSTANCE", "session-a")],
    linkFor: async () => {
      if (failing)
        throw new Error(
          "PRIVATE_ATTACH_ERROR wss://relay.example/r/room#secret",
        );
      return fakeLink();
    },
    socketFactory,
    diagnostic: (event) => diagnostics.push(event),
  });

  await controller.refresh();
  await controller.refresh();
  failing = false;
  await controller.refresh();

  expect(
    diagnostics.filter((event) => event.event === "collab_attach_failed"),
  ).toEqual([
    {
      event: "collab_attach_failed",
      sessionId: "session-a",
      code: "attach-failed",
    },
  ]);
  expect(controller.attached).toEqual(["PRIVATE_INSTANCE"]);
  expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_ATTACH_ERROR");
  expect(JSON.stringify(diagnostics)).not.toContain("relay.example");
  controller.stop();
});
