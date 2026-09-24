import { expect, test } from "bun:test";
import {
  AccountError,
  type AuthDeps,
  type FreshCheck,
  type TokenStorage,
  authMethods,
  forgetSessionToken,
  listMachines,
  listPasskeys,
  loginPasskey,
  loginPassword,
  registerPasskey,
  rememberSessionToken,
  restoreSessionToken,
  revokeMachine,
  revokePasskey,
  sessionMethod,
  sessionTokenExpMs,
  setPasswordSignIn,
  signOutEverywhere,
} from "../src/core/auth";

interface Call {
  path: string;
  method: string;
  /** The `Authorization` header sent, or null. */
  authorization: string | null;
  body: unknown;
}

/** A route answered with an explicit status (plain `routes` answer 200). */
interface Canned {
  status: number;
  body: unknown;
}

/** A fetch double: routes by pathname, records calls, returns canned JSON. */
function fakeFetch(
  routes: Record<string, unknown>,
  calls: Call[],
  statuses: Record<string, Canned> = {},
): AuthDeps["fetch"] {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({
      path,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const canned = statuses[path];
    const payload = canned ? canned.body : routes[path];
    const status = canned ? canned.status : payload === undefined ? 404 : 200;
    return new Response(JSON.stringify(payload ?? { error: "not found" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as AuthDeps["fetch"];
}

/** A registration ceremony double that fails the test if it is ever reached. */
const unreachableRegistration = (async () => {
  throw new Error("startRegistration must not run");
}) as unknown as AuthDeps["startRegistration"];
const unusedAuthentication = (async () => {
  throw new Error("unused");
}) as unknown as AuthDeps["startAuthentication"];

test("login returns the session token on a verified assertion", async () => {
  const calls: Call[] = [];
  const deps: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch(
      {
        "/auth/login/options": { flowId: "f2", options: { challenge: "d" } },
        "/auth/login/verify": { verified: true, token: "sess.tok.123" },
      },
      calls,
    ),
    startRegistration: (async () => {
      throw new Error("unused");
    }) as unknown as AuthDeps["startRegistration"],
    startAuthentication: (async (opts: { optionsJSON: unknown }) => {
      expect(opts.optionsJSON).toEqual({ challenge: "d" });
      return {
        id: "cred-1",
        rawId: "cred-1",
        response: {},
        type: "public-key",
      };
    }) as unknown as AuthDeps["startAuthentication"],
  };

  const result = await loginPasskey(deps);
  expect(result).toEqual({ verified: true, token: "sess.tok.123" });
  // Absent "remember me" is sent as an explicit false, not omitted.
  expect(calls[1]?.body).toMatchObject({ flowId: "f2", remember: false });
});

test("a failed assertion returns no token", async () => {
  const deps: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch(
      {
        "/auth/login/options": { flowId: "f3", options: {} },
        "/auth/login/verify": { verified: false },
      },
      [],
    ),
    startRegistration:
      (async () => ({})) as unknown as AuthDeps["startRegistration"],
    startAuthentication: (async () => ({
      id: "x",
      rawId: "x",
      response: {},
      type: "public-key",
    })) as unknown as AuthDeps["startAuthentication"],
  };
  const result = await loginPasskey(deps);
  expect(result.verified).toBe(false);
  expect(result.token).toBeUndefined();
});

test("a remembered login sends remember:true to the verify endpoint", async () => {
  const calls: Call[] = [];
  const deps: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch(
      {
        "/auth/login/options": { flowId: "f4", options: { challenge: "e" } },
        "/auth/login/verify": { verified: true, token: "sess.tok.remember" },
      },
      calls,
    ),
    startRegistration: (async () => {
      throw new Error("unused");
    }) as unknown as AuthDeps["startRegistration"],
    startAuthentication: (async () => ({
      id: "cred-1",
      rawId: "cred-1",
      response: {},
      type: "public-key",
    })) as unknown as AuthDeps["startAuthentication"],
  };

  const result = await loginPasskey(deps, true);
  expect(result.token).toBe("sess.tok.remember");
  expect(calls[1]?.body).toMatchObject({ flowId: "f4", remember: true });
});

test("sessionTokenExpMs reads exp from a token payload in milliseconds", () => {
  const exp = 1_800_000_000; // epoch seconds
  const payload = Buffer.from(
    JSON.stringify({ sub: "c", uv: true, iat: 1, exp }),
  ).toString("base64url");
  expect(sessionTokenExpMs(`${payload}.signature`)).toBe(exp * 1000);
});

test("sessionTokenExpMs returns undefined for a malformed or exp-less token", () => {
  const noExp = Buffer.from(JSON.stringify({ sub: "c", uv: true })).toString(
    "base64url",
  );
  for (const bad of ["", "no-dot", ".sig", "!!!.sig", `${noExp}.sig`])
    expect(sessionTokenExpMs(bad)).toBeUndefined();
});

/** A Map-backed `localStorage` stand-in that outlives any one visit. */
function tokenStorage(): TokenStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** A session token whose unverified payload expires at `exp` (epoch seconds). */
function tokenExpiring(exp: number): string {
  return `${Buffer.from(JSON.stringify({ sub: "c", exp })).toString("base64url")}.sig`;
}

test("signing out forgets the remembered token: the next visit restores nothing", () => {
  const storage = tokenStorage();
  const token = tokenExpiring(2_000_000_000);
  const now = 1_900_000_000_000;
  rememberSessionToken(storage, token);
  expect(restoreSessionToken(storage, now)).toBe(token);
  forgetSessionToken(storage);
  expect(restoreSessionToken(storage, now)).toBeUndefined();
});

test("an expired remembered token is cleared rather than restored", () => {
  const storage = tokenStorage();
  rememberSessionToken(storage, tokenExpiring(1_000));
  expect(restoreSessionToken(storage, 1_000_000)).toBeUndefined();
  // Cleared, not merely skipped: even a clock set back finds nothing.
  expect(restoreSessionToken(storage, 0)).toBeUndefined();
});

test("a malformed options response is rejected, not silently trusted", async () => {
  const deps: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch({ "/auth/login/options": { nope: true } }, []),
    startRegistration:
      (async () => ({})) as unknown as AuthDeps["startRegistration"],
    startAuthentication:
      (async () => ({})) as unknown as AuthDeps["startAuthentication"],
  };
  await expect(loginPasskey(deps)).rejects.toThrow();
});

const TOKEN = "sess.tok.account";
const BEARER = `Bearer ${TOKEN}`;
const CHALLENGE = { flowId: "f5", options: { challenge: "g" } };
const ASSERTION = {
  id: "cred-2",
  rawId: "cred-2",
  response: {},
  type: "public-key",
};

/**
 * A passkey prompt double: it checks it was handed the challenge's options
 * and notes how many relay calls came before it.
 */
function passkeyPrompt(
  calls: readonly Call[],
  shownAfter: number[],
): AuthDeps["startAuthentication"] {
  return (async (opts: { optionsJSON: unknown }) => {
    expect(opts.optionsJSON).toEqual(CHALLENGE.options);
    shownAfter.push(calls.length);
    return ASSERTION;
  }) as unknown as AuthDeps["startAuthentication"];
}

test("listing passkeys presents this device's token and parses the list", async () => {
  const calls: Call[] = [];
  const passkeys = [
    { id: "old", createdAt: null, lastUsedAt: null, current: false },
    { id: "mine", createdAt: 1_700_000_000_000, lastUsedAt: 1, current: true },
  ];
  const deps: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch({ "/auth/account/passkeys": { passkeys } }, calls),
    startRegistration: unreachableRegistration,
    startAuthentication: unusedAuthentication,
  };
  expect(await listPasskeys(deps, TOKEN)).toEqual(passkeys);
  expect(calls).toEqual([
    {
      path: "/auth/account/passkeys",
      method: "GET",
      authorization: BEARER,
      body: undefined,
    },
  ]);

  const malformed: AuthDeps = {
    ...deps,
    fetch: fakeFetch(
      { "/auth/account/passkeys": { passkeys: [{ id: "x" }] } },
      [],
    ),
  };
  await expect(listPasskeys(malformed, TOKEN)).rejects.toThrow();
});

test("revoking runs a fresh passkey check, then the revoke, and says whether this device signed out", async () => {
  for (const signedOut of [true, false]) {
    const calls: Call[] = [];
    const shownAfter: number[] = [];
    const deps: AuthDeps = {
      baseUrl: "https://rp.test",
      fetch: fakeFetch(
        {
          "/auth/account/challenge": CHALLENGE,
          "/auth/account/passkeys/revoke": { revoked: true, signedOut },
        },
        calls,
      ),
      startRegistration: unreachableRegistration,
      startAuthentication: passkeyPrompt(calls, shownAfter),
    };
    expect(await revokePasskey(deps, TOKEN, "cred-9", PASSKEY)).toEqual({
      signedOut,
    });
    // Challenge, then the passkey prompt, then the revoke carrying both.
    expect(calls.map((c) => [c.method, c.path, c.authorization])).toEqual([
      ["POST", "/auth/account/challenge", BEARER],
      ["POST", "/auth/account/passkeys/revoke", BEARER],
    ]);
    expect(shownAfter).toEqual([1]);
    // The challenge is asked for this revoke only.
    expect(calls[0]?.body).toEqual({
      action: "revoke",
      credentialId: "cred-9",
    });
    expect(calls[1]?.body).toEqual({
      credentialId: "cred-9",
      flowId: "f5",
      response: ASSERTION,
    });
  }
});

test("signing out everywhere runs the same fresh passkey check, then the sign-out", async () => {
  const calls: Call[] = [];
  const shownAfter: number[] = [];
  const deps: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch(
      {
        "/auth/account/challenge": CHALLENGE,
        "/auth/account/sign-out-everywhere": { signedOut: true },
      },
      calls,
    ),
    startRegistration: unreachableRegistration,
    startAuthentication: passkeyPrompt(calls, shownAfter),
  };
  await signOutEverywhere(deps, TOKEN, PASSKEY);
  expect(calls.map((c) => [c.method, c.path, c.authorization])).toEqual([
    ["POST", "/auth/account/challenge", BEARER],
    ["POST", "/auth/account/sign-out-everywhere", BEARER],
  ]);
  expect(shownAfter).toEqual([1]);
  expect(calls[0]?.body).toEqual({ action: "sign-out-everywhere" });
  expect(calls[1]?.body).toEqual({ flowId: "f5", response: ASSERTION });
});

test("each account refusal is reported as its reason", async () => {
  const refusals = [
    ["/auth/account/challenge", 401, { error: "unauthorized" }, "signed-out"],
    [
      "/auth/account/passkeys/revoke",
      403,
      { error: "passkey check failed" },
      "passkey-check-failed",
    ],
    ["/auth/account/passkeys/revoke", 404, { error: "not found" }, "not-found"],
    [
      "/auth/account/passkeys/revoke",
      409,
      { error: "last passkey" },
      "last-passkey",
    ],
  ] as const;
  for (const [path, status, body, failure] of refusals) {
    const deps: AuthDeps = {
      baseUrl: "https://rp.test",
      fetch: fakeFetch({ "/auth/account/challenge": CHALLENGE }, [], {
        [path]: { status, body },
      }),
      startRegistration: unreachableRegistration,
      startAuthentication: passkeyPrompt([], []),
    };
    const error = await revokePasskey(deps, TOKEN, "cred-9", PASSKEY).catch(
      (caught: unknown) => caught,
    );
    expect(error instanceof AccountError && error.failure).toBe(failure);
  }
});

test("a dismissed passkey prompt sends nothing to the relay", async () => {
  const calls: Call[] = [];
  const deps: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch({ "/auth/account/challenge": CHALLENGE }, calls),
    startRegistration: unreachableRegistration,
    startAuthentication: (async () => {
      throw new DOMException("The operation was cancelled.", "NotAllowedError");
    }) as unknown as AuthDeps["startAuthentication"],
  };
  const error = await signOutEverywhere(deps, TOKEN, PASSKEY).catch(
    (caught: unknown) => caught,
  );
  expect(error instanceof AccountError && error.failure).toBe(
    "passkey-check-incomplete",
  );
  expect(calls.map((c) => c.path)).toEqual(["/auth/account/challenge"]);
});

test("an unrecognised refusal or a malformed answer is rejected, not trusted", async () => {
  const answering = (statuses: Record<string, Canned>): AuthDeps => ({
    baseUrl: "https://rp.test",
    fetch: fakeFetch({ "/auth/account/challenge": CHALLENGE }, [], statuses),
    startRegistration: unreachableRegistration,
    startAuthentication: passkeyPrompt([], []),
  });
  const unknownRefusal = await revokePasskey(
    answering({
      "/auth/account/passkeys/revoke": {
        status: 409,
        body: { error: "other" },
      },
    }),
    TOKEN,
    "cred-9",
    PASSKEY,
  ).catch((caught: unknown) => caught);
  expect(unknownRefusal).toBeInstanceOf(Error);
  expect(unknownRefusal).not.toBeInstanceOf(AccountError);
  // A success that doesn't say what happened is not taken as a sign-out.
  await expect(
    signOutEverywhere(
      answering({
        "/auth/account/sign-out-everywhere": {
          status: 200,
          body: { signedOut: false },
        },
      }),
      TOKEN,
      PASSKEY,
    ),
  ).rejects.toThrow();
});

const PASSKEY: FreshCheck = { kind: "passkey" };
const PASSWORD: FreshCheck = { kind: "password", password: "correct horse" };
const NEW_PASSKEY = {
  id: "cred-new",
  rawId: "cred-new",
  response: {},
  type: "public-key",
};
/** A registration prompt double that checks it got the relay's options. */
const registrationPrompt = (async (opts: { optionsJSON: unknown }) => {
  expect(opts.optionsJSON).toEqual({ challenge: "c" });
  return NEW_PASSKEY;
}) as unknown as AuthDeps["startRegistration"];

test("the sign-in methods come from the relay, unauthenticated, and are parsed", async () => {
  const calls: Call[] = [];
  const deps: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch(
      { "/auth/methods": { password: true, passkey: false } },
      calls,
    ),
    startRegistration: unreachableRegistration,
    startAuthentication: unusedAuthentication,
  };
  expect(await authMethods(deps)).toEqual({ password: true, passkey: false });
  expect(calls).toEqual([
    {
      path: "/auth/methods",
      method: "GET",
      authorization: null,
      body: undefined,
    },
  ]);
  const malformed: AuthDeps = {
    ...deps,
    fetch: fakeFetch({ "/auth/methods": { password: "yes" } }, []),
  };
  await expect(authMethods(malformed)).rejects.toThrow();
});

test("a password sign-in returns the session token and sends the remember choice", async () => {
  const calls: Call[] = [];
  const deps: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch(
      { "/auth/login/password": { verified: true, token: "tok-pw" } },
      calls,
    ),
    startRegistration: unreachableRegistration,
    startAuthentication: unusedAuthentication,
  };
  expect(await loginPassword(deps, "hunter2hunter2", true)).toEqual({
    ok: true,
    token: "tok-pw",
  });
  expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
    [
      "POST",
      "/auth/login/password",
      { password: "hunter2hunter2", remember: true },
    ],
  ]);
});

test("a refused password sign-in says why, and a lockout says for how long", async () => {
  const answering = (status: number, body: unknown): AuthDeps => ({
    baseUrl: "https://rp.test",
    fetch: fakeFetch({}, [], { "/auth/login/password": { status, body } }),
    startRegistration: unreachableRegistration,
    startAuthentication: unusedAuthentication,
  });
  expect(await loginPassword(answering(401, { verified: false }), "x")).toEqual(
    { ok: false, reason: "wrong-password" },
  );
  expect(
    await loginPassword(
      answering(403, { error: "password sign-in disabled" }),
      "x",
    ),
  ).toEqual({ ok: false, reason: "disabled" });
  expect(
    await loginPassword(answering(429, { retryAfterSec: 32 }), "x"),
  ).toEqual({ ok: false, reason: "throttled", retryAfterSec: 32 });
  // Neither a failure the relay does not name nor a token-less 200 signs in.
  await expect(
    loginPassword(answering(500, { error: "internal error" }), "x"),
  ).rejects.toThrow();
  await expect(
    loginPassword(answering(200, { verified: false }), "x"),
  ).rejects.toThrow();
});

test("a password sign-in's fresh check is the password: no passkey prompt, and each change carries it", async () => {
  const calls: Call[] = [];
  const deps: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch(
      {
        "/auth/account/sign-out-everywhere": { signedOut: true },
        "/auth/account/passkeys/revoke": { revoked: true, signedOut: false },
        "/auth/account/machines/revoke": { revoked: true },
        "/auth/account/password-sign-in": { passwordSignIn: true },
        "/auth/register/options": { flowId: "f1", options: { challenge: "c" } },
        "/auth/register/verify": { verified: true },
      },
      calls,
    ),
    startRegistration: registrationPrompt,
    startAuthentication: unusedAuthentication,
  };
  const password = "correct horse";
  await signOutEverywhere(deps, TOKEN, PASSWORD);
  await revokePasskey(deps, TOKEN, "cred-9", PASSWORD);
  await revokeMachine(deps, TOKEN, "m-1", PASSWORD);
  expect(await setPasswordSignIn(deps, TOKEN, true, PASSWORD)).toBe(true);
  expect(await registerPasskey(deps, TOKEN, PASSWORD)).toEqual({
    verified: true,
  });
  expect(calls.map((c) => [c.path, c.authorization, c.body])).toEqual([
    ["/auth/account/sign-out-everywhere", BEARER, { password }],
    [
      "/auth/account/passkeys/revoke",
      BEARER,
      { credentialId: "cred-9", password },
    ],
    ["/auth/account/machines/revoke", BEARER, { machineId: "m-1", password }],
    ["/auth/account/password-sign-in", BEARER, { enabled: true, password }],
    ["/auth/register/options", BEARER, { password }],
    ["/auth/register/verify", null, { flowId: "f1", response: NEW_PASSKEY }],
  ]);
});

test("each passkey-checked change asks for a challenge minted for exactly that change", async () => {
  const calls: Call[] = [];
  const shownAfter: number[] = [];
  const deps: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch(
      {
        "/auth/account/challenge": CHALLENGE,
        "/auth/account/machines/revoke": { revoked: true },
        "/auth/account/password-sign-in": { passwordSignIn: false },
        "/auth/register/options": { flowId: "f1", options: { challenge: "c" } },
        "/auth/register/verify": { verified: true },
      },
      calls,
    ),
    startRegistration: registrationPrompt,
    startAuthentication: passkeyPrompt(calls, shownAfter),
  };
  await revokeMachine(deps, TOKEN, "m-1", PASSKEY);
  expect(await setPasswordSignIn(deps, TOKEN, false, PASSKEY)).toBe(false);
  expect(await registerPasskey(deps, TOKEN, PASSKEY)).toEqual({
    verified: true,
  });
  const stepUp = { flowId: "f5", response: ASSERTION };
  expect(calls.map((c) => [c.path, c.authorization, c.body])).toEqual([
    [
      "/auth/account/challenge",
      BEARER,
      { action: "revoke-machine", machineId: "m-1" },
    ],
    ["/auth/account/machines/revoke", BEARER, { machineId: "m-1", ...stepUp }],
    [
      "/auth/account/challenge",
      BEARER,
      { action: "password-sign-in", enabled: false },
    ],
    ["/auth/account/password-sign-in", BEARER, { enabled: false, ...stepUp }],
    ["/auth/account/challenge", BEARER, { action: "register" }],
    ["/auth/register/options", BEARER, stepUp],
    ["/auth/register/verify", null, { flowId: "f1", response: NEW_PASSKEY }],
  ]);
  // Each passkey prompt answers the challenge just minted, before the change.
  expect(shownAfter).toEqual([1, 3, 5]);
});

test("listing machines presents this device's token and parses the list", async () => {
  const calls: Call[] = [];
  const machines = [
    { machineId: "desk", joinedAt: 1, lastSeenAt: 2, online: true },
    { machineId: "nas", joinedAt: 3, online: false },
  ];
  const deps: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch({ "/auth/account/machines": { machines } }, calls),
    startRegistration: unreachableRegistration,
    startAuthentication: unusedAuthentication,
  };
  expect(await listMachines(deps, TOKEN)).toEqual(machines);
  expect(calls.map((c) => [c.method, c.path, c.authorization])).toEqual([
    ["GET", "/auth/account/machines", BEARER],
  ]);
  const malformed: AuthDeps = {
    ...deps,
    fetch: fakeFetch({ "/auth/account/machines": { machines: [{}] } }, []),
  };
  await expect(listMachines(malformed, TOKEN)).rejects.toThrow();
});

test("a wrong step-up password leaves the sign-in standing; the other refusals say why", async () => {
  const refusals = [
    [401, { error: "wrong password" }, "wrong-password"],
    [401, { error: "unauthorized" }, "signed-out"],
    [403, { error: "password required" }, "password-required"],
    [403, { error: "passkey session required" }, "passkey-session-required"],
    [403, { error: "credential-limit" }, "credential-limit"],
    [404, { error: "not found" }, "not-found"],
  ] as const;
  for (const [status, body, failure] of refusals) {
    const deps: AuthDeps = {
      baseUrl: "https://rp.test",
      fetch: fakeFetch({}, [], {
        "/auth/account/password-sign-in": { status, body },
      }),
      startRegistration: unreachableRegistration,
      startAuthentication: unusedAuthentication,
    };
    const error = await setPasswordSignIn(deps, TOKEN, false, PASSWORD).catch(
      (caught: unknown) => caught,
    );
    expect(error instanceof AccountError && error.failure).toBe(failure);
  }
  const locked: AuthDeps = {
    baseUrl: "https://rp.test",
    fetch: fakeFetch({}, [], {
      "/auth/account/machines/revoke": {
        status: 429,
        body: { retryAfterSec: 8 },
      },
    }),
    startRegistration: unreachableRegistration,
    startAuthentication: unusedAuthentication,
  };
  const error = await revokeMachine(locked, TOKEN, "m-1", PASSWORD).catch(
    (caught: unknown) => caught,
  );
  expect(
    error instanceof AccountError && [error.failure, error.retryAfterSec],
  ).toEqual(["throttled", 8]);
});

test("sessionMethod reads how the token's holder signed in", () => {
  const token = (payload: object): string =>
    `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  expect(sessionMethod(token({ sub: "owner", m: "pw" }))).toBe("password");
  expect(sessionMethod(token({ sub: "cred", m: "pk" }))).toBe("passkey");
  // A token from before password sign-in carries no `m`: it is a passkey one.
  expect(sessionMethod(token({ sub: "cred" }))).toBe("passkey");
  expect(sessionMethod("garbage")).toBeUndefined();
});
