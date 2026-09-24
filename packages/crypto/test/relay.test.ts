import { expect, test } from "bun:test";
import type { SealedFrame } from "@omp-remote/protocol";
import {
  BlindRelay,
  SealedChannel,
  clientSessionKeys,
  newIdentity,
  serverSessionKeys,
} from "../src/index";

const dec = new TextDecoder();

test("full loop through a blind relay preserves order; relay cannot read frames", async () => {
  const clientId = await newIdentity();
  const serverId = await newIdentity();
  const ck = await clientSessionKeys(clientId, serverId.publicKey);
  const sk = await serverSessionKeys(serverId, clientId.publicKey);

  const relay = new BlindRelay();
  const client = new SealedChannel(ck, relay.endpoint("route-A"), "route-A", {
    role: "initiator",
  });
  const server = new SealedChannel(sk, relay.endpoint("route-A"), "route-A", {
    role: "responder",
  });

  const received: SealedFrame[] = [];
  server.onFrame((f) => received.push(f));

  const prompt: SealedFrame = {
    t: "prompt",
    sessionId: "s1",
    text: "do the thing",
    mode: "followUp",
  };
  const interrupt: SealedFrame = { t: "interrupt", sessionId: "s1" };
  client.hello();
  client.sendFrame(prompt);
  client.sendFrame(interrupt);

  expect(received).toEqual([prompt, interrupt]);

  for (const bytes of relay.observed) {
    const wire = JSON.parse(dec.decode(bytes).trim());
    expect(wire.t).toBeUndefined();
    expect(wire.route).toBe("route-A");
  }
});
