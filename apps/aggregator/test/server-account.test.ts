import { afterEach, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_ATTACHES_PER_SUBJECT } from "../src/blind-router";
import { CredentialStore } from "../src/credential-store";
import type { MachineStore } from "../src/machine-store";
import { setPassword } from "../src/password";
import { AggregatorServer } from "../src/server";
import { signSessionToken } from "../src/session-token";
import { type WebAuthnConfig, WebAuthnGate } from "../src/webauthn";
import { dialAgent } from "./helpers/agent-socket";
import { tempMachineStore } from "./helpers/machines";
import { writeCheapPassword } from "./helpers/password";
import {
  type AuthenticationResult,
  VirtualAuthenticator,
} from "./helpers/virtual-authenticator";

const machines = await tempMachineStore();

const RP_ID = "example.test";
const ORIGIN = "https://example.test";
const SECRET = "server-account-test-secret-0123456789";
const PASSWORD = "server-account-test-password";
/** The gate config but for its password file, which each test keeps in its own directory. */
const CFG: Omit<WebAuthnConfig, "passwordPath"> = {
  publicUrl: ORIGIN,
  rpName: "omp-remote test",
  sessionSecret: SECRET,
  sessionTtlSec: 3600,
  rememberTtlSec: 2_592_000,
};

const PASSKEYS = "/auth/account/passkeys";
const CHALLENGE = "/auth/account/challenge";
const REVOKE = "/auth/account/passkeys/revoke";
const SIGN_OUT_EVERYWHERE = "/auth/account/sign-out-everywhere";
const PASSWORD_SIGN_IN = "/auth/account/password-sign-in";
const MACHINES = "/auth/account/machines";
const MACHINE_REVOKE = "/auth/account/machines/revoke";
const SESSION = "/auth/session";

let server: AggregatorServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  server?.stop();
  server = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Where a gated aggregator keeps its credential store and the password file. */
interface GatePaths {
  storePath: string;
  passwordPath: string;
}

/** A running auth-gated aggregator and the credential store behind it. */
interface Gated extends GatePaths {
  http: string;
  ws: string;
  store: CredentialStore;
}

/**
 * Start an auth-gated server over the store and password file at `paths` —
 * by default a fresh store, and PASSWORD set since epoch 0 (before any
 * sign-in).
 */
async function startGated(
  opts: {
    paths?: GatePaths;
    now?: () => number;
    machines?: MachineStore;
    clientRecheckMs?: number;
  } = {},
): Promise<Gated> {
  let paths = opts.paths;
  if (paths === undefined) {
    const dir = await mkdtemp(join(tmpdir(), "omp-account-"));
    dirs.push(dir);
    // The store in a directory of its own, which a test can swap for a file
    // to make every store write fail.
    paths = {
      storePath: join(dir, "store", "cred.json"),
      passwordPath: join(dir, "password.json"),
    };
    await writeCheapPassword(paths.passwordPath, PASSWORD, 0);
  }
  const { storePath, passwordPath } = paths;
  const store = await CredentialStore.load(storePath);
  server = new AggregatorServer({
    machines: opts.machines ?? machines,
    port: 0,
    auth: new WebAuthnGate({ ...CFG, passwordPath }, store, opts.now),
    clientRecheckMs: opts.clientRecheckMs,
  });
  server.start();
  const port = server.boundPort;
  return {
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    store,
    storePath,
    passwordPath,
  };
}

/** Call `path` with a JSON body, as the bearer of session `token` when given. */
function call(
  g: Gated,
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.token !== undefined)
    headers.set("authorization", `Bearer ${opts.token}`);
  return fetch(`${g.http}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

/** Sign in with `password` over HTTP and return the password session token. */
async function signIn(g: Gated, password = PASSWORD): Promise<string> {
  const res = await call(g, "POST", "/auth/login/password", {
    body: { password },
  });
  const body = await res.json();
  expect(body.verified).toBe(true);
  return body.token;
}

/** Which sign-ins the relay offers now (`GET /auth/methods`). */
async function methods(g: Gated): Promise<unknown> {
  return (await call(g, "GET", "/auth/methods")).json();
}

/** A passkey enrolled over HTTP: its software authenticator and credential id. */
interface Passkey {
  auth: VirtualAuthenticator;
  id: string;
}

/** Enroll a passkey over HTTP from a password session, the password its step-up. */
async function enroll(g: Gated): Promise<Passkey> {
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { flowId, options } = await (
    await call(g, "POST", "/auth/register/options", {
      token: await signIn(g),
      body: { password: PASSWORD },
    })
  ).json();
  const registration = auth.register(options);
  const res = await call(g, "POST", "/auth/register/verify", {
    body: { flowId, response: registration },
  });
  expect(await res.json()).toEqual({ verified: true });
  return { auth, id: registration.id };
}

/** Log in with `passkey` over HTTP and return the session token. */
async function login(g: Gated, passkey: Passkey): Promise<string> {
  const { flowId, options } = await (
    await call(g, "POST", "/auth/login/options")
  ).json();
  const res = await call(g, "POST", "/auth/login/verify", {
    body: { flowId, response: passkey.auth.authenticate(options, passkey.id) },
  });
  const body = await res.json();
  expect(body.verified).toBe(true);
  return body.token;
}

/** What a step-up challenge is requested for: the body of `CHALLENGE`. */
type Action =
  | { action: "revoke"; credentialId: string }
  | { action: "sign-out-everywhere" }
  | { action: "password-sign-in"; enabled: boolean }
  | { action: "revoke-machine"; machineId: string };
const SIGN_OUT: Action = { action: "sign-out-everywhere" };
const revoking = (credentialId: string): Action => ({
  action: "revoke",
  credentialId,
});
const passwordSignIn = (enabled: boolean): Action => ({
  action: "password-sign-in",
  enabled,
});

/** Mint a step-up challenge for `action` as the bearer of `token`. */
async function challenge(
  g: Gated,
  token: string,
  action: Action,
): Promise<{
  flowId: string;
  options: {
    challenge: string;
    allowCredentials?: unknown[];
    userVerification?: string;
  };
}> {
  const res = await call(g, "POST", CHALLENGE, { token, body: action });
  expect(res.status).toBe(200);
  return res.json();
}

/** A whole step-up: a challenge for `action` minted for `token`, asserted by `passkey`. */
async function stepUp(
  g: Gated,
  token: string,
  passkey: Passkey,
  action: Action,
  userVerified = true,
): Promise<{ flowId: string; response: AuthenticationResult }> {
  const { flowId, options } = await challenge(g, token, action);
  return {
    flowId,
    response: passkey.auth.authenticate(options, passkey.id, { userVerified }),
  };
}

/** The passkey ids the account list shows `token` (which must be accepted). */
async function listedIds(g: Gated, token: string): Promise<string[]> {
  const res = await call(g, "GET", PASSKEYS, { token });
  expect(res.status).toBe(200);
  const { passkeys } = await res.json();
  return passkeys.map((p: { id: string }) => p.id);
}

/** The passkey ids on disk, as a restarted aggregator would load them. */
async function storedIds(g: Gated): Promise<string[]> {
  return (await CredentialStore.load(g.storePath)).list().map((c) => c.id);
}

/** How a `/client` dial ended: whether it opened, what it received, how it closed. */
interface Dial {
  opened: boolean;
  frames: string[];
  code: number;
  reason: string;
}

/**
 * Dial `/client` (with `token`, if given) and follow the socket until it
 * closes. It pings the moment it opens, and hangs up after its first frame, so
 * a live socket — which answers the ping with a pong — ends too, that frame on
 * record.
 */
function dial(g: Gated, token?: string): Promise<Dial> {
  const query =
    token === undefined ? "" : `?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(`${g.ws}/client${query}`);
  const { promise, resolve } = Promise.withResolvers<Dial>();
  let opened = false;
  const frames: string[] = [];
  ws.addEventListener("open", () => {
    opened = true;
    ws.send(JSON.stringify({ type: "ping" }));
  });
  ws.addEventListener("message", (e) => {
    frames.push(String(e.data));
    ws.close();
  });
  ws.addEventListener("close", (e) =>
    resolve({ opened, frames, code: e.code, reason: e.reason }),
  );
  return promise;
}

/** What `/client` makes of a dial with `token`: "live", "signed out", or "refused" (401). */
async function clientAccess(g: Gated, token: string): Promise<string> {
  const { opened, frames, code, reason } = await dial(g, token);
  if (!opened) return "refused";
  if (frames.length > 0) return "live";
  if (code === 4401 && reason === "signed out") return "signed out";
  return `closed ${code} ${reason}`;
}

/** Open a `/client` socket for `token`; resolves once it answers a ping, i.e. is live. */
async function openClient(g: Gated, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`${g.ws}/client?token=${encodeURIComponent(token)}`);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "ping" })), {
    once: true,
  });
  ws.addEventListener("message", () => resolve(), { once: true });
  ws.addEventListener(
    "close",
    () => reject(new Error("closed before its pong")),
    { once: true },
  );
  await promise;
  return ws;
}

/** Resolve with the code and reason of the close `ws` receives. */
function closeOf(ws: WebSocket): Promise<{ code: number; reason: string }> {
  const { promise, resolve } = Promise.withResolvers<{
    code: number;
    reason: string;
  }>();
  ws.addEventListener(
    "close",
    (e) => resolve({ code: e.code, reason: e.reason }),
    { once: true },
  );
  return promise;
}

/**
 * Ping over `ws`: "pong" while it is live, "closed" if it closes first. The
 * server answers one socket's lines in order, so a pong proves the socket
 * outlived everything the server did before it read the ping.
 */
function ping(ws: WebSocket): Promise<"pong" | "closed"> {
  const { promise, resolve } = Promise.withResolvers<"pong" | "closed">();
  if (ws.readyState !== WebSocket.OPEN) {
    resolve("closed");
    return promise;
  }
  ws.addEventListener("message", (e) => {
    if (JSON.parse(String(e.data)).type === "pong") resolve("pong");
  });
  ws.addEventListener("close", () => resolve("closed"), { once: true });
  ws.send(JSON.stringify({ type: "ping" }));
  return promise;
}

/** Dial `/agent` with `token`, register `machineId`, and resolve once it is routed. */
async function openAgent(
  g: Gated,
  token: string,
  machineId: string,
): Promise<WebSocket> {
  const ws = dialAgent(g.ws, token);
  const { promise, resolve } = Promise.withResolvers<void>();
  ws.addEventListener("open", () => resolve(), { once: true });
  await promise;
  ws.send(JSON.stringify({ type: "register", machineId }));
  expect(await ping(ws)).toBe("pong");
  return ws;
}

test("the owner lists the machines with who is online; a revoke behind the password closes the machine and refuses its token", async () => {
  const store = await tempMachineStore();
  const t1 = await store.issue("m1", 1_000);
  await store.issue("m2", 2_000);
  const g = await startGated({ machines: store });
  const token = await signIn(g);
  const agent = await openAgent(g, t1, "m1");

  expect((await call(g, "GET", MACHINES)).status).toBe(401);
  const listed = await call(g, "GET", MACHINES, { token });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    machines: [
      {
        machineId: "m1",
        joinedAt: 1_000,
        lastSeenAt: expect.any(Number),
        online: true,
      },
      { machineId: "m2", joinedAt: 2_000, online: false },
    ],
  });

  // A password session's step-up is the password: none, or a wrong one, revokes nothing.
  const none = await call(g, "POST", MACHINE_REVOKE, {
    token,
    body: { machineId: "m1" },
  });
  expect(none.status).toBe(403);
  expect(await none.json()).toEqual({ error: "password required" });
  const wrong = await call(g, "POST", MACHINE_REVOKE, {
    token,
    body: { machineId: "m1", password: "not the password" },
  });
  expect(wrong.status).toBe(401);
  expect(await ping(agent)).toBe("pong");
  expect(store.authenticate(t1)).toBe("m1");

  const closed = closeOf(agent);
  const revoked = await call(g, "POST", MACHINE_REVOKE, {
    token,
    body: { machineId: "m1", password: PASSWORD },
  });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toEqual({ revoked: true });
  expect(await closed).toEqual({ code: 4403, reason: "machine revoked" });
  const again = await fetch(`${g.http}/agent`, {
    headers: { authorization: `Bearer ${t1}` },
  });
  expect(again.status).toBe(401);
  await again.text();
  expect(
    (await (await call(g, "GET", MACHINES, { token })).json()).machines,
  ).toEqual([{ machineId: "m2", joinedAt: 2_000, online: false }]);

  const ghost = await call(g, "POST", MACHINE_REVOKE, {
    token,
    body: { machineId: "ghost", password: PASSWORD },
  });
  expect(ghost.status).toBe(404);
});

test("a passkey session revokes a machine only with a step-up minted for that machine", async () => {
  const store = await tempMachineStore();
  const t1 = await store.issue("m1", 1_000);
  await store.issue("m2", 2_000);
  const g = await startGated({ machines: store });
  const passkey = await enroll(g);
  const token = await login(g, passkey);

  // A step-up minted for m2 does not revoke m1, and is spent trying.
  const forM2 = await stepUp(g, token, passkey, {
    action: "revoke-machine",
    machineId: "m2",
  });
  const mismatched = await call(g, "POST", MACHINE_REVOKE, {
    token,
    body: { machineId: "m1", ...forM2 },
  });
  expect(mismatched.status).toBe(403);
  expect(store.authenticate(t1)).toBe("m1");

  const forM1 = await stepUp(g, token, passkey, {
    action: "revoke-machine",
    machineId: "m1",
  });
  const revoked = await call(g, "POST", MACHINE_REVOKE, {
    token,
    body: { machineId: "m1", ...forM1 },
  });
  expect(revoked.status).toBe(200);
  expect(store.authenticate(t1)).toBeUndefined();
  expect(store.list().map((m) => m.machineId)).toEqual(["m2"]);
});

/** A session token in the pre-epoch wire format: HMAC-signed like the gate's, no `ep` claim. */
function legacyToken(sub: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ sub, uv: true, iat, exp: iat + 3600 }),
  ).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Attach `ws` to `machineId` and resolve with the relay's answer. */
function attachOn(ws: WebSocket, machineId: string): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data))), {
    once: true,
  });
  ws.send(JSON.stringify({ type: "attach", machineId }));
  return promise;
}

test("one passkey's attaches are capped across all its /client sockets, which stay open; another passkey's are its own", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const b = await enroll(g);
  // Sign-ins with the same passkey: separate tokens, one subject.
  const first = await openClient(g, await login(g, a));
  const second = await openClient(g, await login(g, a));
  const half = MAX_ATTACHES_PER_SUBJECT / 2;
  for (let i = 0; i < half; i++) {
    expect(await attachOn(first, `first-${i}`)).toMatchObject({
      type: "machines",
    });
    expect(await attachOn(second, `second-${i}`)).toMatchObject({
      type: "machines",
    });
  }
  // A fresh socket brings no fresh allowance.
  const third = await openClient(g, await login(g, a));
  for (const ws of [second, third]) {
    expect(await attachOn(ws, "one-too-many")).toEqual({
      type: "error",
      reason: "attach limit",
    });
    expect(await ping(ws)).toBe("pong");
  }

  const other = await openClient(g, await login(g, b));
  expect(await attachOn(other, "one-too-many")).toMatchObject({
    type: "machines",
  });
});

test("the passkey list dates each passkey, undated then oldest first, and marks the caller's own", async () => {
  let clock = 1_700_000_000_000;
  const g = await startGated({ now: () => clock });
  const first = await enroll(g);
  clock += 60_000;
  const second = await enroll(g);
  clock += 60_000;
  const token = await login(g, second);
  // Stored after those two, yet listed ahead of them: a passkey enrolled before
  // dates were recorded, and one registered earlier.
  await g.store.add({ id: "undated", publicKey: "AA", counter: 0 });
  await g.store.add({
    id: "older",
    publicKey: "AA",
    counter: 0,
    createdAt: 1_600_000_000_000,
  });

  const res = await call(g, "GET", PASSKEYS, { token });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    passkeys: [
      { id: "undated", createdAt: null, lastUsedAt: null, current: false },
      {
        id: "older",
        createdAt: 1_600_000_000_000,
        lastUsedAt: null,
        current: false,
      },
      {
        id: first.id,
        createdAt: 1_700_000_000_000,
        lastUsedAt: null,
        current: false,
      },
      {
        id: second.id,
        createdAt: 1_700_000_060_000,
        lastUsedAt: 1_700_000_120_000,
        current: true,
      },
    ],
  });
});

test("the step-up challenge discloses no credential ids and demands user verification", async () => {
  const g = await startGated();
  const token = await login(g, await enroll(g));
  const { options } = await challenge(g, token, SIGN_OUT);
  expect(options.allowCredentials ?? []).toEqual([]);
  expect(options.userVerification).toBe("required");
});

test("revoking another passkey removes only it: its tokens are signed out at /client and refused at the endpoints, the caller's still work", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const b = await enroll(g);
  const tokenA = await login(g, a);
  const tokenB = await login(g, b);
  expect(await clientAccess(g, tokenB)).toBe("live");
  expect(await listedIds(g, tokenB)).toEqual([a.id, b.id]);

  const res = await call(g, "POST", REVOKE, {
    token: tokenA,
    body: {
      credentialId: b.id,
      ...(await stepUp(g, tokenA, a, revoking(b.id))),
    },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ revoked: true, signedOut: false });

  expect(await storedIds(g)).toEqual([a.id]);
  expect(await clientAccess(g, tokenB)).toBe("signed out");
  const refused = await call(g, "GET", PASSKEYS, { token: tokenB });
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual({ error: "unauthorized" });
  expect(await clientAccess(g, tokenA)).toBe("live");
  expect(await listedIds(g, tokenA)).toEqual([a.id]);
});

test("revoking the caller's own passkey reports signedOut and ends that session", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const b = await enroll(g);
  const tokenA = await login(g, a);
  const tokenB = await login(g, b);
  expect(await clientAccess(g, tokenA)).toBe("live");

  const res = await call(g, "POST", REVOKE, {
    token: tokenA,
    body: {
      credentialId: a.id,
      ...(await stepUp(g, tokenA, a, revoking(a.id))),
    },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ revoked: true, signedOut: true });
  expect((await call(g, "GET", PASSKEYS, { token: tokenA })).status).toBe(401);
  expect(await clientAccess(g, tokenA)).toBe("signed out");
  expect(await listedIds(g, tokenB)).toEqual([b.id]);
});

test("the last remaining passkey cannot be revoked (409) and nothing changes", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const token = await login(g, a);

  const res = await call(g, "POST", REVOKE, {
    token,
    body: {
      credentialId: a.id,
      ...(await stepUp(g, token, a, revoking(a.id))),
    },
  });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "last passkey" });
  expect(await storedIds(g)).toEqual([a.id]);
  expect(await listedIds(g, token)).toEqual([a.id]);
  expect(await clientAccess(g, token)).toBe("live");
});

test("sign out everywhere signs out every earlier token, the caller's too; a new login works, also after a restart", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const b = await enroll(g);
  const tokenA = await login(g, a);
  const tokenB = await login(g, b);
  for (const token of [tokenA, tokenB])
    expect(await clientAccess(g, token)).toBe("live");

  const res = await call(g, "POST", SIGN_OUT_EVERYWHERE, {
    token: tokenA,
    body: await stepUp(g, tokenA, a, SIGN_OUT),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ signedOut: true });

  for (const stale of [tokenA, tokenB]) {
    expect(await clientAccess(g, stale)).toBe("signed out");
    expect((await call(g, "GET", PASSKEYS, { token: stale })).status).toBe(401);
  }
  const fresh = await login(g, b);
  expect(await clientAccess(g, fresh)).toBe("live");
  expect(await listedIds(g, fresh)).toEqual([a.id, b.id]);

  // A restart reloads the store from disk: the bumped epoch still holds.
  server?.stop();
  const restarted = await startGated({ paths: g });
  for (const stale of [tokenA, tokenB])
    expect(await clientAccess(restarted, stale)).toBe("signed out");
  expect(await clientAccess(restarted, fresh)).toBe("live");
});

test("revoke, sign out everywhere, and turning password sign-in off demand a fresh, user-verified, single-use step-up minted for that action, target, and session (403), and nothing changes", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const b = await enroll(g);
  const tokenA = await login(g, a);
  const tokenB = await login(g, b);

  const actions = [
    [REVOKE, { credentialId: b.id }, revoking(b.id), SIGN_OUT],
    [SIGN_OUT_EVERYWHERE, {}, SIGN_OUT, revoking(b.id)],
    [
      PASSWORD_SIGN_IN,
      { enabled: false },
      passwordSignIn(false),
      passwordSignIn(true),
    ],
  ] as const;
  /**
   * Each builds a new step-up the server must refuse at `path`, for the
   * `action` it is posted for, where `other` is another action.
   */
  const refusedStepUps: Record<
    string,
    (
      path: string,
      target: object,
      action: Action,
      other: Action,
    ) => Promise<object>
  > = {
    "no step-up fields at all": async () => ({}),
    "no step-up at all": async () => ({ flowId: "", response: null }),
    "a genuine assertion over a challenge the server never issued":
      async () => ({
        flowId: "never-issued",
        response: a.auth.authenticate(
          { challenge: randomBytes(32).toString("base64url") },
          a.id,
        ),
      }),
    "a login challenge": async () => {
      const { flowId, options } = await (
        await call(g, "POST", "/auth/login/options")
      ).json();
      return { flowId, response: a.auth.authenticate(options, a.id) };
    },
    "an assertion without user verification": (_path, _target, action) =>
      stepUp(g, tokenA, a, action, false),
    "a spent step-up, signed again": async (path, target, action) => {
      const { flowId, options } = await challenge(g, tokenA, action);
      // Spent by a refused try: its assertion lacked user verification.
      const spent = await call(g, "POST", path, {
        token: tokenA,
        body: {
          ...target,
          flowId,
          response: a.auth.authenticate(options, a.id, {
            userVerified: false,
          }),
        },
      });
      expect(spent.status).toBe(403);
      return { flowId, response: a.auth.authenticate(options, a.id) };
    },
    "a step-up minted for the other action": (_path, _target, _action, other) =>
      stepUp(g, tokenA, a, other),
    "a step-up minted to revoke another passkey": () =>
      stepUp(g, tokenA, a, revoking(a.id)),
    "a step-up minted for another session": (_path, _target, action) =>
      stepUp(g, tokenB, a, action),
  };

  for (const [stepUpKind, refused] of Object.entries(refusedStepUps)) {
    for (const [path, target, action, other] of actions) {
      const res = await call(g, "POST", path, {
        token: tokenA,
        body: { ...target, ...(await refused(path, target, action, other)) },
      });
      expect({ stepUpKind, path, status: res.status }).toEqual({
        stepUpKind,
        path,
        status: 403,
      });
      expect(await res.json()).toEqual({ error: "passkey check failed" });
    }
  }

  // Both passkeys remain, every token (so the epoch) still holds, and
  // password sign-in is still on.
  expect(await storedIds(g)).toEqual([a.id, b.id]);
  for (const token of [tokenA, tokenB]) {
    expect(await listedIds(g, token)).toEqual([a.id, b.id]);
    expect(await clientAccess(g, token)).toBe("live");
  }
  expect(await methods(g)).toEqual({ password: true, passkey: true });
});

test("a step-up challenge cannot finish a login", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const token = await login(g, a);
  const res = await call(g, "POST", "/auth/login/verify", {
    body: await stepUp(g, token, a, SIGN_OUT),
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ verified: false });
});

test("every account endpoint answers 401 without a session token the gate accepts", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const valid = await login(g, a);
  const forged = signSessionToken(
    { sub: a.id, uv: true, ep: 0, m: "pk" },
    `${SECRET}-other`,
    { now: Date.now(), ttlSec: 3600 },
  );
  const routes = [
    ["GET", PASSKEYS],
    ["POST", CHALLENGE],
    ["POST", REVOKE],
    ["POST", SIGN_OUT_EVERYWHERE],
    ["POST", PASSWORD_SIGN_IN],
  ] as const;
  for (const [method, path] of routes) {
    for (const authorization of [
      undefined,
      `Basic ${valid}`,
      "Bearer ",
      "Bearer not.a.token",
      `Bearer ${forged}`,
    ]) {
      const headers = new Headers({ "content-type": "application/json" });
      if (authorization !== undefined)
        headers.set("authorization", authorization);
      // `{}` would fail a later check (400 or 403): the token comes first.
      const res = await fetch(`${g.http}${path}`, {
        method,
        headers,
        body: method === "POST" ? "{}" : undefined,
      });
      expect({ path, authorization, status: res.status }).toEqual({
        path,
        authorization,
        status: 401,
      });
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  }
});

test("account checks come in order: method (405), body (400), step-up (403), then the action's rules (404)", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const b = await enroll(g);
  const token = await login(g, a);

  expect((await call(g, "POST", PASSKEYS, { token, body: {} })).status).toBe(
    405,
  );
  for (const path of [CHALLENGE, REVOKE, SIGN_OUT_EVERYWHERE, PASSWORD_SIGN_IN])
    expect((await call(g, "GET", path, { token })).status).toBe(405);

  // A malformed body is a 400 before any step-up is looked at.
  const malformed = [
    [CHALLENGE, []],
    // A challenge must name its action: what a PWA from before bound
    // step-ups sends (`{}`) is refused, as is a revoke naming no passkey.
    [CHALLENGE, {}],
    [CHALLENGE, { action: "revoke" }],
    [CHALLENGE, { action: "delete-everything" }],
    [REVOKE, { flowId: "x", response: null }],
    [PASSWORD_SIGN_IN, {}],
    [PASSWORD_SIGN_IN, { enabled: "off", password: PASSWORD }],
    [SIGN_OUT_EVERYWHERE, { flowId: 42, response: null }],
  ] as const;
  for (const [path, body] of malformed) {
    const res = await call(g, "POST", path, { token, body });
    expect({ path, body, status: res.status }).toEqual({
      path,
      body,
      status: 400,
    });
    expect(await res.json()).toEqual({ error: "bad request" });
  }

  // The step-up precedes the action's rules: an unknown passkey is a 403
  // without a step-up — none at all is refused like a failed one, not as
  // malformed — and only a 404 once one passes.
  const unverified = await call(g, "POST", REVOKE, {
    token,
    body: { credentialId: "no-such-passkey" },
  });
  expect(unverified.status).toBe(403);
  const unknown = await call(g, "POST", REVOKE, {
    token,
    body: {
      credentialId: "no-such-passkey",
      ...(await stepUp(g, token, a, revoking("no-such-passkey"))),
    },
  });
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "not found" });
  expect(await storedIds(g)).toEqual([a.id, b.id]);
});

test("open /client sockets close 4401 'signed out': a revoked passkey's on revoke, every one on sign out everywhere", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const b = await enroll(g);
  const c = await enroll(g);
  const tokenA = await login(g, a);
  const socketA = await openClient(g, tokenA);
  const socketB = await openClient(g, await login(g, b));
  const socketC = await openClient(g, await login(g, c));

  const cClosed = closeOf(socketC);
  const revoke = await call(g, "POST", REVOKE, {
    token: tokenA,
    body: {
      credentialId: c.id,
      ...(await stepUp(g, tokenA, a, revoking(c.id))),
    },
  });
  expect(revoke.status).toBe(200);
  expect(await cClosed).toEqual({ code: 4401, reason: "signed out" });
  // The other passkeys' sockets were left alone.
  expect(await ping(socketA)).toBe("pong");
  expect(await ping(socketB)).toBe("pong");

  const aClosed = closeOf(socketA);
  const bClosed = closeOf(socketB);
  const signOut = await call(g, "POST", SIGN_OUT_EVERYWHERE, {
    token: tokenA,
    body: await stepUp(g, tokenA, a, SIGN_OUT),
  });
  expect(signOut.status).toBe(200);
  expect(await aClosed).toEqual({ code: 4401, reason: "signed out" });
  expect(await bClosed).toEqual({ code: 4401, reason: "signed out" });
});

test("a revoked sign-in dialling /client is let in only to be closed 4401 'signed out', sent nothing; a forged, expired, or missing token is still refused with 401", async () => {
  let clock = 1_700_000_000_000;
  const g = await startGated({ now: () => clock });
  const a = await enroll(g);
  const b = await enroll(g);
  const tokenA = await login(g, a);
  const tokenB = await login(g, b);
  const signedOut: Dial = {
    opened: true,
    frames: [],
    code: 4401,
    reason: "signed out",
  };

  // A revoked passkey's token, in the current epoch.
  const revoke = await call(g, "POST", REVOKE, {
    token: tokenA,
    body: {
      credentialId: b.id,
      ...(await stepUp(g, tokenA, a, revoking(b.id))),
    },
  });
  expect(revoke.status).toBe(200);
  expect(await dial(g, tokenB)).toEqual(signedOut);

  // A token from before a sign-out-everywhere, its passkey still registered.
  const signOut = await call(g, "POST", SIGN_OUT_EVERYWHERE, {
    token: tokenA,
    body: await stepUp(g, tokenA, a, SIGN_OUT),
  });
  expect(signOut.status).toBe(200);
  expect(await storedIds(g)).toEqual([a.id]);
  expect(await dial(g, tokenA)).toEqual(signedOut);

  // Refused outright, as before: a forged token, an expired one, or none.
  const forged = signSessionToken(
    { sub: a.id, uv: true, ep: 1, m: "pk" },
    `${SECRET}-other`,
    { now: clock, ttlSec: CFG.sessionTtlSec },
  );
  const expired = await login(g, a);
  clock += CFG.sessionTtlSec * 1000;
  for (const token of [forged, expired, undefined]) {
    const query =
      token === undefined ? "" : `?token=${encodeURIComponent(token)}`;
    expect((await fetch(`${g.http}/client${query}`)).status).toBe(401);
    expect((await dial(g, token)).opened).toBe(false);
  }
});

test("an account change the store cannot write is a 500 that changes nothing: no passkey removed, no epoch bumped, no socket closed", async () => {
  let clock = 1_700_000_000_000;
  const g = await startGated({ now: () => clock });
  const a = await enroll(g);
  const b = await enroll(g);
  const tokenA = await login(g, a);
  const tokenB = await login(g, b);
  const socketB = await openClient(g, tokenB);
  const listed = await (
    await call(g, "GET", PASSKEYS, { token: tokenA })
  ).json();

  // Every store write fails from here: the store's directory is now a file.
  const storeDir = dirname(g.storePath);
  await rm(storeDir, { recursive: true });
  await writeFile(storeDir, "");
  clock += 60_000;
  const revoke = await call(g, "POST", REVOKE, {
    token: tokenA,
    body: {
      credentialId: b.id,
      ...(await stepUp(g, tokenA, a, revoking(b.id))),
    },
  });
  const signOut = await call(g, "POST", SIGN_OUT_EVERYWHERE, {
    token: tokenA,
    body: await stepUp(g, tokenA, a, SIGN_OUT),
  });
  for (const res of [revoke, signOut]) {
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  }

  // All undone, down to the step-ups' last use, and no socket was closed.
  const after = await call(g, "GET", PASSKEYS, { token: tokenA });
  expect(await after.json()).toEqual(listed);
  expect(await clientAccess(g, tokenB)).toBe("live");
  expect(await ping(socketB)).toBe("pong");

  // Once the store can write again, the next change carries none of it to disk.
  await rm(storeDir);
  await login(g, a);
  const onDisk = await CredentialStore.load(g.storePath);
  expect(onDisk.list().map((c) => c.id)).toEqual([a.id, b.id]);
  expect(onDisk.tokenEpoch).toBe(0);
});

test("a legacy token without an epoch claim works while the epoch is 0, and not after sign out everywhere", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const legacy = legacyToken(a.id);
  expect(await clientAccess(g, legacy)).toBe("live");
  expect(await listedIds(g, legacy)).toEqual([a.id]);

  const res = await call(g, "POST", SIGN_OUT_EVERYWHERE, {
    token: legacy,
    body: await stepUp(g, legacy, a, SIGN_OUT),
  });
  expect(res.status).toBe(200);
  expect(await clientAccess(g, legacy)).toBe("signed out");
  expect((await call(g, "GET", PASSKEYS, { token: legacy })).status).toBe(401);
});

test("GET /auth/session is 204 while the relay accepts the token, and 401 once it is missing, forged, revoked, or expired", async () => {
  let clock = 1_700_000_000_000;
  const g = await startGated({ now: () => clock });
  const a = await enroll(g);
  const b = await enroll(g);
  const tokenA = await login(g, a);
  const tokenB = await login(g, b);

  const ok = await call(g, "GET", SESSION, { token: tokenA });
  expect(ok.status).toBe(204);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  const post = await call(g, "POST", SESSION, { token: tokenA, body: {} });
  expect(post.status).toBe(405);

  // B's passkey is revoked: its token is still authentic, but refused.
  const revoke = await call(g, "POST", REVOKE, {
    token: tokenA,
    body: {
      credentialId: b.id,
      ...(await stepUp(g, tokenA, a, revoking(b.id))),
    },
  });
  expect(revoke.status).toBe(200);
  const forged = signSessionToken(
    { sub: a.id, uv: true, ep: 0, m: "pk" },
    `${SECRET}-other`,
    { now: clock, ttlSec: CFG.sessionTtlSec },
  );
  for (const authorization of [
    undefined,
    `Basic ${tokenA}`,
    "Bearer ",
    "Bearer not.a.token",
    `Bearer ${forged}`,
    `Bearer ${tokenB}`,
  ]) {
    const headers = new Headers();
    if (authorization !== undefined)
      headers.set("authorization", authorization);
    const res = await fetch(`${g.http}${SESSION}`, { headers });
    expect({ authorization, status: res.status }).toEqual({
      authorization,
      status: 401,
    });
  }
  expect((await call(g, "GET", SESSION, { token: tokenA })).status).toBe(204);

  // A's token outlives its lifetime.
  clock += CFG.sessionTtlSec * 1000;
  expect((await call(g, "GET", SESSION, { token: tokenA })).status).toBe(401);
});

test("a password session signs out everywhere with the password as its step-up; a wrong password is a 401 that leaves the epoch be", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const passwordToken = await signIn(g);
  const passkeyToken = await login(g, a);

  const wrong = await call(g, "POST", SIGN_OUT_EVERYWHERE, {
    token: passwordToken,
    body: { password: `${PASSWORD}x` },
  });
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toEqual({ error: "wrong password" });
  // A password session's step-up is the password, never a passkey check.
  const passkeyCheck = await call(g, "POST", SIGN_OUT_EVERYWHERE, {
    token: passwordToken,
    body: await stepUp(g, passwordToken, a, SIGN_OUT),
  });
  expect(passkeyCheck.status).toBe(403);
  expect(await passkeyCheck.json()).toEqual({ error: "password required" });
  expect(g.store.tokenEpoch).toBe(0);
  for (const token of [passwordToken, passkeyToken])
    expect(await clientAccess(g, token)).toBe("live");

  const res = await call(g, "POST", SIGN_OUT_EVERYWHERE, {
    token: passwordToken,
    body: { password: PASSWORD },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ signedOut: true });
  expect(g.store.tokenEpoch).toBe(1);
  for (const token of [passwordToken, passkeyToken])
    expect(await clientAccess(g, token)).toBe("signed out");
});

test("a password session issued before the password is set again stops opening /client", async () => {
  let clock = 1_700_000_000_000;
  const g = await startGated({ now: () => clock });
  const before = await signIn(g);
  expect(await clientAccess(g, before)).toBe("live");

  clock += 1_000;
  await setPassword(g.passwordPath, "a whole new password", clock);
  expect(await clientAccess(g, before)).toBe("signed out");
  expect((await call(g, "GET", SESSION, { token: before })).status).toBe(401);
  // Only the new password signs in now, and its session holds.
  const old = await call(g, "POST", "/auth/login/password", {
    body: { password: PASSWORD },
  });
  expect(old.status).toBe(401);
  expect(await clientAccess(g, await signIn(g, "a whole new password"))).toBe(
    "live",
  );
});

test("an open /client socket closes 4401 'signed out' once its token expires; a longer-lived one stays", async () => {
  let clock = 1_700_000_000_000;
  const g = await startGated({ now: () => clock, clientRecheckMs: 5 });
  const short = await openClient(g, await signIn(g));
  const remembered = await call(g, "POST", "/auth/login/password", {
    body: { password: PASSWORD, remember: true },
  });
  const long = await openClient(g, (await remembered.json()).token);

  const closed = closeOf(short);
  clock += CFG.sessionTtlSec * 1000;
  expect(await closed).toEqual({ code: 4401, reason: "signed out" });
  expect(await ping(long)).toBe("pong");
});

test("a password set from outside the relay closes open password-session /client sockets 4401 'signed out'; passkey sessions stay", async () => {
  let clock = 1_700_000_000_000;
  const g = await startGated({ now: () => clock, clientRecheckMs: 5 });
  const a = await enroll(g);
  const passwordSocket = await openClient(g, await signIn(g));
  const passkeySocket = await openClient(g, await login(g, a));

  const closed = closeOf(passwordSocket);
  clock += 1_000;
  await writeCheapPassword(g.passwordPath, "a whole new password", clock);
  expect(await closed).toEqual({ code: 4401, reason: "signed out" });
  expect(await ping(passkeySocket)).toBe("pong");
});

test("turning password sign-in off takes a passkey session: from a password session it is a 403; from a passkey session with one passkey and a step-up for exactly that, a 200", async () => {
  const g = await startGated();
  const a = await enroll(g);
  const passwordToken = await signIn(g);
  const passkeyToken = await login(g, a);

  const fromPassword = await call(g, "POST", PASSWORD_SIGN_IN, {
    token: passwordToken,
    body: { enabled: false, password: PASSWORD },
  });
  expect(fromPassword.status).toBe(403);
  expect(await fromPassword.json()).toEqual({
    error: "passkey session required",
  });
  expect(await methods(g)).toEqual({ password: true, passkey: true });

  const res = await call(g, "POST", PASSWORD_SIGN_IN, {
    token: passkeyToken,
    body: {
      enabled: false,
      ...(await stepUp(g, passkeyToken, a, passwordSignIn(false))),
    },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ passwordSignIn: false });
  expect(await methods(g)).toEqual({ password: false, passkey: true });
});

test("with password sign-in off, password sign-in is a 403 and every password session ends — its socket closed 4401, its token refused — for good, even once it is back on", async () => {
  let clock = 1_700_000_000_000;
  const g = await startGated({ now: () => clock });
  const a = await enroll(g);
  const passwordToken = await signIn(g);
  const passwordSocket = await openClient(g, passwordToken);
  const passkeyToken = await login(g, a);
  const turn = async (enabled: boolean): Promise<Response> =>
    call(g, "POST", PASSWORD_SIGN_IN, {
      token: passkeyToken,
      body: {
        enabled,
        ...(await stepUp(g, passkeyToken, a, passwordSignIn(enabled))),
      },
    });

  clock += 1_000;
  const closed = closeOf(passwordSocket);
  expect((await turn(false)).status).toBe(200);
  expect(await closed).toEqual({ code: 4401, reason: "signed out" });
  expect(await clientAccess(g, passwordToken)).toBe("signed out");
  expect((await call(g, "GET", SESSION, { token: passwordToken })).status).toBe(
    401,
  );
  const refused = await call(g, "POST", "/auth/login/password", {
    body: { password: PASSWORD },
  });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "password sign-in disabled" });
  expect(await clientAccess(g, passkeyToken)).toBe("live");

  // Back on: the password signs in afresh, but no session it ended revives.
  clock += 1_000;
  const on = await turn(true);
  expect(on.status).toBe(200);
  expect(await on.json()).toEqual({ passwordSignIn: true });
  expect(await clientAccess(g, await signIn(g))).toBe("live");
  expect(await clientAccess(g, passwordToken)).toBe("signed out");
});
