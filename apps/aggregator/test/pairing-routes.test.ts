import { afterEach, expect, test } from "bun:test";
import {
  hostCommitment,
  newIdentity,
  newPairingCode,
  phoneCommitment,
} from "@omp-remote/crypto";
import type { MachineStore } from "../src/machine-store";
import { PairingBroker } from "../src/pairing";
import { AggregatorServer } from "../src/server";
import { dialAgent } from "./helpers/agent-socket";
import { tempMachineStore } from "./helpers/machines";

let server: AggregatorServer | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
});

let machines: MachineStore;

/** Start an ungated aggregator with a pairing broker; return its HTTP base URL. */
async function start(
  opts: { trustProxy?: boolean; pairing?: PairingBroker } = {},
): Promise<string> {
  machines = await tempMachineStore();
  server = new AggregatorServer({
    machines,
    port: 0,
    pairing: opts.pairing ?? new PairingBroker(),
    trustProxy: opts.trustProxy,
  });
  server.start();
  return `http://127.0.0.1:${server.boundPort}`;
}

/** Whether an `/agent` upgrade presenting `token` opens. */
function agentOpens(http: string, token: string): Promise<boolean> {
  const ws = dialAgent(http.replace(/^http/, "ws"), token);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  ws.addEventListener("open", () => {
    resolve(true);
    ws.close();
  });
  ws.addEventListener("error", () => resolve(false));
  ws.addEventListener("close", () => resolve(false));
  return promise;
}

function post(
  http: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${http}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Resolve with the first control line of `type` that `ws` receives. */
function nextControl(ws: WebSocket, type: string): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  ws.addEventListener("message", (e) => {
    const msg: unknown = JSON.parse(String(e.data));
    if (
      typeof msg === "object" &&
      msg !== null &&
      "type" in msg &&
      msg.type === type
    )
      resolve(msg);
  });
  return promise;
}

/** Build both sides of a real ceremony that share a code-derived rendezvousId. */
async function ceremony(machineId = "mach-1"): Promise<{
  machineId: string;
  hostPub: string;
  hostMac: string;
  phonePub: string;
  phoneMac: string;
  rendezvousId: string;
}> {
  const code = await newPairingCode();
  const host = await newIdentity();
  const phone = await newIdentity();
  const hostC = await hostCommitment(code, machineId, host.publicKey);
  const phoneC = await phoneCommitment(code, phone.publicKey);
  expect(phoneC.rendezvousId).toBe(hostC.rendezvousId);
  return {
    machineId,
    hostPub: host.publicKey,
    hostMac: hostC.mac,
    phonePub: phone.publicKey,
    phoneMac: phoneC.mac,
    rendezvousId: hostC.rendezvousId,
  };
}

test("the brokered pairing ceremony round-trips over HTTP with no bearer, and the claim issues the machine's /agent token", async () => {
  const http = await start();
  const c = await ceremony();

  const reg = await post(http, "/pair/host", {
    machineId: c.machineId,
    rendezvousId: c.rendezvousId,
    hostPub: c.hostPub,
    hostMac: c.hostMac,
  });
  expect(reg.status).toBe(200);
  const regBody = await reg.json();
  expect(typeof regBody.expiresAt).toBe("number");
  expect(regBody.expiresAt).toBeGreaterThan(Date.now());

  // Nothing to collect before the phone claims.
  const early = await post(http, "/pair/result", {
    rendezvousId: c.rendezvousId,
  });
  expect(await early.json()).toEqual({ status: "pending" });

  // The phone claims (ungated: no auth gate configured) on the shared rendezvous.
  const claim = await post(http, "/pair/claim", {
    rendezvousId: c.rendezvousId,
    phonePub: c.phonePub,
    phoneMac: c.phoneMac,
  });
  expect(claim.status).toBe(200);
  expect(await claim.json()).toEqual({
    machineId: c.machineId,
    hostPub: c.hostPub,
    hostMac: c.hostMac,
  });

  // The host polls the result and receives the phone side and its token exactly once.
  const first = await post(http, "/pair/result", {
    rendezvousId: c.rendezvousId,
  });
  expect(first.status).toBe(200);
  const result = await first.json();
  expect(result).toEqual({
    status: "claimed",
    phonePub: c.phonePub,
    phoneMac: c.phoneMac,
    agentToken: expect.any(String),
  });

  const second = await post(http, "/pair/result", {
    rendezvousId: c.rendezvousId,
  });
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ status: "pending" });

  // The token authenticates /agent for exactly that machine.
  expect(machines.authenticate(result.agentToken)).toBe(c.machineId);
  expect(await agentOpens(http, result.agentToken)).toBe(true);
  const agent = dialAgent(http.replace(/^http/, "ws"), result.agentToken);
  const refused = nextControl(agent, "error");
  agent.addEventListener("open", () =>
    agent.send(JSON.stringify({ type: "register", machineId: "other" })),
  );
  expect(await refused).toEqual({ type: "error", reason: "unauthorized" });
});

test("/agent with an unknown token is a 401", async () => {
  const http = await start();
  const res = await fetch(`${http}/agent`, {
    headers: { authorization: "Bearer not-a-machine-token" },
  });
  expect(res.status).toBe(401);
  await res.text();
});

/**
 * Run a whole ceremony for `machineId` — register (presenting `bearer` when
 * given), claim, collect — and return the claim's response, the host's first
 * `/pair/result` body, the token it carried if any, and a `poll` for more.
 */
async function pairOnce(
  http: string,
  machineId: string,
  bearer?: string,
): Promise<{
  claim: Response;
  result: unknown;
  agentToken: string | undefined;
  poll: () => Promise<unknown>;
}> {
  const c = await ceremony(machineId);
  const reg = await post(
    http,
    "/pair/host",
    {
      machineId,
      rendezvousId: c.rendezvousId,
      hostPub: c.hostPub,
      hostMac: c.hostMac,
    },
    bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
  );
  expect(reg.status).toBe(200);
  const claim = await post(http, "/pair/claim", {
    rendezvousId: c.rendezvousId,
    phonePub: c.phonePub,
    phoneMac: c.phoneMac,
  });
  const poll = async (): Promise<unknown> =>
    (await post(http, "/pair/result", { rendezvousId: c.rendezvousId })).json();
  const result = await poll();
  const agentToken =
    typeof result === "object" &&
    result !== null &&
    "agentToken" in result &&
    typeof result.agentToken === "string"
      ? result.agentToken
      : undefined;
  return { claim, result, agentToken, poll };
}

test("a re-pair that presents the machine's current token replaces it and closes the old token's socket", async () => {
  const http = await start();
  const first = (await pairOnce(http, "mach-1")).agentToken ?? "";
  const old = dialAgent(http.replace(/^http/, "ws"), first);
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  old.addEventListener("open", () => opened.resolve());
  old.addEventListener("close", (e) =>
    closed.resolve({ code: e.code, reason: e.reason }),
  );
  await opened.promise;

  const { claim, agentToken: second } = await pairOnce(http, "mach-1", first);
  expect(claim.status).toBe(200);
  expect(machines.authenticate(first)).toBeUndefined();
  expect(machines.authenticate(second ?? "")).toBe("mach-1");
  expect(await closed.promise).toEqual({
    code: 4403,
    reason: "token replaced",
  });
});

test("a claim that would replace an existing machine's token without its current bearer is a 409, and the host learns it was refused, once", async () => {
  const http = await start();
  const first = (await pairOnce(http, "mach-1")).agentToken ?? "";
  const other = (await pairOnce(http, "mach-2")).agentToken ?? "";
  // No bearer, a made-up one, and another machine's token: none renews mach-1.
  for (const bearer of [undefined, "not-a-token", other]) {
    const { claim, result, poll } = await pairOnce(http, "mach-1", bearer);
    expect(claim.status).toBe(409);
    expect(await claim.json()).toEqual({
      error: "machine-exists",
      machineId: "mach-1",
    });
    // The host's poll ends at once instead of waiting out its timeout.
    expect(result).toEqual({ status: "refused", reason: "machine-exists" });
    expect(await poll()).toEqual({ status: "pending" });
  }
  expect(machines.authenticate(first)).toBe("mach-1");
  // A revoked machine no longer exists: pairing it again needs no bearer.
  await machines.revoke("mach-1");
  const again = await pairOnce(http, "mach-1");
  expect(again.claim.status).toBe(200);
  expect(machines.authenticate(again.agentToken ?? "")).toBe("mach-1");
});

test("the pairing routes refuse an oversized body (413) or a field longer than 32 bytes (400)", async () => {
  const http = await start();
  const c = await ceremony("mach-1");
  const body = {
    machineId: "mach-1",
    rendezvousId: c.rendezvousId,
    hostPub: c.hostPub,
    hostMac: c.hostMac,
  };
  const huge = await post(http, "/pair/host", {
    ...body,
    hostPub: "A".repeat(128 * 1024),
  });
  expect(huge.status).toBe(413);
  await huge.text();
  const long = await post(http, "/pair/host", {
    ...body,
    hostPub: `${c.hostPub}A`,
  });
  expect(long.status).toBe(400);
  expect((await post(http, "/pair/host", body)).status).toBe(200);
});

test("each client holds at most four pending pairings; a fifth displaces its own oldest, never another client's", async () => {
  const http = await start({
    trustProxy: true,
    pairing: new PairingBroker({ maxPending: 6 }),
  });
  const from = (ip: string) => ({ "x-real-ip": ip });
  const register = async (ip: string): Promise<string> => {
    const c = await ceremony("mach-1");
    const res = await post(
      http,
      "/pair/host",
      {
        machineId: "mach-1",
        rendezvousId: c.rendezvousId,
        hostPub: c.hostPub,
        hostMac: c.hostMac,
      },
      from(ip),
    );
    expect(res.status).toBe(200);
    return c.rendezvousId;
  };
  const claimable = async (rendezvousId: string): Promise<boolean> => {
    const c = await ceremony("mach-1");
    const res = await post(http, "/pair/claim", {
      rendezvousId,
      phonePub: c.phonePub,
      phoneMac: c.phoneMac,
    });
    await res.text();
    return res.status !== 404;
  };
  const victim = await register("198.51.100.7");
  const flood: string[] = [];
  for (let i = 0; i < 20; i++) flood.push(await register("203.0.113.9"));
  // The flooder kept only its newest four; the victim's pairing survives.
  expect(await claimable(victim)).toBe(true);
  expect(await claimable(flood[15] ?? "")).toBe(false);
  expect(await claimable(flood[16] ?? "")).toBe(true);
});

test("/pair/host 400s a malformed body or a machineId no token can hold", async () => {
  const http = await start();
  // Missing required fields → the Zod parse rejects it.
  expect((await post(http, "/pair/host", { machineId: "m" })).status).toBe(400);
  expect(
    (
      await post(http, "/pair/host", {
        machineId: "has space",
        rendezvousId: "rv",
        hostPub: "hp",
        hostMac: "hm",
      })
    ).status,
  ).toBe(400);
  // Non-JSON bytes are swallowed into a 400, never a thrown 500.
  const notJson = await fetch(`${http}/pair/host`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ not json",
  });
  expect(notJson.status).toBe(400);
});

test("/pair/claim on an unknown rendezvous is a 404", async () => {
  const http = await start();
  const c = await ceremony("mach-1");
  const claim = await post(http, "/pair/claim", {
    rendezvousId: c.rendezvousId,
    phonePub: c.phonePub,
    phoneMac: c.phoneMac,
  });
  expect(claim.status).toBe(404);
});

test("a non-POST method on a pairing route is a 405", async () => {
  const http = await start();
  const res = await fetch(`${http}/pair/host`, { method: "GET" });
  expect(res.status).toBe(405);
});
