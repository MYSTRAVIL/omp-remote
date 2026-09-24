import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/credential-store";
import { type FetchFn, PushService } from "../src/push";
import { PushSubscriptionStore } from "../src/push-store";
import { AggregatorServer } from "../src/server";
import { signSessionToken } from "../src/session-token";
import { MAX_PUSH_KEY_LENGTH, type VapidKeys } from "../src/vapid";
import { WebAuthnGate } from "../src/webauthn";
import { dialAgent } from "./helpers/agent-socket";
import { tempMachineStore } from "./helpers/machines";
import { writeCheapPassword } from "./helpers/password";
import { VirtualAuthenticator } from "./helpers/virtual-authenticator";
import { decryptPushBody, makeSubscriber } from "./helpers/webpush-receiver";

const machines = await tempMachineStore();
const M1_TOKEN = await machines.issue("m1", 0);

let server: AggregatorServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  server?.stop();
  server = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const SECRET = "push-server-test-secret-0123456789";

async function makeKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x ?? "", "base64url"),
    Buffer.from(pub.y ?? "", "base64url"),
  ]);
  return {
    publicKey: point.toString("base64url"),
    privateKey: priv.d ?? "",
    subject: "mailto:me@example.com",
  };
}

const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/e2e",
  keys: { p256dh: "cGtleQ", auth: "YXV0aA" },
};

async function tempPath(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A push service whose fetch records calls and resolves a promise on the first hit. */
async function pushHarness(): Promise<{
  push: PushService;
  calls: string[];
  firstCall: Promise<void>;
}> {
  const store = await PushSubscriptionStore.load(
    join(await tempPath("omp-pushE2E-"), "subs.json"),
  );
  const calls: string[] = [];
  const { promise: firstCall, resolve } = Promise.withResolvers<void>();
  const fetchFn: FetchFn = async (url) => {
    calls.push(url);
    resolve();
    return { status: 201 };
  };
  const push = new PushService({
    keys: await makeKeys(),
    store,
    fetch: fetchFn,
  });
  return { push, calls, firstCall };
}

function wsOpen(ws: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  ws.addEventListener("open", () => resolve(), { once: true });
  return promise;
}

test("GET /push/vapid returns the app-server public key", async () => {
  const { push } = await pushHarness();
  server = new AggregatorServer({ machines, port: 0, push });
  server.start();
  const http = `http://127.0.0.1:${server.boundPort}`;

  const res = await fetch(`${http}/push/vapid`);
  expect(res.status).toBe(200);
  expect((await res.json()).publicKey).toBe(push.vapidPublicKey());
});

test("a registered agent's attention control fans a push; a client's does not", async () => {
  const { push, calls, firstCall } = await pushHarness();
  server = new AggregatorServer({ machines, port: 0, push });
  server.start();
  const base = `ws://127.0.0.1:${server.boundPort}`;
  const http = `http://127.0.0.1:${server.boundPort}`;

  // Enrol a device subscription over HTTP (no auth gate configured → open).
  const subRes = await fetch(`${http}/push/subscription`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(SUB),
  });
  expect(subRes.status).toBe(204);

  // A CLIENT sending attention must be ignored (only registered agents trigger).
  const clientWs = new WebSocket(`${base}/client`);
  await wsOpen(clientWs);
  clientWs.send(JSON.stringify({ type: "attention" }));

  // An AGENT (bearer-authenticated at upgrade) registers, then sends attention
  // → the push fans out.
  const agentWs = dialAgent(base, M1_TOKEN);
  await wsOpen(agentWs);
  agentWs.send(JSON.stringify({ type: "register", machineId: "m1" }));
  agentWs.send(JSON.stringify({ type: "attention" }));

  await firstCall;
  expect(calls).toEqual([SUB.endpoint]);
});

test("an agent's attention notice reaches the push service RFC 8291-encrypted, byte for byte", async () => {
  const store = await PushSubscriptionStore.load(
    join(await tempPath("omp-pushNotice-"), "subs.json"),
  );
  const sent = Promise.withResolvers<Uint8Array | undefined>();
  const fetchFn: FetchFn = async (_url, init) => {
    sent.resolve(init.body);
    return { status: 201 };
  };
  const push = new PushService({
    keys: await makeKeys(),
    store,
    fetch: fetchFn,
  });
  server = new AggregatorServer({ machines, port: 0, push });
  server.start();
  const device = await makeSubscriber();
  const subRes = await fetch(
    `http://127.0.0.1:${server.boundPort}/push/subscription`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: SUB.endpoint, keys: device.keys }),
    },
  );
  expect(subRes.status).toBe(204);

  const agentWs = dialAgent(`ws://127.0.0.1:${server.boundPort}`, M1_TOKEN);
  await wsOpen(agentWs);
  agentWs.send(JSON.stringify({ type: "register", machineId: "m1" }));
  const notice = JSON.stringify({ v: 1, m: "m1", n: "aXY", ct: "c2VhbGVk" });
  agentWs.send(JSON.stringify({ type: "attention", notice }));

  const body = await sent.promise;
  if (body === undefined) throw new Error("expected an encrypted push body");
  expect(
    new TextDecoder().decode(
      await decryptPushBody(body, device.pair, device.auth),
    ),
  ).toBe(notice);
});

test("POST /push/subscription requires a valid session token when the gate is on", async () => {
  const { push } = await pushHarness();
  const dir = await tempPath("omp-pushcred-");
  const store = await CredentialStore.load(join(dir, "cred.json"));
  const gate = new WebAuthnGate(
    {
      publicUrl: "https://example.test",
      rpName: "omp-remote test",
      sessionSecret: SECRET,
      sessionTtlSec: 3600,
      rememberTtlSec: 2_592_000,
      passwordPath: join(dir, "password.json"),
    },
    store,
  );
  server = new AggregatorServer({
    machines,
    port: 0,
    auth: gate,
    push,
  });
  server.start();
  const http = `http://127.0.0.1:${server.boundPort}`;

  // No token → 401, nothing stored.
  const noTok = await fetch(`${http}/push/subscription`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(SUB),
  });
  expect(noTok.status).toBe(401);

  // A forged token → 401.
  const bad = await fetch(`${http}/push/subscription`, {
    method: "POST",
    headers: {
      authorization: "Bearer not.a.token",
      "content-type": "application/json",
    },
    body: JSON.stringify(SUB),
  });
  expect(bad.status).toBe(401);

  // A valid token (for a registered passkey, current epoch) → 204.
  await store.add({ id: "u", publicKey: "AA", counter: 0 });
  const token = signSessionToken(
    { sub: "u", uv: true, ep: 0, m: "pk" },
    SECRET,
    {
      now: Date.now(),
      ttlSec: 3600,
    },
  );
  const ok = await fetch(`${http}/push/subscription`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(SUB),
  });
  expect(ok.status).toBe(204);
});

test("a malformed subscription body is rejected with 400", async () => {
  const { push } = await pushHarness();
  server = new AggregatorServer({ machines, port: 0, push });
  server.start();
  const http = `http://127.0.0.1:${server.boundPort}`;

  const res = await fetch(`${http}/push/subscription`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "not-a-url" }),
  });
  expect(res.status).toBe(400);
});

test("a new subscription off the allowlist is a 400 that stores nothing, while a stored one is still pushed to", async () => {
  const path = join(await tempPath("omp-push-allowlist-"), "subs.json");
  // Stored before the allowlist existed, on a push service it does not admit.
  const stored = {
    endpoint: "https://push.example.net/wpush/v1/stored",
    keys: SUB.keys,
  };
  await (await PushSubscriptionStore.load(path)).add(stored);
  // A restart after the upgrade reloads it.
  const store = await PushSubscriptionStore.load(path);
  const calls: string[] = [];
  const push = new PushService({
    keys: await makeKeys(),
    store,
    fetch: async (url) => {
      calls.push(url);
      return { status: 201 };
    },
  });
  server = new AggregatorServer({ machines, port: 0, push });
  server.start();
  const http = `http://127.0.0.1:${server.boundPort}`;
  const post = async (body: unknown): Promise<number> => {
    const res = await fetch(`${http}/push/subscription`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status;
  };

  const refused = [
    { ...SUB, endpoint: "https://attacker.example/push" },
    { ...SUB, endpoint: "http://fcm.googleapis.com/fcm/send/e2e" },
    { ...SUB, endpoint: "https://evilpush.apple.com.attacker.net/abc" },
    {
      ...SUB,
      keys: { ...SUB.keys, p256dh: "A".repeat(MAX_PUSH_KEY_LENGTH + 1) },
    },
  ];
  const statuses: number[] = [];
  for (const body of refused) statuses.push(await post(body));
  expect(statuses).toEqual(refused.map(() => 400));
  expect(store.list()).toEqual([stored]);
  expect((await PushSubscriptionStore.load(path)).list()).toEqual([stored]);

  // A push service on the allowlist still enrols beside the stored one.
  const fresh = {
    endpoint: "https://updates.push.services.mozilla.com/wpush/v2/fresh",
    keys: SUB.keys,
  };
  expect(await post(fresh)).toBe(204);
  await push.notifyAll();
  expect(calls).toEqual([stored.endpoint, fresh.endpoint]);
});

test("sign out everywhere retires every push subscription made before it and wakes none of them; a revoke, and a restart after the upgrade, keep them", async () => {
  const path = join(await tempPath("omp-push-epoch-"), "subs.json");
  // Stored before subscriptions carried an epoch; reloaded by the upgraded relay.
  const legacy = {
    endpoint: "https://web.push.apple.com/legacy",
    keys: SUB.keys,
  };
  await (await PushSubscriptionStore.load(path)).add(legacy);
  const subs = await PushSubscriptionStore.load(path);
  const calls: string[] = [];
  let fannedOut = Promise.withResolvers<void>();
  let expected = 0;
  const push = new PushService({
    keys: await makeKeys(),
    store: subs,
    fetch: async (url) => {
      calls.push(url);
      if (calls.length === expected) fannedOut.resolve();
      return { status: 201 };
    },
  });
  const dir = await tempPath("omp-push-cred-");
  const credentials = await CredentialStore.load(join(dir, "cred.json"));
  const rp = { rpID: "example.test", origin: "https://example.test" };
  const password = "push-server-test-password";
  const passwordPath = join(dir, "password.json");
  await writeCheapPassword(passwordPath, password, 0);
  const gate = new WebAuthnGate(
    {
      publicUrl: rp.origin,
      rpName: "omp-remote test",
      sessionSecret: SECRET,
      sessionTtlSec: 3600,
      rememberTtlSec: 2_592_000,
      passwordPath,
    },
    credentials,
  );
  // Passkeys are added from a password session, behind a password step-up.
  const signedIn = await gate.passwordLogin(password, false, "192.0.2.1");
  if (!signedIn.ok) throw new Error(signedIn.reason);
  const session = await gate.verifySessionToken(signedIn.token);
  if (session === undefined) throw new Error("password session refused");
  const a = new VirtualAuthenticator(rp.rpID, rp.origin);
  const b = new VirtualAuthenticator(rp.rpID, rp.origin);
  for (const auth of [a, b]) {
    const reg = await gate.registrationOptions({
      session,
      stepUp: { password },
      client: "192.0.2.1",
    });
    if (!reg.ok) throw new Error(reg.reason);
    await gate.verifyRegistration(reg.flowId, auth.register(reg.options));
  }
  const idB = credentials.list()[1]?.id ?? "";
  server = new AggregatorServer({
    machines,
    port: 0,
    auth: gate,
    push,
  });
  server.start();
  const http = `http://127.0.0.1:${server.boundPort}`;
  const post = (path: string, token: string, body: unknown) =>
    fetch(`${http}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const login = async (): Promise<string> => {
    const minted = await gate.authenticationOptions("192.0.2.1");
    if (minted === undefined) throw new Error("login refused");
    const res = await gate.verifyAuthentication(
      minted.flowId,
      a.authenticate(minted.options),
    );
    return res.token ?? "";
  };
  const stepUp = async (token: string, action: object) => {
    const { flowId, options } = await (
      await post("/auth/account/challenge", token, action)
    ).json();
    return { flowId, response: a.authenticate(options) };
  };
  const agent = dialAgent(`ws://127.0.0.1:${server.boundPort}`, M1_TOKEN);
  await wsOpen(agent);
  agent.send(JSON.stringify({ type: "register", machineId: "m1" }));
  /** An agent's attention, resolved once `count` more pushes went out. */
  const attention = async (count: number): Promise<void> => {
    fannedOut = Promise.withResolvers<void>();
    expected = calls.length + count;
    agent.send(JSON.stringify({ type: "attention" }));
    await fannedOut.promise;
  };

  const token = await login();
  expect((await post("/push/subscription", token, SUB)).status).toBe(204);
  await attention(2);
  expect(calls).toEqual([legacy.endpoint, SUB.endpoint]);

  // Another path — revoking a passkey — leaves every subscription be.
  const revoked = await post("/auth/account/passkeys/revoke", token, {
    credentialId: idB,
    ...(await stepUp(token, { action: "revoke", credentialId: idB })),
  });
  expect(revoked.status).toBe(200);
  expect(subs.list().map((s) => s.endpoint)).toEqual([
    legacy.endpoint,
    SUB.endpoint,
  ]);

  const signedOut = await post(
    "/auth/account/sign-out-everywhere",
    token,
    await stepUp(token, { action: "sign-out-everywhere" }),
  );
  expect(signedOut.status).toBe(200);
  expect(subs.list()).toEqual([]);
  expect((await PushSubscriptionStore.load(path)).list()).toEqual([]);

  // A device signed in anew subscribes again, and is the only one woken.
  const fresh = {
    endpoint: "https://updates.push.services.mozilla.com/wpush/v2/fresh",
    keys: SUB.keys,
  };
  expect((await post("/push/subscription", await login(), fresh)).status).toBe(
    204,
  );
  calls.length = 0;
  await attention(1);
  expect(calls).toEqual([fresh.endpoint]);
});
