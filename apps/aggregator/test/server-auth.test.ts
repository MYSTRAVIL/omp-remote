import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/credential-store";
import { AggregatorServer, clientAddress } from "../src/server";
import { verifySessionToken } from "../src/session-token";
import {
  MAX_CREDENTIALS,
  MAX_PENDING_CEREMONIES,
  MAX_PENDING_LOGINS_PER_CLIENT,
  WebAuthnGate,
} from "../src/webauthn";
import { tempMachineStore } from "./helpers/machines";
import { writeCheapPassword } from "./helpers/password";
import { VirtualAuthenticator } from "./helpers/virtual-authenticator";

const machines = await tempMachineStore();

const RP_ID = "example.test";
const ORIGIN = "https://example.test";
/**
 * The URL the phone opens, as configured. Ceremonies expect its origin — this
 * URL without the trailing slash — and its hostname as the RP ID, which is
 * what the virtual authenticator signs for.
 */
const PUBLIC_URL = `${ORIGIN}/`;
const SECRET = "server-auth-test-secret-0123456789";
const PASSWORD = "server-auth-test-password";
const SESSION_TTL_SEC = 3600;
const REMEMBER_TTL_SEC = 2_592_000;

let server: AggregatorServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  server?.stop();
  server = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/**
 * Start an auth-gated server with PASSWORD set (since epoch 0, before any
 * sign-in); `passkeys: false` boots it without a `publicUrl`; `trustProxy`
 * reads the client from `X-Real-IP`, as behind nginx.
 */
async function startGated(
  opts: { now?: () => number; passkeys?: boolean; trustProxy?: boolean } = {},
): Promise<{ base: string; http: string; store: CredentialStore }> {
  const dir = await mkdtemp(join(tmpdir(), "omp-srvauth-"));
  dirs.push(dir);
  const store = await CredentialStore.load(join(dir, "cred.json"));
  const passwordPath = join(dir, "password.json");
  await writeCheapPassword(passwordPath, PASSWORD, 0);
  const gate = new WebAuthnGate(
    {
      publicUrl: opts.passkeys === false ? undefined : PUBLIC_URL,
      rpName: "omp-remote test",
      sessionSecret: SECRET,
      sessionTtlSec: SESSION_TTL_SEC,
      rememberTtlSec: REMEMBER_TTL_SEC,
      passwordPath,
    },
    store,
    opts.now,
  );
  server = new AggregatorServer({
    machines,
    port: 0,
    auth: gate,
    trustProxy: opts.trustProxy,
  });
  server.start();
  const port = server.boundPort;
  return {
    base: `ws://127.0.0.1:${port}`,
    http: `http://127.0.0.1:${port}`,
    store,
  };
}

/** POST `body` as JSON to `path`, as the bearer of session `token` when given. */
async function post(
  http: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${http}${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Sign in with the password over HTTP; return the password session token. */
async function signIn(http: string): Promise<string> {
  const res = await post(http, "/auth/login/password", { password: PASSWORD });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.verified).toBe(true);
  return body.token;
}

/** Register a fresh passkey for `auth` over HTTP, from a password session. */
async function enroll(http: string, auth: VirtualAuthenticator): Promise<void> {
  const token = await signIn(http);
  const regRes = await post(
    http,
    "/auth/register/options",
    { password: PASSWORD },
    token,
  );
  expect(regRes.status).toBe(200);
  const regOpts = await regRes.json();
  const regVerify = await (
    await post(http, "/auth/register/verify", {
      flowId: regOpts.flowId,
      response: auth.register(regOpts.options),
    })
  ).json();
  expect(regVerify.verified).toBe(true);
}

/** Log in with `auth`'s passkey over HTTP; return the passkey session token. */
async function passkeyLogin(
  http: string,
  auth: VirtualAuthenticator,
): Promise<string> {
  const loginOpts = await (await post(http, "/auth/login/options")).json();
  const loginRes = await post(http, "/auth/login/verify", {
    flowId: loginOpts.flowId,
    response: auth.authenticate(loginOpts.options),
  });
  expect(loginRes.status).toBe(200);
  const body = await loginRes.json();
  expect(body.verified).toBe(true);
  expect(typeof body.token).toBe("string");
  return body.token;
}

/** Run the full register + login ceremony over HTTP; return the session token. */
async function enrollAndLogin(http: string): Promise<string> {
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await enroll(http, auth);
  return passkeyLogin(http, auth);
}

/** Resolve "open" or "rejected" for a WS connection attempt. */
function connectOutcome(url: string): Promise<"open" | "rejected"> {
  const { promise, resolve } = Promise.withResolvers<"open" | "rejected">();
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => {
    ws.close();
    resolve("open");
  });
  ws.addEventListener("error", () => resolve("rejected"));
  ws.addEventListener("close", (e) => {
    if (e.code !== 1000 && e.code !== 1005) resolve("rejected");
  });
  return promise;
}

test("a full passkey ceremony issues a token that opens /client", async () => {
  const { base, http } = await startGated();
  const token = await enrollAndLogin(http);

  expect(
    await connectOutcome(`${base}/client?token=${encodeURIComponent(token)}`),
  ).toBe("open");
});

test("/client is rejected without a token", async () => {
  const { base } = await startGated();
  expect(await connectOutcome(`${base}/client`)).toBe("rejected");
});

test("/client is rejected with a forged token", async () => {
  const { base } = await startGated();
  const forged = `${Buffer.from('{"sub":"x","uv":true,"iat":1,"exp":9999999999}').toString("base64url")}.${Buffer.from("not-a-signature").toString("base64url")}`;
  expect(await connectOutcome(`${base}/client?token=${forged}`)).toBe(
    "rejected",
  );
});

test("an unregistered credential cannot obtain a token over HTTP", async () => {
  const { http } = await startGated();
  const stranger = new VirtualAuthenticator(RP_ID, ORIGIN);
  const strangerReg = stranger.register({ challenge: "x" });
  const loginOpts = await (await post(http, "/auth/login/options")).json();
  const res = await post(http, "/auth/login/verify", {
    flowId: loginOpts.flowId,
    response: stranger.authenticate(loginOpts.options, strangerReg.id),
  });
  expect(res.status).toBe(401);
  expect((await res.json()).verified).toBe(false);
});

test("auth endpoints are absent when no gate is configured", async () => {
  server = new AggregatorServer({ machines, port: 0 });
  server.start();
  const http = `http://127.0.0.1:${server.boundPort}`;
  // With no gate, /auth/* is not a known route → 404 (the catch-all response).
  const res = await post(http, "/auth/register/options");
  expect(res.status).toBe(404);
  expect((await fetch(`${http}/auth/session`)).status).toBe(404);
  // and /client is open (no token required)
  expect(
    await connectOutcome(`ws://127.0.0.1:${server.boundPort}/client`),
  ).toBe("open");
});

test("a bad verify body is a 400, not a crash", async () => {
  const { http } = await startGated();
  const res = await post(http, "/auth/register/verify", { nope: true });
  expect(res.status).toBe(400);
});

test("a login flow id cannot finish a registration (no enrollment without a session)", async () => {
  const { http, store } = await startGated();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  // Anyone can mint a login flow; replaying it at register/verify must fail.
  const loginOpts = await (await post(http, "/auth/login/options")).json();
  const res = await post(http, "/auth/register/verify", {
    flowId: loginOpts.flowId,
    response: auth.register(loginOpts.options),
  });
  expect((await res.json()).verified).toBe(false);
  expect(store.list()).toHaveLength(0);
});

test("enrollment is refused once MAX_CREDENTIALS passkeys are stored", async () => {
  const { http, store } = await startGated();
  for (let i = 0; i < MAX_CREDENTIALS; i++)
    await store.add({ id: `placeholder-${i}`, publicKey: "AA", counter: 0 });
  const res = await post(
    http,
    "/auth/register/options",
    { password: PASSWORD },
    await signIn(http),
  );
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "credential-limit" });
});

test("GET /auth/methods offers the password alone without a publicUrl, and passkeys too with one", async () => {
  const { http: passwordOnly } = await startGated({ passkeys: false });
  const res = await fetch(`${passwordOnly}/auth/methods`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ password: true, passkey: false });
  server?.stop();

  const { http } = await startGated();
  expect(await (await fetch(`${http}/auth/methods`)).json()).toEqual({
    password: true,
    passkey: true,
  });
});

test("without a publicUrl the passkey routes are not served, and a password sign-in still opens /client", async () => {
  const { base, http } = await startGated({ passkeys: false });
  const token = await signIn(http);
  for (const path of [
    "/auth/register/options",
    "/auth/register/verify",
    "/auth/login/options",
    "/auth/login/verify",
    "/auth/account/challenge",
  ]) {
    const res = await post(http, path, { action: "register" }, token);
    expect({ path, status: res.status }).toEqual({ path, status: 404 });
  }
  expect(
    await connectOutcome(`${base}/client?token=${encodeURIComponent(token)}`),
  ).toBe("open");
});

test("POST /auth/login/password: the right password opens /client; a wrong one is a uniform 401; the sixth failure in a row is a 429 with retryAfterSec", async () => {
  let clock = 1_700_000_000_000;
  const { base, http } = await startGated({ now: () => clock });
  const login = (password: string, remember?: boolean) =>
    post(http, "/auth/login/password", { password, remember });

  const res = await login(PASSWORD);
  expect(res.status).toBe(200);
  const { verified, token } = await res.json();
  expect(verified).toBe(true);
  expect(
    await connectOutcome(`${base}/client?token=${encodeURIComponent(token)}`),
  ).toBe("open");
  // A password session: the one owner, no passkey, the default lifetime —
  // or the longer one when the device is remembered.
  const session = verifySessionToken(token, SECRET, clock);
  expect(session).toMatchObject({ sub: "owner", m: "pw", uv: false });
  expect((session?.exp ?? 0) - (session?.iat ?? 0)).toBe(SESSION_TTL_SEC);
  const remembered = verifySessionToken(
    (await (await login(PASSWORD, true)).json()).token,
    SECRET,
    clock,
  );
  expect((remembered?.exp ?? 0) - (remembered?.iat ?? 0)).toBe(
    REMEMBER_TTL_SEC,
  );

  for (let i = 0; i < 5; i++) {
    const wrong = await login(`${PASSWORD}x`);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ verified: false });
  }
  const locked = await login(`${PASSWORD}x`);
  expect(locked.status).toBe(429);
  expect(locked.headers.get("retry-after")).toBe("1");
  expect(await locked.json()).toEqual({ retryAfterSec: 1 });
  // Locked out, even the right password waits.
  expect((await login(PASSWORD)).status).toBe(429);
  clock += 1_000;
  expect((await login(PASSWORD)).status).toBe(200);
});

test("a password guesser cannot dodge the throttle by sending a fresh X-Real-IP each time: headers count only with trustProxy, and all clients share a global budget", async () => {
  const clock = 1_700_000_000_000;
  const guess = (http: string, n: number) =>
    fetch(`${http}/auth/login/password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": `198.51.100.${n}`,
      },
      body: JSON.stringify({ password: `${PASSWORD}x` }),
    });
  // Untrusted proxy (the default): every guess keys on the loopback peer.
  const untrusted = await startGated({ now: () => clock });
  for (let i = 0; i < 5; i++)
    expect((await guess(untrusted.http, i)).status).toBe(401);
  expect((await guess(untrusted.http, 5)).status).toBe(429);
  server?.stop();
  // Trusted proxy: each address has its own five, but the global twenty cap them all.
  const trusted = await startGated({ now: () => clock, trustProxy: true });
  for (let i = 0; i < 20; i++)
    expect((await guess(trusted.http, i)).status).toBe(401);
  expect((await guess(trusted.http, 20)).status).toBe(429);
});

test("POST /auth/register/options needs a session (401) and a step-up (403); with both it returns options, and an enroll secret stands in for neither", async () => {
  const { http } = await startGated();
  const enrollSecret = "e".repeat(32);
  const options = (body: unknown, token?: string) =>
    post(http, "/auth/register/options", body, token);

  for (const body of [{ password: PASSWORD }, { enrollSecret }]) {
    const res = await options(body);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  }

  const token = await signIn(http);
  // No step-up: no body, a non-JSON one, `{}`, or an enroll secret.
  const notJson = await fetch(`${http}/auth/register/options`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "not json",
  });
  for (const res of [
    await options(undefined, token),
    notJson,
    await options({}, token),
    await options({ enrollSecret }, token),
  ]) {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "password required" });
  }
  const wrong = await options({ password: `${PASSWORD}x` }, token);
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toEqual({ error: "wrong password" });
  expect((await options({ password: 42 }, token)).status).toBe(400);

  const ok = await options({ password: PASSWORD }, token);
  expect(ok.status).toBe(200);
  const body = await ok.json();
  expect(typeof body.flowId).toBe("string");
  expect(body.options.rp.id).toBe(RP_ID);
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  const verified = await post(http, "/auth/register/verify", {
    flowId: body.flowId,
    response: auth.register(body.options),
  });
  expect(await verified.json()).toEqual({ verified: true });

  // A passkey session's step-up is a passkey check minted for registering,
  // never the password.
  const passkeyToken = await passkeyLogin(http, auth);
  const refused = await options({ password: PASSWORD }, passkeyToken);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "passkey check failed" });
  const challenge = await (
    await post(
      http,
      "/auth/account/challenge",
      { action: "register" },
      passkeyToken,
    )
  ).json();
  const stepped = await options(
    {
      flowId: challenge.flowId,
      response: auth.authenticate(challenge.options),
    },
    passkeyToken,
  );
  expect(stepped.status).toBe(200);
  expect(typeof (await stepped.json()).flowId).toBe("string");
});

test("login options disclose no credential ids, yet a discoverable passkey still logs in", async () => {
  const { http } = await startGated();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await enroll(http, auth);

  const loginOpts = await (await post(http, "/auth/login/options")).json();
  expect(loginOpts.options.allowCredentials ?? []).toEqual([]);
  const res = await post(http, "/auth/login/verify", {
    flowId: loginOpts.flowId,
    response: auth.authenticate(loginOpts.options),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).verified).toBe(true);
});

/** POST login options as a client nginx forwarded from `realIp`. */
function loginOptionsFrom(http: string, realIp: string): Promise<Response> {
  return fetch(`${http}/auth/login/options`, {
    method: "POST",
    headers: { "x-real-ip": realIp },
  });
}

test("behind the loopback proxy, a login-options flood from one address never evicts another's login; a newcomer finding every slot held gets 429", async () => {
  const { http } = await startGated({ trustProxy: true });
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await enroll(http, auth);
  const owner = await (await loginOptionsFrom(http, "198.51.100.7")).json();
  for (let i = 0; i < 2 * MAX_PENDING_LOGINS_PER_CLIENT; i++)
    expect((await loginOptionsFrom(http, "203.0.113.9")).status).toBe(200);
  // Every other slot filled from many addresses, a client's share each.
  const others = MAX_PENDING_CEREMONIES - 1 - MAX_PENDING_LOGINS_PER_CLIENT;
  for (let i = 0; i < others; i++) {
    const from = `10.0.${Math.floor(i / MAX_PENDING_LOGINS_PER_CLIENT)}.1`;
    expect((await loginOptionsFrom(http, from)).status).toBe(200);
  }
  const refused = await loginOptionsFrom(http, "192.0.2.200");
  expect(refused.status).toBe(429);
  expect(await refused.json()).toEqual({ error: "busy" });

  const res = await post(http, "/auth/login/verify", {
    flowId: owner.flowId,
    response: auth.authenticate(owner.options),
  });
  expect(res.status).toBe(200);
});

test("when every request resolves to 127.0.0.1 (a proxy hiding the client), a login-options flood is refused with 429 and the first pending login still verifies", async () => {
  const { http } = await startGated({ trustProxy: true });
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await enroll(http, auth);
  /** What an SNI passthrough without PROXY protocol hands the site nginx. */
  const hidden = () =>
    fetch(`${http}/auth/login/options`, {
      method: "POST",
      headers: {
        "x-real-ip": "127.0.0.1",
        "x-forwarded-for": "127.0.0.1",
      },
    });
  const owner = await (await hidden()).json();
  for (let i = 1; i < MAX_PENDING_CEREMONIES; i++)
    expect((await hidden()).status).toBe(200);
  for (let i = 0; i < 2 * MAX_PENDING_LOGINS_PER_CLIENT; i++) {
    const refused = await hidden();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "busy" });
  }

  const res = await post(http, "/auth/login/verify", {
    flowId: owner.flowId,
    response: auth.authenticate(owner.options),
  });
  expect(res.status).toBe(200);
});

test("the client address is the socket peer; forwarded headers count only from a trusted loopback proxy", () => {
  const forwarded = new Headers({
    "x-real-ip": "198.51.100.7",
    "x-forwarded-for": "203.0.113.1, 198.51.100.8",
  });
  // A peer that is not the local proxy cannot pick its own address.
  for (const trust of [true, false])
    expect(clientAddress("203.0.113.50", forwarded, trust)).toBe(
      "203.0.113.50",
    );
  // From a trusted proxy: X-Real-IP, else the hop it appended last to X-Forwarded-For.
  for (const proxy of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
    expect(clientAddress(proxy, forwarded, true)).toBe("198.51.100.7");
  expect(
    clientAddress(
      "127.0.0.1",
      new Headers({ "x-forwarded-for": "203.0.113.1, 198.51.100.8" }),
      true,
    ),
  ).toBe("198.51.100.8");
  // Without trustProxy the headers are ignored: behind a proxy that passes a
  // client's own X-Real-IP through, no request picks its own key.
  expect(clientAddress("127.0.0.1", forwarded, false)).toBeUndefined();
  // No usable client identity: loopback or unspecified, however it arrives.
  for (const hidden of [
    new Headers(),
    new Headers({ "x-real-ip": "127.0.0.1", "x-forwarded-for": "127.0.0.1" }),
    new Headers({ "x-forwarded-for": "203.0.113.1, 127.0.0.1" }),
    new Headers({ "x-real-ip": "::1" }),
    new Headers({ "x-real-ip": "0.0.0.0" }),
    new Headers({ "x-real-ip": "::ffff:127.0.0.9" }),
  ])
    expect(clientAddress("127.0.0.1", hidden, true)).toBeUndefined();
  expect(clientAddress("::", new Headers(), true)).toBeUndefined();
  expect(clientAddress(undefined, forwarded, true)).toBeUndefined();
});

test("an IPv6 client is keyed by its /64, and an IPv4-mapped one by its IPv4 address", () => {
  const none = new Headers();
  const key = clientAddress("2001:db8:1:2::5", none, false);
  expect(key).toBe("2001:db8:1:2::/64");
  for (const sibling of [
    "2001:db8:1:2:ffff:ffff:ffff:ffff",
    "2001:0DB8:0001:0002:0:0:0:1",
    "2001:db8:1:2::1.2.3.4",
    "2001:db8:1:2::9%eth0",
  ])
    expect(clientAddress(sibling, none, false)).toBe(key);
  expect(clientAddress("2001:db8:1:3::5", none, false)).not.toBe(key);
  expect(clientAddress("::ffff:198.51.100.7", none, false)).toBe(
    "198.51.100.7",
  );
  expect(clientAddress("::ffff:c633:6407", none, false)).toBe("198.51.100.7");
  // From a trusted proxy the forwarded address is keyed the same way.
  expect(
    clientAddress(
      "::1",
      new Headers({ "x-real-ip": "2001:db8:1:2:aaaa::1" }),
      true,
    ),
  ).toBe(key);
});
