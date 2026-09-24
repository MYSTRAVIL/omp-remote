import { expect, test } from "bun:test";
import {
  SealedChannel,
  type SessionKeys,
  clientSessionKeys,
  newIdentity,
  serverSessionKeys,
} from "@omp-remote/crypto";
import type { SealedFrame, SessionMeta } from "@omp-remote/protocol";

const enc = new TextEncoder();
const dec = new TextDecoder();

const meta: SessionMeta = {
  id: "s1",
  cwd: "/x/p",
  project: "p",
  model: "m",
  title: "T",
  pid: 3,
  startedAt: 0,
};

async function pair(): Promise<{ phone: SessionKeys; agent: SessionKeys }> {
  const phoneId = await newIdentity();
  const agentId = await newIdentity();
  return {
    phone: await clientSessionKeys(phoneId, agentId.publicKey),
    agent: await serverSessionKeys(agentId, phoneId.publicKey),
  };
}

/** Seal `frame` on a channel that never met the phone, returning the wire line. */
function sealLine(
  keys: SessionKeys,
  route: string,
  frame: SealedFrame,
): string {
  const captured: string[] = [];
  new SealedChannel(
    keys,
    { send: (b) => captured.push(dec.decode(b)), onBytes: () => {} },
    route,
    { role: "responder" },
  ).sendFrame(frame);
  const line = captured[0];
  if (line === undefined) throw new Error("nothing sealed");
  return line;
}

/**
 * A phone-side channel on route "m1" that has shaken hands with its paired
 * agent: the phone's hello reaches the agent and the agent's ack comes back, so
 * the phone opens what that agent seals from then on. Lines reach the phone only
 * through `decode`, as the relay hands them over.
 */
async function handshaken() {
  const { phone, agent } = await pair();
  let toAgent: ((b: Uint8Array) => void) | undefined;
  let toPhone: ((b: Uint8Array) => void) | undefined;
  const fromAgent: string[] = [];
  const phoneCh = new SealedChannel(
    phone,
    {
      send: (b) => toAgent?.(b),
      onBytes: (cb) => {
        toPhone = cb;
      },
    },
    "m1",
    { role: "initiator" },
  );
  const agentCh = new SealedChannel(
    agent,
    {
      send: (b) => fromAgent.push(dec.decode(b)),
      onBytes: (cb) => {
        toAgent = cb;
      },
    },
    "m1",
    { role: "responder" },
  );
  const decoded: SealedFrame[] = [];
  phoneCh.onFrame((f) => decoded.push(f));
  const feed = (lines: readonly string[]): void => {
    for (const line of lines) toPhone?.(enc.encode(line));
  };
  phoneCh.hello();
  feed(fromAgent.splice(0)); // the agent's ack
  return {
    /** Seal `frame` as the paired agent, returning the wire line. */
    seal(frame: SealedFrame): string {
      agentCh.sendFrame(frame);
      const line = fromAgent.pop();
      if (line === undefined) throw new Error("nothing sealed");
      return line;
    },
    /** Hand `lines` to the phone; return the frames it decoded from them. */
    decode(lines: readonly string[]): SealedFrame[] {
      const from = decoded.length;
      feed(lines);
      return decoded.slice(from);
    },
  };
}

test("a sealed sessions snapshot decodes back to the exact frame", async () => {
  const link = await handshaken();
  const frame: SealedFrame = { t: "sessions", sessions: [meta] };
  expect(link.decode([link.seal(frame)])).toEqual([frame]);
});

test("a line sealed with a different key is dropped, not decoded", async () => {
  const link = await handshaken();
  const foreign = await pair();
  const frame: SealedFrame = { t: "sessions", sessions: [meta] };
  const line = sealLine(foreign.agent, "m1", frame);
  expect(link.decode([line])).toEqual([]);
  // The phone still opens its own agent's lines.
  expect(link.decode([link.seal(frame)])).toEqual([frame]);
});

test("a tampered ciphertext fails authentication and is dropped", async () => {
  const link = await handshaken();
  const frame: SealedFrame = { t: "sessions", sessions: [meta] };
  const line = link.seal(frame);
  const wire = JSON.parse(line);
  wire.ct = `${wire.ct}00`;
  expect(link.decode([`${JSON.stringify(wire)}\n`])).toEqual([]);
  // Only the tampering dropped it: the untouched line still decodes.
  expect(link.decode([line])).toEqual([frame]);
});

test("non-envelope and non-JSON lines are ignored", async () => {
  const link = await handshaken();
  expect(link.decode(["not json", '{"hello":true}', "\n"])).toEqual([]);
});
