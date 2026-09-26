import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/credential-store";
import {
  type SessionTokenPayload,
  verifySessionToken,
} from "../src/session-token";
import {
  type AccountAction,
  type AccountRequest,
  MAX_CREDENTIALS,
  MAX_PENDING_CEREMONIES,
  MAX_PENDING_LOGINS_PER_CLIENT,
  type StepUp,
  type WebAuthnConfig,
  WebAuthnGate,
} from "../src/webauthn";
import { writeCheapPassword } from "./helpers/password";
import { VirtualAuthenticator } from "./helpers/virtual-authenticator";

const RP_ID = "example.test";
const ORIGIN = "https://example.test";
const SECRET = "webauthn-gate-test-secret-0123456789";
const PASSWORD = "webauthn-gate-test-password";

/** The gate config but for its password file, which each gate keeps in its own directory. */
const CFG: Omit<WebAuthnConfig, "passwordPath"> = {
  publicUrl: ORIGIN,
  rpName: "omp-remote test",
  sessionSecret: SECRET,
  sessionTtlSec: 3600,
  rememberTtlSec: 2_592_000,
};

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A gate over a fresh store, PASSWORD set since epoch 0: before any sign-in. */
async function freshGate(now: () => number = Date.now): Promise<{
  gate: WebAuthnGate;
  store: CredentialStore;
}> {
  const dir = await mkdtemp(join(tmpdir(), "omp-webauthn-"));
  dirs.push(dir);
  const store = await CredentialStore.load(join(dir, "cred.json"));
  const passwordPath = join(dir, "password.json");
  await writeCheapPassword(passwordPath, PASSWORD, 0);
  return {
    gate: new WebAuthnGate({ ...CFG, passwordPath }, store, now),
    store,
  };
}

/** The address requests come from unless a test says otherwise. */
const CLIENT = "192.0.2.1";
const SIGN_OUT: AccountAction = { action: "sign-out-everywhere" };

/** `session` asking for an account action with `stepUp`, from CLIENT. */
function accountRequest(
  session: SessionTokenPayload,
  stepUp: StepUp,
): AccountRequest {
  return { session, stepUp, client: CLIENT };
}

/** A fresh password session asking for an account action, the password its step-up. */
async function ownerRequest(gate: WebAuthnGate): Promise<AccountRequest> {
  const signedIn = await gate.passwordLogin(PASSWORD, false, CLIENT);
  if (!signedIn.ok)
    throw new Error(`password sign-in refused: ${signedIn.reason}`);
  const session = await gate.verifySessionToken(signedIn.token);
  if (session === undefined) throw new Error("password session refused");
  return accountRequest(session, { password: PASSWORD });
}

/** Start a registration from a password session; throw on refusal. */
async function regOptions(gate: WebAuthnGate) {
  const res = await gate.registrationOptions(await ownerRequest(gate));
  if (!res.ok) throw new Error(`registration refused: ${res.reason}`);
  return res;
}

async function registerNew(
  gate: WebAuthnGate,
  auth: VirtualAuthenticator,
): Promise<void> {
  const { flowId, options } = await regOptions(gate);
  const result = await gate.verifyRegistration(flowId, auth.register(options));
  expect(result.verified).toBe(true);
}

/** Pad the store with placeholder credentials (never used to log in). */
async function fillStore(store: CredentialStore, count: number): Promise<void> {
  for (let i = 0; i < count; i++)
    await store.add({ id: `placeholder-${i}`, publicKey: "AA", counter: 0 });
}

/** Mint login options for `client`; throw if the gate refuses. */
async function loginOptions(gate: WebAuthnGate, client = CLIENT) {
  const minted = await gate.authenticationOptions(client);
  if (minted === undefined) throw new Error("login options refused");
  return minted;
}

/** Log in with `auth` and return the session its token carries. */
async function loginSession(
  gate: WebAuthnGate,
  auth: VirtualAuthenticator,
  credentialId?: string,
): Promise<SessionTokenPayload> {
  const { flowId, options } = await loginOptions(gate);
  const res = await gate.verifyAuthentication(
    flowId,
    auth.authenticate(options, credentialId),
  );
  const session = await gate.verifySessionToken(res.token ?? "");
  if (session === undefined) throw new Error("login failed");
  return session;
}

/** A step-up for `action` minted for `session`, asserted by `auth`. */
async function stepUpFor(
  gate: WebAuthnGate,
  action: AccountAction,
  session: SessionTokenPayload,
  auth: VirtualAuthenticator,
  credentialId?: string,
): Promise<StepUp> {
  const minted = await gate.stepUpOptions(action, session);
  if (minted === undefined) throw new Error("step-up refused");
  return {
    flowId: minted.flowId,
    response: auth.authenticate(minted.options, credentialId),
  };
}

test("register then authenticate issues a valid user-verified token", async () => {
  const { gate, store } = await freshGate();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, auth);
  expect(store.list()).toHaveLength(1);

  const { flowId, options } = await loginOptions(gate);
  const res = await gate.verifyAuthentication(
    flowId,
    auth.authenticate(options),
  );
  expect(res.verified).toBe(true);
  expect(res.token).toBeDefined();

  const payload = verifySessionToken(res.token ?? "", SECRET, Date.now());
  expect(payload?.sub).toBe(store.list()[0]?.id);
  expect(payload?.uv).toBe(true);
});

test("the signature counter advances after authentication", async () => {
  const { gate, store } = await freshGate();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, auth);
  expect(store.list()[0]?.counter).toBe(0);

  const { flowId, options } = await loginOptions(gate);
  await gate.verifyAuthentication(flowId, auth.authenticate(options));
  expect(store.list()[0]?.counter).toBe(1);
});

test("a step-up, like a login, advances the replay counter and stamps the passkey's last use", async () => {
  let clock = 1_700_000_000_000;
  const { gate, store } = await freshGate(() => clock);
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, auth);
  expect(store.list()[0]).toMatchObject({ counter: 0, createdAt: clock });

  clock += 60_000;
  const session = await loginSession(gate, auth);
  expect(store.list()[0]).toMatchObject({ counter: 1, lastUsedAt: clock });

  clock += 60_000;
  const signedOut = await gate.signOutEverywhere(
    accountRequest(session, await stepUpFor(gate, SIGN_OUT, session, auth)),
  );
  expect(signedOut).toEqual({ ok: true });
  expect(store.list()[0]).toMatchObject({ counter: 2, lastUsedAt: clock });
});

test("an unregistered credential cannot authenticate", async () => {
  const { gate } = await freshGate();
  // A different authenticator that this gate never registered.
  const registered = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, registered);

  const stranger = new VirtualAuthenticator(RP_ID, ORIGIN);
  // give the stranger a key of its own without registering it
  const { flowId, options } = await loginOptions(gate);
  const strangerReg = stranger.register({ challenge: "x" });
  const res = await gate.verifyAuthentication(
    flowId,
    stranger.authenticate(options, strangerReg.id),
  );
  expect(res.verified).toBe(false);
  expect(res.token).toBeUndefined();
});

test("a tampered assertion (corrupted signature) fails verification", async () => {
  const { gate } = await freshGate();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, auth);

  const { flowId, options } = await loginOptions(gate);
  const assertion = auth.authenticate(options);
  // flip a byte in the DER signature
  const sig = Buffer.from(assertion.response.signature, "base64url");
  const last = sig.length - 1;
  sig[last] = (sig[last] ?? 0) ^ 0xff;
  const tampered = {
    ...assertion,
    response: { ...assertion.response, signature: sig.toString("base64url") },
  };
  const res = await gate.verifyAuthentication(flowId, tampered);
  expect(res.verified).toBe(false);
  expect(res.token).toBeUndefined();
});

test("a consumed flowId cannot be reused (one-shot challenge)", async () => {
  const { gate } = await freshGate();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { flowId, options } = await regOptions(gate);
  expect(
    (await gate.verifyRegistration(flowId, auth.register(options))).verified,
  ).toBe(true);
  // second attempt with the same flowId is rejected
  const { options: opts2 } = await regOptions(gate);
  expect(
    (await gate.verifyRegistration(flowId, auth.register(opts2))).verified,
  ).toBe(false);
});

test("an expired challenge is rejected", async () => {
  let clock = 1_000_000;
  const { gate } = await freshGate(() => clock);
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { flowId, options } = await regOptions(gate);
  clock += 61_000; // past the 60s challenge TTL
  const res = await gate.verifyRegistration(flowId, auth.register(options));
  expect(res.verified).toBe(false);
});

test("an unknown flowId is rejected", async () => {
  const { gate } = await freshGate();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { options } = await regOptions(gate);
  const res = await gate.verifyRegistration(
    "no-such-flow",
    auth.register(options),
  );
  expect(res.verified).toBe(false);
});

test("a remembered login mints a longer-lived token", async () => {
  const { gate } = await freshGate();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, auth);

  const a = await loginOptions(gate);
  const shortRes = await gate.verifyAuthentication(
    a.flowId,
    auth.authenticate(a.options),
  );
  const b = await loginOptions(gate);
  const longRes = await gate.verifyAuthentication(
    b.flowId,
    auth.authenticate(b.options),
    true,
  );
  const now = Date.now();
  const shortTok = verifySessionToken(shortRes.token ?? "", SECRET, now);
  const longTok = verifySessionToken(longRes.token ?? "", SECRET, now);
  expect((shortTok?.exp ?? 0) - (shortTok?.iat ?? 0)).toBe(CFG.sessionTtlSec);
  expect((longTok?.exp ?? 0) - (longTok?.iat ?? 0)).toBe(CFG.rememberTtlSec);
});

test("registration stops at MAX_CREDENTIALS passkeys", async () => {
  const { gate, store } = await freshGate();
  await fillStore(store, MAX_CREDENTIALS - 1);
  // The last free slot can still be enrolled...
  await registerNew(gate, new VirtualAuthenticator(RP_ID, ORIGIN));
  expect(store.list()).toHaveLength(MAX_CREDENTIALS);
  // ...then enrolment is refused, and only a caller whose step-up passes
  // learns why.
  const request = await ownerRequest(gate);
  expect(await gate.registrationOptions(request)).toEqual({
    ok: false,
    reason: "credential-limit",
  });
  expect(
    await gate.registrationOptions({
      ...request,
      stepUp: { password: `${PASSWORD}x` },
    }),
  ).toEqual({ ok: false, reason: "wrong-password" });
});

test("a registration begun below the cap is refused if the cap fills before verify", async () => {
  const { gate, store } = await freshGate();
  await fillStore(store, MAX_CREDENTIALS - 1);
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { flowId, options } = await regOptions(gate);
  // Another ceremony takes the last slot before this one verifies.
  await store.add({ id: "late", publicKey: "AA", counter: 0 });

  const res = await gate.verifyRegistration(flowId, auth.register(options));
  expect(res.verified).toBe(false);
  expect(store.list()).toHaveLength(MAX_CREDENTIALS);
});

/**
 * Mint login options from fresh addresses, a client's full share each, until
 * `count` more ceremonies are pending. Returns the flows minted.
 */
async function floodLogins(
  gate: WebAuthnGate,
  count: number,
  prefix = "10.0.0.",
): Promise<string[]> {
  const flows: string[] = [];
  for (let c = 0; flows.length < count; c++)
    for (let i = 0; i < MAX_PENDING_LOGINS_PER_CLIENT; i++) {
      if (flows.length === count) break;
      const minted = await gate.authenticationOptions(`${prefix}${c}`);
      if (minted === undefined) throw new Error("flood refused");
      flows.push(minted.flowId);
    }
  return flows;
}

test("one client's login flood gives way only to itself: its own oldest logins are dropped, never another client's", async () => {
  const { gate } = await freshGate();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, auth);
  const owner = await loginOptions(gate, "198.51.100.7");
  const first = await loginOptions(gate, "203.0.113.9");
  let last = first;
  for (let i = 0; i < 2 * MAX_PENDING_CEREMONIES; i++)
    last = await loginOptions(gate, "203.0.113.9");
  expect(gate.pendingCeremonies).toBe(1 + MAX_PENDING_LOGINS_PER_CLIENT);

  const ownerLogin = await gate.verifyAuthentication(
    owner.flowId,
    auth.authenticate(owner.options),
  );
  expect(ownerLogin.verified).toBe(true);
  const evicted = await gate.verifyAuthentication(
    first.flowId,
    auth.authenticate(first.options),
  );
  expect(evicted.verified).toBe(false);
  const newest = await gate.verifyAuthentication(
    last.flowId,
    auth.authenticate(last.options),
  );
  expect(newest.verified).toBe(true);
});

test("with every slot held, a newcomer displaces the oldest login of the client holding the most, never another's lone login", async () => {
  const { gate } = await freshGate();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, auth);
  const owner = await loginOptions(gate, "198.51.100.7");
  await floodLogins(gate, MAX_PENDING_CEREMONIES - 1);
  expect(gate.pendingCeremonies).toBe(MAX_PENDING_CEREMONIES);

  const newcomer = await loginOptions(gate, "192.0.2.200");
  expect(gate.pendingCeremonies).toBe(MAX_PENDING_CEREMONIES);
  for (const flow of [owner, newcomer]) {
    const res = await gate.verifyAuthentication(
      flow.flowId,
      auth.authenticate(flow.options),
    );
    expect(res.verified).toBe(true);
  }
});

test("logins never cancel an enrolment or a step-up; a gated ceremony takes the oldest login's slot, and is refused when only gated ones are held", async () => {
  const { gate, store } = await freshGate();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, auth);
  const session = await loginSession(gate, auth);
  const enrolment = await regOptions(gate);
  const stepUp = await stepUpFor(gate, SIGN_OUT, session, auth);
  await floodLogins(gate, MAX_PENDING_CEREMONIES - 2);
  for (let i = 0; i < MAX_PENDING_CEREMONIES; i++)
    await gate.authenticationOptions(`172.16.0.${i}`);
  expect(gate.pendingCeremonies).toBe(MAX_PENDING_CEREMONIES);

  const second = new VirtualAuthenticator(RP_ID, ORIGIN);
  const enrolled = await gate.verifyRegistration(
    enrolment.flowId,
    second.register(enrolment.options),
  );
  expect(enrolled.verified).toBe(true);
  expect(store.list()).toHaveLength(2);
  expect(await gate.signOutEverywhere(accountRequest(session, stepUp))).toEqual(
    { ok: true },
  );

  // Enrolments fill every slot, each displacing a login...
  const fresh = await loginSession(gate, auth);
  for (let i = 0; i < MAX_PENDING_CEREMONIES; i++) await regOptions(gate);
  expect(gate.pendingCeremonies).toBe(MAX_PENDING_CEREMONIES);
  // ...then no gated ceremony gives way to another.
  expect(await gate.stepUpOptions(SIGN_OUT, fresh)).toBeUndefined();
  expect(await gate.registrationOptions(await ownerRequest(gate))).toEqual({
    ok: false,
    reason: "busy",
  });
  expect(await gate.authenticationOptions("192.0.2.201")).toBeUndefined();
});

test("expired ceremonies are swept when the next one is minted", async () => {
  let clock = 1_700_000_000_000;
  const { gate } = await freshGate(() => clock);
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, auth);
  const session = await loginSession(gate, auth);
  await floodLogins(gate, MAX_PENDING_CEREMONIES - 1);
  clock += 30_000;
  await stepUpFor(gate, SIGN_OUT, session, auth);
  expect(gate.pendingCeremonies).toBe(MAX_PENDING_CEREMONIES);

  clock += 31_000; // past the 60s TTL of all but the step-up
  await loginOptions(gate);
  expect(gate.pendingCeremonies).toBe(2);
});

test("a login begun before a sign out everywhere is refused a token when it completes after", async () => {
  const { gate, store } = await freshGate();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, auth);
  const { flowId, options } = await loginOptions(gate);
  await store.bumpTokenEpoch(); // what a sign out everywhere does
  const res = await gate.verifyAuthentication(
    flowId,
    auth.authenticate(options),
  );
  expect(res).toEqual({ verified: false });

  // A login begun after it is unaffected.
  expect(gate.isRevoked(await loginSession(gate, auth))).toBe(false);
});

test("a login whose assertion is being checked when sign out everywhere lands is refused a token", async () => {
  const { gate, store } = await freshGate();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, auth);
  const { flowId, options } = await loginOptions(gate);
  const assertion = auth.authenticate(options);

  // Hold the login inside its signature check until the epoch has moved.
  const checking = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const subtle = crypto.subtle;
  const realVerify = subtle.verify.bind(subtle);
  const held = spyOn(subtle, "verify").mockImplementationOnce(
    async (...args: Parameters<SubtleCrypto["verify"]>) => {
      checking.resolve();
      await release.promise;
      return realVerify(...args);
    },
  );
  try {
    const login = gate.verifyAuthentication(flowId, assertion);
    await checking.promise;
    await store.bumpTokenEpoch();
    release.resolve();
    expect(await login).toEqual({ verified: false });
  } finally {
    held.mockRestore();
  }
});

test("a step-up authorizes only the action, target, and session it was minted for", async () => {
  let clock = 1_700_000_000_000;
  const { gate, store } = await freshGate(() => clock);
  const a = new VirtualAuthenticator(RP_ID, ORIGIN);
  const b = new VirtualAuthenticator(RP_ID, ORIGIN);
  const c = new VirtualAuthenticator(RP_ID, ORIGIN);
  for (const auth of [a, b, c]) await registerNew(gate, auth);
  const [idA, idB] = store.list().map((cred) => cred.id);
  if (idA === undefined || idB === undefined) throw new Error("no passkeys");
  const session = await loginSession(gate, a);
  clock += 1_000; // a later sign-in with the same passkey: another session
  const sameSubject = await loginSession(gate, a);
  const otherSubject = await loginSession(gate, b);
  const revokeB: AccountAction = { action: "revoke", credentialId: idB };
  const mintRevokeB = () => stepUpFor(gate, revokeB, session, a);
  const refused = { ok: false, reason: "passkey-check-failed" } as const;

  // Minted to revoke B: not for revoking another passkey...
  expect(
    await gate.revokePasskey(idA, accountRequest(session, await mintRevokeB())),
  ).toEqual(refused);
  // ...nor for signing out everywhere...
  expect(
    await gate.signOutEverywhere(accountRequest(session, await mintRevokeB())),
  ).toEqual(refused);
  // ...nor for any other session, of this passkey or another.
  for (const other of [sameSubject, otherSubject])
    expect(
      await gate.revokePasskey(idB, accountRequest(other, await mintRevokeB())),
    ).toEqual(refused);
  // A sign-out step-up does not stand in for a revoke either.
  expect(
    await gate.revokePasskey(
      idB,
      accountRequest(session, await stepUpFor(gate, SIGN_OUT, session, a)),
    ),
  ).toEqual(refused);
  expect(store.list()).toHaveLength(3);
  expect(store.tokenEpoch).toBe(0);

  // Used as minted, it works.
  expect(
    await gate.revokePasskey(idB, accountRequest(session, await mintRevokeB())),
  ).toEqual({ ok: true });
  expect(store.get(idB)).toBeUndefined();
});

test("logins with no usable client address count as one client: once every slot is held, each new login, enrolment or step-up displaces the oldest of them", async () => {
  const { gate } = await freshGate();
  const auth = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerNew(gate, auth);
  const session = await loginSession(gate, auth);
  for (let i = 0; i < MAX_PENDING_CEREMONIES; i++)
    expect(await gate.authenticationOptions(undefined)).toBeDefined();

  const latest = await gate.authenticationOptions(undefined);
  if (latest === undefined) throw new Error("login options refused");
  expect(await gate.authenticationOptions("198.51.100.7")).toBeDefined();
  expect(await gate.stepUpOptions(SIGN_OUT, session)).toBeDefined();
  expect((await gate.registrationOptions(await ownerRequest(gate))).ok).toBe(
    true,
  );
  expect(gate.pendingCeremonies).toBe(MAX_PENDING_CEREMONIES);
  const res = await gate.verifyAuthentication(
    latest.flowId,
    auth.authenticate(latest.options),
  );
  expect(res.verified).toBe(true);
});

test("concurrent wrong passwords cannot outrun the throttle: only the five free tries and the one that starts the lockout are checked", async () => {
  const { gate } = await freshGate(() => 1_700_000_000_000);
  const checks = spyOn(Bun.password, "verify");
  try {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        gate.passwordLogin("not the password", false, CLIENT),
      ),
    );
    expect(checks).toHaveBeenCalledTimes(6);
    // The right password waits out the lockout like any other.
    expect(await gate.passwordLogin(PASSWORD, false, CLIENT)).toEqual({
      ok: false,
      reason: "throttled",
      retryAfterSec: 1,
    });
    expect(checks).toHaveBeenCalledTimes(6);
  } finally {
    checks.mockRestore();
  }
});

test("password step-ups count against the same per-client throttle as password sign-ins", async () => {
  const { gate, store } = await freshGate(() => 1_700_000_000_000);
  const wrong = {
    ...(await ownerRequest(gate)),
    stepUp: { password: "not the password" },
  };
  for (let i = 0; i < 5; i++)
    expect(await gate.signOutEverywhere(wrong)).toEqual({
      ok: false,
      reason: "wrong-password",
    });
  expect(await gate.signOutEverywhere(wrong)).toEqual({
    ok: false,
    reason: "throttled",
    retryAfterSec: 1,
  });
  expect(store.tokenEpoch).toBe(0);
  expect(await gate.passwordLogin(PASSWORD, false, CLIENT)).toEqual({
    ok: false,
    reason: "throttled",
    retryAfterSec: 1,
  });
  // Another client's tries are its own.
  expect((await gate.passwordLogin(PASSWORD, false, "198.51.100.7")).ok).toBe(
    true,
  );
});
