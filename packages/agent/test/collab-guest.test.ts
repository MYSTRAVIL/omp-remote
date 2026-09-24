import { expect, test } from "bun:test";
import {
  type CollabCloseCode,
  CollabGuest,
  type GuestSocket,
} from "../src/collab/guest";

/** A control link for a fresh random room key + write token. */
function controlLink(): { link: string; key: Uint8Array<ArrayBuffer> } {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const secret = new Uint8Array(48);
  secret.set(key, 0);
  secret.set(crypto.getRandomValues(new Uint8Array(16)), 32);
  const roomId = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("base64url");
  return {
    link: `${roomId}.${Buffer.from(secret).toString("base64url")}`,
    key,
  };
}

async function openEnvelope(
  raw: Uint8Array<ArrayBuffer>,
  env: Uint8Array,
): Promise<unknown> {
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "decrypt",
  ]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: env.slice(4, 16) },
    key,
    env.slice(16),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

/** Behaves like a real WebSocket: `send` throws until the socket is open. */
function strictSocket() {
  let isOpen = false;
  let failSends = false;
  let onOpen: (() => void) | undefined;
  const sent: Uint8Array[] = [];
  const socket: GuestSocket = {
    send: (data) => {
      if (!isOpen || failSends)
        throw new Error("InvalidStateError: socket not open");
      sent.push(data);
    },
    close: () => {
      isOpen = false;
    },
    onOpen: (cb) => {
      onOpen = cb;
    },
    onClose: () => {},
    onMessage: () => {},
    onError: () => {},
  };
  return {
    socket,
    sent,
    open: () => {
      isOpen = true;
      onOpen?.();
    },
    breakSends: () => {
      failSends = true;
    },
  };
}

test("a frame sent while the socket is connecting goes out after hello", async () => {
  const { link, key } = controlLink();
  const fake = strictSocket();
  const guest = new CollabGuest({ link, socketFactory: () => fake.socket });
  await guest.start();

  guest.send({ t: "abort" });
  fake.open();
  await guest.settled();

  const frames = await Promise.all(fake.sent.map((b) => openEnvelope(key, b)));
  expect(frames).toEqual([
    expect.objectContaining({ t: "hello" }),
    { t: "abort" },
  ]);
});

test("a socket that refuses a send closes the guest instead of rejecting", async () => {
  const { link } = controlLink();
  const fake = strictSocket();
  const guest = new CollabGuest({ link, socketFactory: () => fake.socket });
  const closed = Promise.withResolvers<CollabCloseCode>();
  guest.onClose = (code) => closed.resolve(code);
  await guest.start();
  fake.open();
  await guest.settled();

  fake.breakSends();
  guest.send({ t: "abort" });

  expect(await closed.promise).toBe("transport-closed");
  await guest.settled();
  guest.send({ t: "abort" }); // after close: dropped, not thrown
  await guest.settled();
  expect(fake.sent).toHaveLength(1); // only the hello
});
