/**
 * Minimal content-blind Collab relay (loopback prototype).
 *
 * Implements omp's Collab relay wire so a real omp host and our headless guest
 * can share a room fully locally — nothing leaves the machine, and the relay
 * never holds the room key: it only reads/rewrites the 4-byte plaintext peerId
 * header and routes the opaque sealed payload. This is the routing skeleton the
 * omp-remote aggregator (option A) must carry.
 *
 * Wire (pi-coding-agent@18.1.20 collab/{relay-client,protocol}.ts):
 *   connect      ws://<host>/r/<roomId>?role=host|guest, binaryType arraybuffer
 *   frame        [4B BE peerId][sealed]; guest->relay peerId 0 (relay rewrites to
 *                the sender's id); host->relay peerId 0 = broadcast, N = target guest N
 *   control      TEXT JSON, relay-originated only:
 *                  -> host  {"t":"peer-joined"|"peer-left","peer":N}
 *                  -> guest {"t":"room-closed"}
 *   fatal closes 4001 room closed, 4004 no such room, 4009 host conflict, 4029 full
 *
 * Usage: bun scripts/parity/collab-loopback-relay.ts [port]   (default 8791)
 */
import type { ServerWebSocket } from "bun";

const ENVELOPE_HEADER_LENGTH = 4;
const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

type Role = "host" | "guest";
interface SocketData {
  role: Role;
  roomId: string;
  peerId: number;
}
interface Room {
  host: ServerWebSocket<SocketData> | null;
  guests: Map<number, ServerWebSocket<SocketData>>;
  nextPeer: number;
}

const rooms = new Map<string, Room>();

function roomFor(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = { host: null, guests: new Map(), nextPeer: 1 };
    rooms.set(roomId, room);
  }
  return room;
}

function peerOf(buf: Uint8Array): number {
  return new DataView(
    buf.buffer,
    buf.byteOffset,
    ENVELOPE_HEADER_LENGTH,
  ).getUint32(0, false);
}

function setPeer(buf: Uint8Array, peerId: number): void {
  new DataView(buf.buffer, buf.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(
    0,
    peerId,
    false,
  );
}

const port = Number(process.argv[2] ?? 8791);

const server = Bun.serve<SocketData>({
  port,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const url = new URL(req.url);
    const match = ROOM_PATH_RE.exec(url.pathname);
    const role = url.searchParams.get("role");
    if (!match || (role !== "host" && role !== "guest")) {
      return new Response("expected /r/<roomId>?role=host|guest", {
        status: 404,
      });
    }
    if (srv.upgrade(req, { data: { role, roomId: match[1] ?? "", peerId: 0 } }))
      return undefined;
    return new Response("upgrade failed", { status: 500 });
  },
  websocket: {
    open(ws) {
      const room = roomFor(ws.data.roomId);
      if (ws.data.role === "host") {
        if (room.host) {
          ws.close(4009, "a host is already connected for this room");
          return;
        }
        room.host = ws;
        console.log(
          `[relay] host connected room=${ws.data.roomId} guests=${room.guests.size}`,
        );
        return;
      }
      const peerId = room.nextPeer++;
      ws.data.peerId = peerId;
      room.guests.set(peerId, ws);
      console.log(
        `[relay] guest ${peerId} joined room=${ws.data.roomId} host=${room.host !== null}`,
      );
      room.host?.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
    },
    message(ws, message) {
      if (typeof message === "string") return; // guests/hosts never send text control
      const room = rooms.get(ws.data.roomId);
      if (!room || message.byteLength < ENVELOPE_HEADER_LENGTH) return;
      if (ws.data.role === "guest") {
        setPeer(message, ws.data.peerId); // relay stamps the sender id for the host
        room.host?.send(message);
        return;
      }
      const target = peerOf(message);
      setPeer(message, 0); // guests always see frames as coming from the host (peer 0)
      if (target === 0) {
        for (const guest of room.guests.values()) guest.send(message);
      } else {
        room.guests.get(target)?.send(message);
      }
    },
    close(ws) {
      const room = rooms.get(ws.data.roomId);
      if (!room) return;
      if (ws.data.role === "host") {
        room.host = null;
        for (const guest of room.guests.values()) {
          guest.send(JSON.stringify({ t: "room-closed" }));
          guest.close(4001, "room closed");
        }
        console.log(
          `[relay] host left room=${ws.data.roomId}; closed ${room.guests.size} guest(s)`,
        );
        rooms.delete(ws.data.roomId);
        return;
      }
      room.guests.delete(ws.data.peerId);
      room.host?.send(JSON.stringify({ t: "peer-left", peer: ws.data.peerId }));
      console.log(
        `[relay] guest ${ws.data.peerId} left room=${ws.data.roomId}`,
      );
    },
  },
});

console.log(
  `[relay] listening on ws://127.0.0.1:${server.port}/r/<roomId>?role=host|guest`,
);
