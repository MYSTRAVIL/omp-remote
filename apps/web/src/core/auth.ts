import type {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { z } from "zod";

/**
 * Dependencies of the passkey flows, injected so the flows are testable without a
 * browser: the aggregator base URL, a `fetch`, and the two `@simplewebauthn/browser`
 * ceremony functions (which touch `navigator.credentials` only when actually called).
 */
export interface AuthDeps {
  baseUrl: string;
  fetch: typeof fetch;
  startRegistration: typeof startRegistration;
  startAuthentication: typeof startAuthentication;
}

// The aggregator returns a one-shot `flowId` bound to the challenge plus the raw
// WebAuthn options JSON. We validate the envelope; `options` is handed to the
// browser library, which does its own structural validation of the nested fields.
const OptionsEnvelope = z.object({
  flowId: z.string(),
  options: z.object({}).passthrough(),
});
const RegisterVerify = z.object({ verified: z.boolean() });
const LoginVerify = z.object({
  verified: z.boolean(),
  token: z.string().optional(),
});

/** Which sign-ins the relay offers right now; the sign-in screen shows only these. */
const SignInMethods = z.object({ password: z.boolean(), passkey: z.boolean() });
export type SignInMethods = z.infer<typeof SignInMethods>;
// A password sign-in answers as a passkey login does; 200 always carries a token.
const PasswordSignedIn = z.object({
  verified: z.literal(true),
  token: z.string(),
});
// The relay's 429 body for a client its password throttle has locked out.
const Throttled = z.object({ retryAfterSec: z.number().int().nonnegative() });

/** How a password sign-in went; `throttled` says how long until the next try. */
export type PasswordLoginResult =
  | { ok: true; token: string }
  /** Wrong password (or none set); the relay answers every such case alike. */
  | { ok: false; reason: "wrong-password" }
  /** Password sign-in is turned off on this relay. */
  | { ok: false; reason: "disabled" }
  /** Too many wrong tries: the relay takes the next one after `retryAfterSec`. */
  | { ok: false; reason: "throttled"; retryAfterSec: number };

/** POST JSON to the aggregator; `token` authorises the account routes. */
async function post(
  deps: AuthDeps,
  path: string,
  body?: unknown,
  token?: string,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return deps.fetch(`${deps.baseUrl}${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function postJson(
  deps: AuthDeps,
  path: string,
  body?: unknown,
): Promise<unknown> {
  return (await post(deps, path, body)).json();
}

/**
 * Which sign-ins the relay offers now: the password while it is on and set,
 * passkeys while the relay has an HTTPS address. Asked before anyone signs in.
 */
export async function authMethods(deps: AuthDeps): Promise<SignInMethods> {
  const res = await deps.fetch(`${deps.baseUrl}/auth/methods`);
  if (!res.ok)
    throw new Error(`the relay did not say how to sign in (${res.status})`);
  return SignInMethods.parse(await res.json());
}

/**
 * Sign in with the relay's password; the `/client` session token on success.
 * `remember` asks for a long-lived token, as a passkey login does.
 */
export async function loginPassword(
  deps: AuthDeps,
  password: string,
  remember = false,
): Promise<PasswordLoginResult> {
  const res = await post(deps, "/auth/login/password", { password, remember });
  if (res.status === 429) {
    const { retryAfterSec } = Throttled.parse(await res.json());
    return { ok: false, reason: "throttled", retryAfterSec };
  }
  if (res.status === 401) return { ok: false, reason: "wrong-password" };
  if (res.status === 403) return { ok: false, reason: "disabled" };
  if (!res.ok) throw new Error(`password sign-in failed (${res.status})`);
  const { token } = PasswordSignedIn.parse(await res.json());
  return { ok: true, token };
}

/**
 * Log in with an existing passkey; returns the `/client` session token on
 * success. `remember` asks the aggregator for a long-lived token so the device
 * can auto-connect on later opens without a fresh passkey tap.
 */
export async function loginPasskey(
  deps: AuthDeps,
  remember = false,
): Promise<{ verified: boolean; token?: string }> {
  const { flowId, options } = OptionsEnvelope.parse(
    await postJson(deps, "/auth/login/options"),
  );
  // Boundary cast: the validated envelope's `options` is the library's JSON type.
  const optionsJSON =
    options as unknown as PublicKeyCredentialRequestOptionsJSON;
  const response = await deps.startAuthentication({ optionsJSON });
  const result = LoginVerify.parse(
    await postJson(deps, "/auth/login/verify", { flowId, response, remember }),
  );
  // Never surface a token on a non-verified assertion.
  return result.verified
    ? { verified: true, token: result.token }
    : { verified: false };
}

/** One passkey registered with the relay, as Settings > Account lists it. */
const PasskeyEntry = z.object({
  id: z.string(),
  /** When it was registered, epoch ms; null for one the relay has no date for. */
  createdAt: z.number().nullable(),
  /** Its last sign-in or passkey check, epoch ms; null when none is recorded. */
  lastUsedAt: z.number().nullable(),
  /** It is the passkey this device signed in with. */
  current: z.boolean(),
});
export type Passkey = z.infer<typeof PasskeyEntry>;
const PasskeyList = z.object({ passkeys: z.array(PasskeyEntry) });
const Revoked = z.object({ revoked: z.literal(true), signedOut: z.boolean() });
const SignedOutEverywhere = z.object({ signedOut: z.literal(true) });

/** One machine the relay lets connect, as Settings > Account lists it. */
const MachineEntry = z.object({
  machineId: z.string(),
  /** When it joined, epoch ms. */
  joinedAt: z.number(),
  /** When the relay last saw it, epoch ms; absent when never seen. */
  lastSeenAt: z.number().optional(),
  /** Connected to the relay right now. */
  online: z.boolean(),
});
export type RelayMachine = z.infer<typeof MachineEntry>;
const MachineList = z.object({ machines: z.array(MachineEntry) });
const MachineRevoked = z.object({ revoked: z.literal(true) });
const PasswordSignInSet = z.object({ passwordSignIn: z.boolean() });

/**
 * The fresh check an account change carries. A passkey sign-in answers a
 * passkey prompt for exactly that change; a password sign-in gives the
 * password again.
 */
export type FreshCheck =
  | { kind: "passkey" }
  | { kind: "password"; password: string };

/** Why an account request did not go through; Settings says each in words. */
export type AccountFailure =
  /** The relay no longer accepts this device's sign-in (401). */
  | "signed-out"
  /** The passkey prompt was dismissed or failed, so nothing reached the relay. */
  | "passkey-check-incomplete"
  /** The relay rejected the fresh passkey check (403). */
  | "passkey-check-failed"
  /** The fresh check needs the password: this device signed in with it (403). */
  | "password-required"
  /** The password given for the fresh check is wrong (401). */
  | "wrong-password"
  /** Too many wrong passwords; `retryAfterSec` says when to try again (429). */
  | "throttled"
  /** Only a passkey sign-in may turn password sign-in off (403). */
  | "passkey-session-required"
  /** The relay has no such passkey or machine (404): it is already revoked. */
  | "not-found"
  /** It is the only passkey (409), which the relay never revokes. */
  | "last-passkey"
  /** The relay already holds as many passkeys as it allows (403). */
  | "credential-limit";

/** An account request the relay refused, or whose passkey check never finished. */
export class AccountError extends Error {
  readonly failure: AccountFailure;
  /** For `throttled`: seconds until the relay takes the next password. */
  readonly retryAfterSec: number | undefined;

  constructor(
    failure: AccountFailure,
    options?: ErrorOptions & { retryAfterSec?: number },
  ) {
    super(`account request failed: ${failure}`, options);
    this.failure = failure;
    this.retryAfterSec = options?.retryAfterSec;
  }
}

// The relay's refusal bodies on the account routes. A 401 without a known
// body means the session is gone. Any other refusal is not trusted as a
// known reason.
const AccountRefusalBody = z.object({
  error: z.enum([
    "passkey check failed",
    "password required",
    "wrong password",
    "passkey session required",
    "not found",
    "last passkey",
    "credential-limit",
  ]),
});
const ACCOUNT_REFUSALS: Record<
  z.infer<typeof AccountRefusalBody>["error"],
  AccountFailure
> = {
  "passkey check failed": "passkey-check-failed",
  "password required": "password-required",
  "wrong password": "wrong-password",
  "passkey session required": "passkey-session-required",
  "not found": "not-found",
  "last passkey": "last-passkey",
  "credential-limit": "credential-limit",
};

/** The body of an account route's answer; a refusal throws its `AccountError`. */
async function accountAnswer(res: Response): Promise<unknown> {
  if (res.ok) return res.json();
  const body: unknown = await res.json().catch(() => undefined);
  if (res.status === 429) {
    const throttled = Throttled.safeParse(body);
    if (throttled.success)
      throw new AccountError("throttled", {
        retryAfterSec: throttled.data.retryAfterSec,
      });
  }
  const refusal = AccountRefusalBody.safeParse(body);
  // A wrong step-up password is the one 401 that leaves the sign-in standing.
  if (res.status === 401)
    throw new AccountError(
      refusal.success && refusal.data.error === "wrong password"
        ? "wrong-password"
        : "signed-out",
    );
  if (refusal.success)
    throw new AccountError(ACCOUNT_REFUSALS[refusal.data.error]);
  throw new Error(`the relay refused an account request (${res.status})`);
}

/** GET an account route with this device's session token. */
async function accountGet(
  deps: AuthDeps,
  path: string,
  token: string,
): Promise<unknown> {
  const res = await deps.fetch(`${deps.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return accountAnswer(res);
}

/**
 * Every passkey registered with the relay, oldest first; `current` marks the
 * one `token` was issued for, i.e. the passkey this device signed in with.
 */
export async function listPasskeys(
  deps: AuthDeps,
  token: string,
): Promise<Passkey[]> {
  return PasskeyList.parse(
    await accountGet(deps, "/auth/account/passkeys", token),
  ).passkeys;
}

/** Every machine the relay lets connect. */
export async function listMachines(
  deps: AuthDeps,
  token: string,
): Promise<RelayMachine[]> {
  return MachineList.parse(
    await accountGet(deps, "/auth/account/machines", token),
  ).machines;
}

/** The one account change a fresh check is minted for. */
type AccountAction =
  | { action: "revoke"; credentialId: string }
  | { action: "sign-out-everywhere" }
  | { action: "register" }
  | { action: "password-sign-in"; enabled: boolean }
  | { action: "revoke-machine"; machineId: string };

/** The step-up fields a change request carries alongside its own. */
type StepUpFields =
  | { flowId: string; response: unknown }
  | { password: string };

/**
 * A fresh check for one account change. With the password, the request
 * carries it. With a passkey: a single-use challenge the relay mints for
 * exactly `action` and this sign-in, answered by the passkey ceremony; the
 * change request carries the answer, and the relay verifies it, and that it
 * is that change, before making it.
 */
async function freshCheck(
  deps: AuthDeps,
  token: string,
  action: AccountAction,
  check: FreshCheck,
): Promise<StepUpFields> {
  if (check.kind === "password") return { password: check.password };
  const { flowId, options } = OptionsEnvelope.parse(
    await accountAnswer(
      await post(deps, "/auth/account/challenge", action, token),
    ),
  );
  // Boundary cast: the validated envelope's `options` is the library's JSON type.
  const optionsJSON =
    options as unknown as PublicKeyCredentialRequestOptionsJSON;
  const response = await deps
    .startAuthentication({ optionsJSON })
    .catch((cause: unknown) => {
      // Dismissed, timed out or refused on the device: nothing reached the relay.
      throw new AccountError("passkey-check-incomplete", { cause });
    });
  return { flowId, response };
}

/**
 * Add a passkey to the relay (spec §7). It needs this device's sign-in and a
 * fresh check first; the relay then mints the registration the browser's
 * passkey prompt completes. `verified` once the relay has stored it.
 */
export async function registerPasskey(
  deps: AuthDeps,
  token: string,
  check: FreshCheck,
): Promise<{ verified: boolean }> {
  const stepUp = await freshCheck(deps, token, { action: "register" }, check);
  const { flowId, options } = OptionsEnvelope.parse(
    await accountAnswer(
      await post(deps, "/auth/register/options", stepUp, token),
    ),
  );
  // Boundary cast: the validated envelope's `options` is the library's JSON type.
  const optionsJSON =
    options as unknown as PublicKeyCredentialCreationOptionsJSON;
  const response = await deps.startRegistration({ optionsJSON });
  const { verified } = RegisterVerify.parse(
    await postJson(deps, "/auth/register/verify", { flowId, response }),
  );
  return { verified };
}

/**
 * Revoke a registered passkey after a fresh check. `signedOut` when it was
 * the passkey this device signed in with: the relay no longer accepts this
 * device's sign-in either.
 */
export async function revokePasskey(
  deps: AuthDeps,
  token: string,
  credentialId: string,
  check: FreshCheck,
): Promise<{ signedOut: boolean }> {
  const stepUp = await freshCheck(
    deps,
    token,
    { action: "revoke", credentialId },
    check,
  );
  const { signedOut } = Revoked.parse(
    await accountAnswer(
      await post(
        deps,
        "/auth/account/passkeys/revoke",
        { credentialId, ...stepUp },
        token,
      ),
    ),
  );
  return { signedOut };
}

/**
 * Stop a machine connecting to the relay, after a fresh check. It has to
 * join again to come back.
 */
export async function revokeMachine(
  deps: AuthDeps,
  token: string,
  machineId: string,
  check: FreshCheck,
): Promise<void> {
  const stepUp = await freshCheck(
    deps,
    token,
    { action: "revoke-machine", machineId },
    check,
  );
  MachineRevoked.parse(
    await accountAnswer(
      await post(
        deps,
        "/auth/account/machines/revoke",
        { machineId, ...stepUp },
        token,
      ),
    ),
  );
}

/**
 * Turn password sign-in on or off, after a fresh check; the setting the relay
 * now has. Turning it off needs a passkey sign-in and a registered passkey.
 */
export async function setPasswordSignIn(
  deps: AuthDeps,
  token: string,
  enabled: boolean,
  check: FreshCheck,
): Promise<boolean> {
  const stepUp = await freshCheck(
    deps,
    token,
    { action: "password-sign-in", enabled },
    check,
  );
  return PasswordSignInSet.parse(
    await accountAnswer(
      await post(
        deps,
        "/auth/account/password-sign-in",
        { enabled, ...stepUp },
        token,
      ),
    ),
  ).passwordSignIn;
}

/**
 * End every sign-in on every device, this one included, after a fresh
 * check: the relay stops accepting any session token issued before now.
 */
export async function signOutEverywhere(
  deps: AuthDeps,
  token: string,
  check: FreshCheck,
): Promise<void> {
  const stepUp = await freshCheck(
    deps,
    token,
    { action: "sign-out-everywhere" },
    check,
  );
  SignedOutEverywhere.parse(
    await accountAnswer(
      await post(deps, "/auth/account/sign-out-everywhere", stepUp, token),
    ),
  );
}

// A session token is `<payloadB64url>.<sigB64url>`; the payload is public JSON.
// We read only `exp` and `m` client-side: whether a remembered token is still
// worth presenting, and which fresh check Settings asks for. The aggregator
// remains the sole authority that verifies the signature and rejects a forged
// or expired token at connect time.
const ExpPayload = z.object({ exp: z.number() });
// `m` is absent from tokens issued before password sign-in: those are passkey ones.
const MethodPayload = z.object({ m: z.enum(["pk", "pw"]).default("pk") });

/** How this device signed in: with a passkey, or with the password. */
export type SessionMethod = "passkey" | "password";

/** A session token's unverified payload JSON, or `undefined` if it is malformed. */
function tokenPayload(token: string): unknown {
  const dot = token.indexOf(".");
  if (dot <= 0) return undefined;
  const b64 = token.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    return JSON.parse(atob(padded));
  } catch {
    return undefined;
  }
}

/**
 * The expiry of a session token as epoch milliseconds, or `undefined` if the
 * token is malformed. Reads the unverified payload — used only to skip a token
 * the browser already knows is expired, never as a trust decision.
 */
export function sessionTokenExpMs(token: string): number | undefined {
  const parsed = ExpPayload.safeParse(tokenPayload(token));
  return parsed.success ? parsed.data.exp * 1000 : undefined;
}

/**
 * How a session token's holder signed in, or `undefined` if the token is
 * malformed. Reads the unverified payload — it picks which fresh check to
 * offer; the relay still decides which one it accepts.
 */
export function sessionMethod(token: string): SessionMethod | undefined {
  const parsed = MethodPayload.safeParse(tokenPayload(token));
  if (!parsed.success) return undefined;
  return parsed.data.m === "pw" ? "password" : "passkey";
}

/** localStorage key for a "remember this device" session token. */
const TOKEN_KEY = "omp-remote.session-token";

/** The slice of `Storage` the remembered token uses; production passes `localStorage`. */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Keep the session token so the next visit reconnects without a passkey prompt. */
export function rememberSessionToken(
  storage: TokenStorage,
  token: string,
): void {
  storage.setItem(TOKEN_KEY, token);
}

/**
 * Drop the remembered token so the next visit starts at the sign-in screen:
 * sign-out, a login that chose not to be remembered, or a stale token.
 */
export function forgetSessionToken(storage: TokenStorage): void {
  storage.removeItem(TOKEN_KEY);
}

/** This device holds a remembered sign-in, expired or not. */
export function hasRememberedSessionToken(storage: TokenStorage): boolean {
  return storage.getItem(TOKEN_KEY) !== null;
}

/**
 * The remembered token while it is unexpired at `nowMs`, else `undefined`; a
 * stale or malformed one is forgotten rather than presented. The aggregator
 * still verifies the signature and can reject a token this lets through.
 */
export function restoreSessionToken(
  storage: TokenStorage,
  nowMs: number,
): string | undefined {
  const token = storage.getItem(TOKEN_KEY);
  if (token === null) return undefined;
  const exp = sessionTokenExpMs(token);
  if (exp !== undefined && exp > nowMs) return token;
  forgetSessionToken(storage);
  return undefined;
}
