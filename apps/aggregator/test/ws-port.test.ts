import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { type SocketData, WsPort } from "../src/server";

/** A socket whose unsent backlog is `buffered` bytes until `drain()` empties it. */
function fakeWs(buffered: number) {
  let backlog = buffered;
  const sent: (string | Uint8Array)[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const ws = {
    getBufferedAmount: () => backlog,
    send: (data: string | Uint8Array) => void sent.push(data),
    close: (code?: number, reason?: string) =>
      void closes.push({ code, reason }),
  };
  return {
    // Only the three members WsPort touches exist on the fake.
    ws: ws as unknown as ServerWebSocket<SocketData>,
    sent,
    closes,
    drain: () => {
      backlog = 0;
    },
  };
}

const BACKPRESSURE = { code: 1013, reason: "backpressure" };

test("a port under the buffer cap sends text and binary frames", () => {
  const { ws, sent, closes } = fakeWs(512);
  const port = new WsPort("p", ws, 1024);
  const bytes = new Uint8Array([1]);
  port.send("line");
  port.sendBinary(bytes);
  expect(sent).toEqual(["line", bytes]);
  expect(closes).toEqual([]);
});

test("a phone port over the buffer cap closes with 1013 and sends nothing", () => {
  const phone = fakeWs(2048);
  new WsPort("phone", phone.ws, 1024).send("line");
  expect(phone.sent).toEqual([]);
  expect(phone.closes).toEqual([BACKPRESSURE]);

  // A collab peer's binary frames take the same close.
  const collab = fakeWs(2048);
  new WsPort("collab", collab.ws, 1024).sendBinary(new Uint8Array([1]));
  expect(collab.sent).toEqual([]);
  expect(collab.closes).toEqual([BACKPRESSURE]);
});

test("a closed port sends nothing and closes only once, even after its buffer drains", () => {
  const overflowed = fakeWs(2048);
  const port = new WsPort("p", overflowed.ws, 1024);
  port.send("first");
  overflowed.drain();
  port.send("late");
  port.sendBinary(new Uint8Array([1]));
  port.close();
  expect(overflowed.sent).toEqual([]);
  expect(overflowed.closes).toEqual([BACKPRESSURE]);

  // A port the relay closed (a superseded agent, a closed room) is as final.
  const superseded = fakeWs(0);
  const closed = new WsPort("q", superseded.ws, 1024);
  closed.close();
  closed.send("late");
  expect(superseded.sent).toEqual([]);
  expect(superseded.closes).toEqual([{ code: undefined, reason: undefined }]);
});
