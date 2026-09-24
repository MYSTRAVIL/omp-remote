import { expect, test } from "bun:test";
import { COLLAB_PROTO } from "@oh-my-pi/pi-wire";
import type {
  DownlinkFrame,
  Scheduler,
  SessionMeta,
  UplinkFrame,
} from "@omp-remote/protocol";
import { CollabAdapter, type CollabSessionSink } from "../src/collab";
import type { GuestSocket, GuestSocketFactory } from "../src/collab/guest";
import type { AgentDiagnostic } from "../src/diagnostics";

// --- AES-256-GCM helpers mirroring the wire format: [4B peerId=0][12B IV][ct+tag] ---
async function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
async function sealJson(key: CryptoKey, obj: unknown): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new Uint8Array(new TextEncoder().encode(JSON.stringify(obj)));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt),
  );
  const env = new Uint8Array(4 + 12 + ct.byteLength);
  env.set(iv, 4);
  env.set(ct, 16);
  return env;
}
async function openEnvelope(key: CryptoKey, env: Uint8Array): Promise<unknown> {
  const iv = env.slice(4, 16);
  const ct = env.slice(16);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

interface FakeSocket {
  factory: GuestSocketFactory;
  sent: Uint8Array[];
  open(): void;
  message(data: Uint8Array): void;
  close(reason: string): void;
}

function fakeSocket(): FakeSocket {
  let onOpen: (() => void) | undefined;
  let onMessage: ((data: unknown) => void) | undefined;
  let onClose: ((reason: string) => void) | undefined;
  const sent: Uint8Array[] = [];
  const socket: GuestSocket = {
    send: (data) => sent.push(data),
    close: () => {},
    onOpen: (cb) => {
      onOpen = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    onMessage: (cb) => {
      onMessage = cb;
    },
    onError: () => {},
  };
  return {
    factory: () => socket,
    sent,
    open: () => onOpen?.(),
    message: (data) => onMessage?.(data),
    close: (reason) => onClose?.(reason),
  };
}

class FakeScheduler implements Scheduler {
  readonly timers: (() => void)[] = [];

  setTimer(fn: () => void): () => void {
    this.timers.push(fn);
    return () => {
      const index = this.timers.indexOf(fn);
      if (index >= 0) this.timers.splice(index, 1);
    };
  }

  setInterval(): () => void {
    return () => {};
  }

  fireNext(): void {
    const timer = this.timers.shift();
    if (!timer) throw new Error("no reconnect timer scheduled");
    timer();
  }
}

interface FakeService extends CollabSessionSink {
  emitted: UplinkFrame[];
  downlink(frame: DownlinkFrame): void;
  closed: boolean;
}

function fakeService(): FakeService {
  const emitted: UplinkFrame[] = [];
  let route: ((frame: DownlinkFrame) => void) | undefined;
  const svc: FakeService = {
    emitted,
    closed: false,
    downlink: (frame) => route?.(frame),
    registerCollabSession(_meta, onDownlink) {
      route = onDownlink;
      return {
        emit: (frame) => emitted.push(frame),
        close: () => {
          svc.closed = true;
        },
      };
    },
    hasIpcSession: () => false,
  };
  return svc;
}

const META: SessionMeta = {
  id: "sess-x",
  cwd: "/tmp",
  project: "p",
  model: "m",
  title: "t",
  pid: 1,
  startedAt: 0,
};

async function startAdapter(
  diagnostic?: (event: AgentDiagnostic) => void,
  scheduler = new FakeScheduler(),
) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const token = crypto.getRandomValues(new Uint8Array(16));
  const roomId = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("base64url");
  const secret = new Uint8Array(48);
  secret.set(key, 0);
  secret.set(token, 32);
  const link = `${roomId}.${Buffer.from(secret).toString("base64url")}`;
  const ckey = await importKey(key);
  const socket = fakeSocket();
  const service = fakeService();
  const adapter = new CollabAdapter({
    meta: META,
    link,
    service,
    socketFactory: socket.factory,
    diagnostic,
    scheduler,
  });
  await adapter.start();
  socket.open();
  await adapter.settled();
  return { adapter, socket, service, ckey, token, scheduler };
}

test("the guest hello carries the control link write token", async () => {
  const { ckey, socket, token } = await startAdapter();
  const hello = await openEnvelope(ckey, socket.sent[0] ?? new Uint8Array());

  expect(hello).toEqual({
    t: "hello",
    proto: COLLAB_PROTO,
    name: "omp-remote",
    writeToken: Buffer.from(token).toString("base64url"),
  });
});

test("a room close rejoins and repeats the authenticated hello", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const token = crypto.getRandomValues(new Uint8Array(16));
  const roomId = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("base64url");
  const secret = new Uint8Array(48);
  secret.set(key, 0);
  secret.set(token, 32);
  const first = fakeSocket();
  const second = fakeSocket();
  const sockets = [first, second];
  const scheduler = new FakeScheduler();
  const secondCreated = Promise.withResolvers<void>();
  const adapter = new CollabAdapter({
    meta: META,
    link: `${roomId}.${Buffer.from(secret).toString("base64url")}`,
    service: fakeService(),
    socketFactory: () => {
      const socket = sockets.shift();
      if (!socket) throw new Error("unexpected socket creation");
      if (socket === second) secondCreated.resolve();
      return socket.factory("");
    },
    scheduler,
  });

  await adapter.start();
  first.open();
  await adapter.settled();
  first.close("room closed");
  scheduler.fireNext();
  await secondCreated.promise;
  second.open();
  await adapter.settled();

  const ckey = await importKey(key);
  expect(await openEnvelope(ckey, second.sent[0] ?? new Uint8Array())).toEqual({
    t: "hello",
    proto: COLLAB_PROTO,
    name: "omp-remote",
    writeToken: Buffer.from(token).toString("base64url"),
  });
});

test("host frames translate to uplink frames relayed through the service", async () => {
  const { adapter, socket, service, ckey } = await startAdapter();
  socket.message(
    await sealJson(ckey, {
      t: "state",
      state: {
        isStreaming: true,
        cwd: "/tmp",
        model: { id: "opus", name: "Claude Opus 4.8", provider: "anthropic" },
        contextUsage: { percent: 5 },
      },
    }),
  );
  socket.message(
    await sealJson(ckey, {
      t: "ui-request",
      request: {
        reqId: 9,
        kind: "select",
        title: "OK?",
        options: ["yes", "no"],
      },
    }),
  );
  await adapter.settled();

  const state = service.emitted.find(
    (f): f is Extract<UplinkFrame, { t: "state" }> => f.t === "state",
  );
  expect(state?.model).toBe("Claude Opus 4.8");
  const interaction = service.emitted.find(
    (f): f is Extract<UplinkFrame, { t: "interaction" }> =>
      f.t === "interaction",
  );
  expect(interaction?.id).toBe("ui-9");
});

test("a downlink interaction reply is sealed back to the room as a ui-response", async () => {
  const { adapter, socket, service, ckey } = await startAdapter();
  socket.message(
    await sealJson(ckey, {
      t: "ui-request",
      request: {
        reqId: 9,
        kind: "select",
        title: "OK?",
        options: ["yes", "no"],
      },
    }),
  );
  await adapter.settled();

  service.downlink({
    t: "interactionReply",
    sessionId: META.id,
    id: "ui-9",
    response: { kind: "ask", answers: ["yes"] },
  });
  await adapter.settled();

  const opened = await Promise.all(
    socket.sent.map((bytes) => openEnvelope(ckey, bytes)),
  );
  expect(opened.find((f) => isTagged(f, "ui-response"))).toEqual({
    t: "ui-response",
    reqId: 9,
    value: "yes",
  });
  expect(opened.some((f) => isTagged(f, "hello"))).toBe(true); // the guest's first frame is always the handshake
});

test("a room close keeps the session registered while scheduling a rejoin", async () => {
  const { adapter, scheduler, service, socket } = await startAdapter();
  socket.close("room closed");
  await adapter.settled();

  expect(scheduler.timers).toHaveLength(1);
  expect(service.emitted.some((f) => f.t === "bye")).toBe(false);
  expect(service.closed).toBe(false);
});

test("Collab socket lifecycle diagnostics omit raw close reasons and room links", async () => {
  const diagnostics: AgentDiagnostic[] = [];
  const { adapter, socket } = await startAdapter((event) =>
    diagnostics.push(event),
  );
  socket.close("PRIVATE_CLOSE_REASON wss://relay.example/r/room#secret-token");
  await adapter.settled();

  expect(diagnostics).toEqual([
    {
      event: "collab_session_opened",
      sessionId: META.id,
    },
    {
      event: "collab_session_closed",
      sessionId: META.id,
      code: "transport-closed",
    },
  ]);
  expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_CLOSE_REASON");
  expect(JSON.stringify(diagnostics)).not.toContain("relay.example");
  expect(JSON.stringify(diagnostics)).not.toContain("secret-token");
});

function isTagged(value: unknown, tag: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "t" in value &&
    value.t === tag
  );
}
