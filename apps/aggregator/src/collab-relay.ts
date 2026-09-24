/**
 * The Collab relay mode of the aggregator (spec "Architecture C", option A).
 *
 * omp's Collab protocol frames a message as `[4B big-endian peerId][sealed]`.
 * This relay reads and rewrites ONLY that 4-byte routing header and forwards the
 * sealed payload VERBATIM — it never decrypts, parses, or logs content, so it is
 * as content-blind as {@link BlindRouter}. It lets omp sessions host their Collab
 * rooms on our own aggregator instead of `my.omp.sh`.
 *
 * Routing (mirrors pi-coding-agent@18.1.20 collab/relay-client.ts + protocol.ts):
 *   guest -> relay : peerId is always 0; the relay stamps it to the sender's id
 *                    before forwarding to the host, so the host knows who spoke.
 *   host  -> relay : peerId 0 broadcasts to every guest; peerId N targets guest N.
 *                    Delivered to guests stamped 0 (the host is always peer 0).
 *   control (TEXT JSON, relay-originated): -> host {peer-joined|peer-left,peer};
 *                    -> guest {room-closed}.
 *
 * Host replacement: a host joining a room that already has one EVICTS the old
 * host (closed 1012, non-fatal, so omp would reconnect) and tears the room down
 * as if the old host had left. Room ids are random per omp host, so a second
 * host is the same process reconnecting after its old socket went half-open;
 * rejecting it with 4009 (fatal in omp) would end hosting for good. Every
 * route/leave is identity-checked against the sending port, so late frames or
 * closes from evicted sockets never touch the new room.
 */

/** `[4B uint32 BE peerId]` header; from `@oh-my-pi/pi-wire` ENVELOPE_HEADER_LENGTH. */
const PEER_HEADER = 4;
const CLOSE_HOST_REPLACED = 1012;
const CLOSE_ROOM_CLOSED = 4001;

export type CollabRole = "host" | "guest";

/** A connected Collab peer, abstracted from the transport (a WS in production). */
export interface CollabPort {
  readonly id: string;
  /** Forward an opaque sealed frame (the relay only touches its 4-byte header). */
  sendBinary(data: Uint8Array): void;
  /** Send a clear relay-control message (never session data). */
  sendText(text: string): void;
  close(code?: number, reason?: string): void;
}

interface CollabRoom {
  host: CollabPort | null;
  guests: Map<number, CollabPort>;
  nextPeer: number;
}

function readPeer(data: Uint8Array): number {
  return new DataView(data.buffer, data.byteOffset, PEER_HEADER).getUint32(
    0,
    false,
  );
}

function writePeer(data: Uint8Array, peerId: number): void {
  new DataView(data.buffer, data.byteOffset, PEER_HEADER).setUint32(
    0,
    peerId,
    false,
  );
}

export class CollabRelay {
  readonly #rooms = new Map<string, CollabRoom>();

  /** Live room count (tests/metrics). */
  get roomCount(): number {
    return this.#rooms.size;
  }

  #room(roomId: string): CollabRoom {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = { host: null, guests: new Map(), nextPeer: 1 };
      this.#rooms.set(roomId, room);
    }
    return room;
  }

  /** Admit a peer to a room. Returns its peerId (guests get 1,2,…; the host is 0). */
  join(port: CollabPort, roomId: string, role: CollabRole): number {
    if (role === "host") {
      const stale = this.#rooms.get(roomId)?.host;
      if (stale) {
        this.#closeRoom(roomId);
        stale.close(CLOSE_HOST_REPLACED, "host replaced");
      }
      this.#room(roomId).host = port;
      return 0;
    }
    const room = this.#room(roomId);
    const peerId = room.nextPeer++;
    room.guests.set(peerId, port);
    room.host?.sendText(JSON.stringify({ t: "peer-joined", peer: peerId }));
    return peerId;
  }

  /** True when `port` is the room's current occupant of `role`/`peerId`. */
  #isCurrent(
    room: CollabRoom,
    port: CollabPort,
    role: CollabRole,
    peerId: number,
  ): boolean {
    return role === "host"
      ? room.host === port
      : room.guests.get(peerId) === port;
  }

  /** Route one opaque frame from `role`/`peerId`, rewriting only its peerId header. */
  routeBinary(
    port: CollabPort,
    roomId: string,
    role: CollabRole,
    peerId: number,
    data: Uint8Array,
  ): void {
    const room = this.#rooms.get(roomId);
    if (!room || data.byteLength < PEER_HEADER) return;
    if (!this.#isCurrent(room, port, role, peerId)) return;
    if (role === "guest") {
      writePeer(data, peerId);
      room.host?.sendBinary(data);
      return;
    }
    const target = readPeer(data);
    writePeer(data, 0);
    if (target === 0) {
      for (const guest of room.guests.values()) guest.sendBinary(data);
      return;
    }
    room.guests.get(target)?.sendBinary(data);
  }

  /** Detach a peer. A host leaving closes every guest with `room-closed`. */
  leave(
    port: CollabPort,
    roomId: string,
    role: CollabRole,
    peerId: number,
  ): void {
    const room = this.#rooms.get(roomId);
    if (!room || !this.#isCurrent(room, port, role, peerId)) return;
    if (role === "host") {
      this.#closeRoom(roomId);
      return;
    }
    room.guests.delete(peerId);
    room.host?.sendText(JSON.stringify({ t: "peer-left", peer: peerId }));
    if (!room.host && room.guests.size === 0) this.#rooms.delete(roomId);
  }

  /** Close every guest with `room-closed` and forget the room. */
  #closeRoom(roomId: string): void {
    const room = this.#rooms.get(roomId);
    if (!room) return;
    this.#rooms.delete(roomId);
    for (const guest of room.guests.values()) {
      guest.sendText(JSON.stringify({ t: "room-closed" }));
      guest.close(CLOSE_ROOM_CLOSED, "room closed");
    }
  }
}
