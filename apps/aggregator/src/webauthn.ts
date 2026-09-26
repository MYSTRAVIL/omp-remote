import { randomBytes } from "node:crypto";
import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { z } from "zod";
import { CredentialStore, type StoredCredential } from "./credential-store";
import { oldestOfLargestShare } from "./largest-share";
import { LoginThrottle } from "./login-throttle";
import { type PasswordFile, readPassword } from "./password";
import {
  PASSWORD_SUBJECT,
  type SessionTokenPayload,
  signSessionToken,
  verifySessionToken,
} from "./session-token";

/** Static access-gate config: the relying party, the password file, and token lifetimes. */
export interface WebAuthnConfig {
  /**
   * The HTTPS URL the phone opens the app at. Set, passkeys are on: the RP ID
   * is its hostname and the expected ceremony origin is its origin (the URL
   * without a trailing slash). Unset, the passkey ceremonies are off and the
   * owner signs in with the password alone.
   */
  publicUrl?: string;
  /** User-visible relying-party name. */
  rpName: string;
  /** HMAC secret used to sign issued session tokens. */
  sessionSecret: string;
  /** Default session-token lifetime in seconds (a login without "remember me"). */
  sessionTtlSec: number;
  /** Session-token lifetime for a "remember this device" login, in seconds. */
  rememberTtlSec: number;
  /**
   * The owner's password file (see `password.ts`). Read afresh at every check,
   * so a password set since — by any process — takes effect at once.
   */
  passwordPath: string;
}

/** Most passkeys the gate will hold; registration refuses once it is reached. */
export const MAX_CREDENTIALS = 20;

/** Which sign-ins work right now: what the login screen offers. */
export interface SignInMethods {
  /** Password sign-in is on and a password is set. */
  password: boolean;
  /** Passkeys are on (a `publicUrl` is configured). */
  passkey: boolean;
}

/**
 * Proof of a fresh check for one account action. A passkey session brings a
 * passkey assertion (`response`) over the challenge `stepUpOptions` minted
 * for that action (`flowId`); a password session brings the password.
 */
export type StepUp =
  | { flowId: string; response: unknown }
  | { password: string };

/**
 * One account request: the session asking, the step-up it carries (undefined:
 * none), and the address it came from — the server's `clientAddress`,
 * undefined when none is usable — on which password tries are throttled.
 */
export interface AccountRequest {
  session: SessionTokenPayload;
  stepUp: StepUp | undefined;
  client: string | undefined;
}

/**
 * Why a password was refused: it was wrong (or none is set), or this client
 * failed too often and may try again only after `retryAfterSec`.
 */
export type PasswordRefusal =
  | { ok: false; reason: "wrong-password" }
  | { ok: false; reason: "throttled"; retryAfterSec: number };

/**
 * Why a step-up failed: a passkey session's assertion was missing or did not
 * pass for this action and session, a password session sent no password, or
 * the password was refused.
 */
export type StepUpRefusal =
  | { ok: false; reason: "passkey-check-failed" | "password-required" }
  | PasswordRefusal;

/**
 * Why `registrationOptions` refused, beyond a failed step-up. `busy`: every
 * pending-ceremony slot is held by enrolments and step-ups under way.
 */
export type RegistrationRefusal = "credential-limit" | "busy";

export type RegistrationOptionsResult =
  | {
      ok: true;
      flowId: string;
      options: PublicKeyCredentialCreationOptionsJSON;
    }
  | StepUpRefusal
  | { ok: false; reason: RegistrationRefusal };

/**
 * A password sign-in: its token, or why none — a refused password, password
 * sign-in turned off, or a sign-out-everywhere that landed while the password
 * was being checked.
 */
export type PasswordLoginResult =
  | { ok: true; token: string }
  | PasswordRefusal
  | { ok: false; reason: "disabled" | "signed-out-everywhere" };

/** A registered passkey as the account screen lists it — no key material. */
export interface PasskeySummary {
  id: string;
  /** Registration time, epoch ms; null for a passkey enrolled before it was recorded. */
  createdAt: number | null;
  /** Last login or step-up with it, epoch ms; null if none was recorded. */
  lastUsedAt: number | null;
  /** Whether the caller's session token was issued for this passkey. */
  current: boolean;
}

/** Assertion options minted for one ceremony, under the flowId that ends it. */
export interface AssertionOptions {
  flowId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

/**
 * The account action a step-up is minted for — and so the only one it can
 * authorize: revoking one named passkey, signing out everywhere, starting a
 * passkey registration, turning password sign-in on or off, or revoking one
 * named machine's `/agent` token.
 */
export type AccountAction =
  | { action: "revoke"; credentialId: string }
  | { action: "sign-out-everywhere" }
  | { action: "register" }
  | { action: "password-sign-in"; enabled: boolean }
  | { action: "revoke-machine"; machineId: string };

/** Why `revokePasskey` refused, beyond a failed step-up, in the order its checks run. */
export type RevokeRefusal = "not-found" | "last-passkey";

export type RevokeResult =
  | { ok: true }
  | StepUpRefusal
  | { ok: false; reason: RevokeRefusal };

export type SignOutResult = { ok: true } | StepUpRefusal;

export type PasswordSignInResult =
  | { ok: true }
  | StepUpRefusal
  | { ok: false; reason: "passkey-session-required" };

/** How long a minted challenge stays usable, in ms (matches the WebAuthn timeout). */
const CHALLENGE_TTL_MS = 60_000;
/** A single-user relay has a few ceremonies in flight; 256 bounds what a login-options flood can hold. */
export const MAX_PENDING_CEREMONIES = 256;
/**
 * Most logins one client address may have pending; its next one displaces its
 * own oldest. A person signs in from one address with a retry or two; 16
 * leaves room for a household behind one NAT.
 */
export const MAX_PENDING_LOGINS_PER_CLIENT = 16;

/** Where passkey ceremonies run: the RP ID and the origin a ceremony must come from. */
interface RelyingParty {
  rpID: string;
  origin: string;
}

/**
 * What a pending flow was minted for; a flow is consumable only by its own
 * kind, so a step-up never logs in, and vice versa. A login records the client
 * address that asked (its share of the pending slots; undefined when the
 * request carried no usable address) and the token epoch it began under (a
 * sign-out-everywhere since ends it). A step-up records the one action it may
 * authorize and the session that asked for it.
 */
type Ceremony =
  | { kind: "register" }
  | { kind: "authenticate"; client: string | undefined; epoch: number }
  | { kind: "stepup"; action: AccountAction; session: SessionTokenPayload };

type PendingCeremony = Ceremony & { challenge: string; expiresAt: number };

/** An assertion that verified: the passkey that made it, and what it reported. */
interface Assertion {
  credentialId: string;
  newCounter: number;
  userVerified: boolean;
}

/**
 * A step-up that passed, with the passkey assertion that passed it (undefined
 * for a password, which leaves nothing to record) — or why it failed.
 */
type StepUpCheck =
  | { ok: true; assertion: Assertion | undefined }
  | StepUpRefusal;

// The response shapes the browser posts back. We Zod-parse at the boundary —
// validating the nested fields `@simplewebauthn` needs — then hand the parsed
// value to it for the real cryptographic verification. `.passthrough()` keeps
// optional fields the library may also read.
const RegistrationResponse = z
  .object({
    id: z.string(),
    rawId: z.string(),
    type: z.string(),
    response: z
      .object({
        clientDataJSON: z.string(),
        attestationObject: z.string(),
      })
      .passthrough(),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
const AuthenticationResponse = z
  .object({
    id: z.string(),
    rawId: z.string(),
    type: z.string(),
    response: z
      .object({
        clientDataJSON: z.string(),
        authenticatorData: z.string(),
        signature: z.string(),
      })
      .passthrough(),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

/**
 * The aggregator's access gate (spec §7). The owner signs in with the password
 * or, when a `publicUrl` is configured, with a passkey: registration and
 * authentication ceremonies run against `@simplewebauthn/server`, and public
 * credentials persist in a 0600 store. Either sign-in mints a short-lived HMAC
 * session token saying which it was. The gate also runs the account actions —
 * adding or revoking a passkey, signing out everywhere, turning password
 * sign-in on or off — each behind a fresh step-up: a user-verified assertion
 * for a passkey session, the password for a password session. This is the
 * aggregator's ONE plaintext role: it decides *who may open a `/client`
 * socket*, never *what flows through it*.
 */
export class WebAuthnGate {
  readonly #cfg: WebAuthnConfig;
  /** Where passkey ceremonies run; undefined while passkeys are off. */
  readonly #rp: RelyingParty | undefined;
  readonly #store: CredentialStore;
  /**
   * Minted, unconsumed ceremonies by flowId, oldest first. Bounded: expired
   * ones are swept on every mint, and at most
   * {@link MAX_PENDING_CEREMONIES} are held (see `#makeRoom`).
   */
  readonly #pending = new Map<string, PendingCeremony>();
  /** Password guesses per client address, at sign-in and step-up alike. */
  readonly #throttle = new LoginThrottle();
  readonly #now: () => number;

  constructor(
    cfg: WebAuthnConfig,
    store: CredentialStore,
    now: () => number = Date.now,
  ) {
    this.#cfg = cfg;
    const url =
      cfg.publicUrl === undefined ? undefined : new URL(cfg.publicUrl);
    // `origin` is the URL without its path, so without a trailing slash, and in
    // the canonical form a browser puts in the ceremony's client data.
    this.#rp = url && { rpID: url.hostname, origin: url.origin };
    this.#store = store;
    this.#now = now;
  }

  /** Ceremonies pending right now, expired ones not yet swept included (tests/metrics). */
  get pendingCeremonies(): number {
    return this.#pending.size;
  }

  /** Whether passkeys are on: a `publicUrl` is configured, so passkey ceremonies run. */
  get passkeysOn(): boolean {
    return this.#rp !== undefined;
  }

  /**
   * Whether the owner may sign in with the password: unless it was turned off
   * — and even then while passkeys are off, since nothing else could sign in.
   */
  get passwordSignIn(): boolean {
    return this.#store.passwordSignIn || this.#rp === undefined;
  }

  /** Which sign-ins work now: the password while it is on and set, passkeys while on. */
  async methods(): Promise<SignInMethods> {
    return {
      password: this.passwordSignIn && (await this.#password()) !== undefined,
      passkey: this.passkeysOn,
    };
  }

  /**
   * Start a registration ceremony for `req`'s session, behind a fresh step-up
   * minted for registering (a passkey session's) or the password (a password
   * session's). No challenge is minted unless the step-up passes and the store
   * is below {@link MAX_CREDENTIALS}; the cap is checked only after the
   * step-up, so a caller without one learns nothing about the stored
   * credentials. Passkeys must be on: the server routes here only then.
   * Rejects if the store cannot record the step-up's use.
   */
  async registrationOptions(
    req: AccountRequest,
  ): Promise<RegistrationOptionsResult> {
    const rp = this.#relyingParty();
    const checked = await this.#stepUp(req, { action: "register" });
    if (!checked.ok) return checked;
    const used = this.#recordUse(checked.assertion);
    if (used === undefined)
      return { ok: false, reason: "passkey-check-failed" };
    await used;
    if (this.#store.list().length >= MAX_CREDENTIALS)
      return { ok: false, reason: "credential-limit" };
    const options = await generateRegistrationOptions({
      rpName: this.#cfg.rpName,
      rpID: rp.rpID,
      userName: this.#store.userName,
      userID: new Uint8Array(Buffer.from(this.#store.userId, "base64url")),
      attestationType: "none",
      excludeCredentials: this.#store.list().map((c) => ({
        id: c.id,
        transports: c.transports,
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    const flowId = this.#mint(options.challenge, { kind: "register" });
    if (flowId === undefined) return { ok: false, reason: "busy" };
    return { ok: true, flowId, options };
  }

  async verifyRegistration(
    flowId: string,
    response: unknown,
  ): Promise<{ verified: boolean }> {
    const flow = this.#take(flowId);
    if (flow?.kind !== "register") return { verified: false };
    const parsed = RegistrationResponse.safeParse(response);
    if (!parsed.success) return { verified: false };

    const rp = this.#relyingParty();
    const verification = await verifyRegistrationResponse({
      // Zod-validated above; cast to the library's JSON type at this boundary.
      response: parsed.data as unknown as Parameters<
        typeof verifyRegistrationResponse
      >[0]["response"],
      expectedChallenge: flow.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
    if (!verification.verified) return { verified: false };

    const { credential } = verification.registrationInfo;
    // Re-check the cap here, synchronously before the add: other ceremonies may
    // have completed since this flow's options were issued.
    if (this.#store.list().length >= MAX_CREDENTIALS)
      return { verified: false };
    await this.#store.add({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports,
      createdAt: this.#now(),
    });
    return { verified: true };
  }

  /**
   * Start a login for the client at address `client` (undefined: no usable
   * address is known) — undefined, minting nothing, when no pending slot can
   * be made for it (see `#makeRoom`). The login remembers the token epoch it
   * began under. Passkeys must be on: the server routes here only then.
   */
  async authenticationOptions(
    client: string | undefined,
  ): Promise<AssertionOptions | undefined> {
    return this.#assertionOptions({
      kind: "authenticate",
      client,
      epoch: this.#store.tokenEpoch,
    });
  }

  /**
   * Finish a login, issuing a passkey session token for the passkey that
   * asserted. No token when the flow is not a live login, the assertion fails,
   * or the token epoch has moved since the login began: a sign-out-everywhere
   * landing while it was in flight ends it too, rather than letting it sign in
   * anew.
   */
  async verifyAuthentication(
    flowId: string,
    response: unknown,
    remember = false,
  ): Promise<{ verified: boolean; token?: string }> {
    const flow = this.#take(flowId);
    if (flow?.kind !== "authenticate") return { verified: false };
    const asserted = await this.#checkAssertion(flow.challenge, response);
    if (asserted === undefined) return { verified: false };
    const used = this.#recordUse(asserted);
    if (used === undefined) return { verified: false };
    await used;
    // Nothing awaits from this check to the signing below.
    if (this.#store.tokenEpoch !== flow.epoch) return { verified: false };
    const token = signSessionToken(
      {
        sub: asserted.credentialId,
        uv: asserted.userVerified,
        ep: flow.epoch,
        m: "pk",
      },
      this.#cfg.sessionSecret,
      {
        now: this.#now(),
        ttlSec: remember ? this.#cfg.rememberTtlSec : this.#cfg.sessionTtlSec,
      },
    );
    return { verified: true, token };
  }

  /**
   * Sign in with the owner's password from the client at `client` (see
   * {@link AccountRequest}), issuing a password session token. Refused while
   * password sign-in is off; throttled per client; and, like a passkey login,
   * refused its token when a sign-out-everywhere lands while the password is
   * being checked. A wrong password and no password set are the same refusal.
   */
  async passwordLogin(
    password: string,
    remember: boolean,
    client: string | undefined,
  ): Promise<PasswordLoginResult> {
    if (!this.passwordSignIn) return { ok: false, reason: "disabled" };
    const epoch = this.#store.tokenEpoch;
    const checked = await this.#checkPassword(password, client);
    if (!checked.ok) return checked;
    // Nothing awaits from these checks to the signing below.
    if (!this.passwordSignIn) return { ok: false, reason: "disabled" };
    if (this.#store.tokenEpoch !== epoch)
      return { ok: false, reason: "signed-out-everywhere" };
    const token = signSessionToken(
      { sub: PASSWORD_SUBJECT, uv: false, ep: epoch, m: "pw" },
      this.#cfg.sessionSecret,
      {
        now: this.#now(),
        ttlSec: remember ? this.#cfg.rememberTtlSec : this.#cfg.sessionTtlSec,
      },
    );
    return { ok: true, token };
  }

  /**
   * Verify a session token against this gate's secret, clock, store, and
   * password file — the single check behind push, pairing, and account access.
   * Returns the payload, or undefined if the token is missing, malformed,
   * forged, expired, or signed out (see {@link isSignedOut}).
   */
  async verifySessionToken(
    raw: string,
  ): Promise<SessionTokenPayload | undefined> {
    const session = this.authenticSession(raw);
    if (session === undefined || (await this.isSignedOut(session)))
      return undefined;
    return session;
  }

  /**
   * The session an authentic token carries — signed with this gate's secret and
   * unexpired by its clock — whether or not it has been signed out since. Only
   * the `/client` upgrade takes this: it lets a signed-out sign-in in just to
   * close it as signed out (see {@link isSignedOut}), since a browser cannot
   * read the status of a refused upgrade. Everything else uses
   * {@link verifySessionToken}.
   */
  authenticSession(raw: string): SessionTokenPayload | undefined {
    return verifySessionToken(raw, this.#cfg.sessionSecret, this.#now());
  }

  /**
   * Whether an authentic session was revoked by a change in the store since it
   * was issued: it was signed under an earlier token epoch (a
   * sign-out-everywhere since; a token without `ep` counts as epoch 0), its
   * passkey is no longer registered, or — for a password session — password
   * sign-in is off, or was turned off after the session was issued (turning
   * it back on revives none). Synchronous, so the server can close the
   * sockets a change revoked the moment it lands.
   */
  isRevoked(session: SessionTokenPayload): boolean {
    if ((session.ep ?? 0) !== this.#store.tokenEpoch) return true;
    return session.m === "pw"
      ? !this.passwordSignIn ||
          session.iat * 1000 < this.#store.passwordSignInOffAt
      : this.#store.get(session.sub) === undefined;
  }

  /**
   * Whether an authentic session is signed out now: revoked (see
   * {@link isRevoked}), or a password session no longer backed by the password
   * — none is set, or the one set was set after the session was issued
   * (`iat * 1000 < setAt`). Changing the password so signs out every password
   * session; since a password is changed outside this process, an open socket
   * learns it only at the server's next recheck (see {@link hasEnded}).
   */
  async isSignedOut(session: SessionTokenPayload): Promise<boolean> {
    if (this.isRevoked(session)) return true;
    if (session.m !== "pw") return false;
    const password = await this.#password();
    return password === undefined || session.iat * 1000 < password.setAt;
  }

  /**
   * Whether an open socket's session has ended: its token expired at the
   * gate's clock, or it is signed out now (see {@link isSignedOut}).
   */
  async hasEnded(session: SessionTokenPayload): Promise<boolean> {
    if (Math.floor(this.#now() / 1000) >= session.exp) return true;
    return this.isSignedOut(session);
  }

  /**
   * Every registered passkey, oldest first (undated ones ahead of all dated
   * ones), marking the one `currentSub` — the caller's token subject — names.
   */
  passkeys(currentSub: string): PasskeySummary[] {
    return this.#store
      .list()
      .toSorted(byCreatedAt)
      .map((c) => ({
        id: c.id,
        createdAt: c.createdAt ?? null,
        lastUsedAt: c.lastUsedAt ?? null,
        current: c.id === currentSub,
      }));
  }

  /**
   * Start a passkey step-up ceremony: a discoverable, user-verified assertion
   * that authorizes ONE account action — `action`, asked for by `session` —
   * and nothing else. Only an account action consumes its `stepup` flow, and
   * only that action (a revoke, for that passkey; a password sign-in change,
   * to that setting) by that session; a login never does, and a login flow
   * never stands in for it. Undefined, minting nothing, when no pending slot
   * can be made for it. Passkeys must be on: the server routes here only then.
   */
  async stepUpOptions(
    action: AccountAction,
    session: SessionTokenPayload,
  ): Promise<AssertionOptions | undefined> {
    return this.#assertionOptions({ kind: "stepup", action, session });
  }

  /**
   * Revoke a passkey behind a fresh step-up for revoking exactly it, by `req`'s
   * session. Checks run in order: the step-up, then that `credentialId` is
   * registered, then that it is not the last passkey (the account must stay
   * reachable). Its tokens stop verifying at once. Rejects if the store cannot
   * write the change, which it then undoes.
   */
  async revokePasskey(
    credentialId: string,
    req: AccountRequest,
  ): Promise<RevokeResult> {
    const checked = await this.#stepUp(req, { action: "revoke", credentialId });
    if (!checked.ok) return checked;
    // Nothing awaits from here until every change is made: the guards see the
    // store just as the removal changes it, so two concurrent revokes cannot
    // both pass the last-passkey guard; and the step-up's use and the removal
    // land in one write — or, if it fails, are both undone.
    const used = this.#recordUse(checked.assertion);
    if (used === undefined)
      return { ok: false, reason: "passkey-check-failed" };
    const credentials = this.#store.list();
    if (!credentials.some((c) => c.id === credentialId)) {
      await used;
      return { ok: false, reason: "not-found" };
    }
    if (credentials.length === 1) {
      await used;
      return { ok: false, reason: "last-passkey" };
    }
    await Promise.all([used, this.#store.remove(credentialId)]);
    return { ok: true };
  }

  /**
   * Sign out everywhere behind a fresh step-up for it by `req`'s session: bump
   * the token epoch, so every token issued so far — the caller's included —
   * stops verifying, and every login still in flight is refused its token.
   * Nothing changes when the step-up fails. Rejects if the store cannot write
   * the change, which it then undoes.
   */
  async signOutEverywhere(req: AccountRequest): Promise<SignOutResult> {
    const checked = await this.#stepUp(req, { action: "sign-out-everywhere" });
    if (!checked.ok) return checked;
    const used = this.#recordUse(checked.assertion);
    if (used === undefined)
      return { ok: false, reason: "passkey-check-failed" };
    // The step-up's use and the bump land in one write, or are both undone.
    await Promise.all([used, this.#store.bumpTokenEpoch()]);
    return { ok: true };
  }

  /**
   * Turn password sign-in on or off behind a fresh step-up for exactly that
   * change by `req`'s session. Turning it on takes any session. Turning it off
   * takes a passkey session — checked first, so a password session never
   * spends a step-up on it — whose step-up, a passkey assertion, proves a
   * passkey is registered when the change lands (and the last one can never be
   * revoked), so the account stays reachable. Off, every password session
   * issued so far stops verifying at once, and for good. Rejects if the store
   * cannot write the change, which it then undoes.
   */
  async setPasswordSignIn(
    enabled: boolean,
    req: AccountRequest,
  ): Promise<PasswordSignInResult> {
    if (!enabled && req.session.m !== "pk")
      return { ok: false, reason: "passkey-session-required" };
    const checked = await this.#stepUp(req, {
      action: "password-sign-in",
      enabled,
    });
    if (!checked.ok) return checked;
    const used = this.#recordUse(checked.assertion);
    if (used === undefined)
      return { ok: false, reason: "passkey-check-failed" };
    // The step-up's use and the change land in one write, or are both undone.
    await Promise.all([
      used,
      this.#store.setPasswordSignIn(enabled, this.#now()),
    ]);
    return { ok: true };
  }

  /**
   * Check a fresh step-up by `req`'s session for `action`, whose change the
   * caller makes outside the credential store (a machine revoke), and record
   * the passkey's use. Nothing is recorded when the step-up fails. Rejects if
   * the store cannot write the use, which it then undoes.
   */
  async authorize(
    action: AccountAction,
    req: AccountRequest,
  ): Promise<{ ok: true } | StepUpRefusal> {
    const checked = await this.#stepUp(req, action);
    if (!checked.ok) return checked;
    const used = this.#recordUse(checked.assertion);
    if (used === undefined)
      return { ok: false, reason: "passkey-check-failed" };
    await used;
    return { ok: true };
  }

  /** The current session-token epoch: what a token issued now would carry. */
  get tokenEpoch(): number {
    return this.#store.tokenEpoch;
  }

  /**
   * Mint discoverable assertion options for `ceremony`, or undefined when no
   * slot can be made for it. An empty `allowCredentials` lets the
   * authenticator pick its resident passkey (registration requires
   * `residentKey`), so the unauthenticated login endpoint discloses no
   * credential ids.
   */
  async #assertionOptions(
    ceremony: Ceremony,
  ): Promise<AssertionOptions | undefined> {
    const options = await generateAuthenticationOptions({
      rpID: this.#relyingParty().rpID,
      userVerification: "required",
      allowCredentials: [],
    });
    const flowId = this.#mint(options.challenge, ceremony);
    return flowId === undefined ? undefined : { flowId, options };
  }

  /**
   * Check an assertion over `challenge` against the stored credential it
   * names. Undefined when it does not verify; errors from the library (a
   * malformed assertion) propagate. Records nothing.
   */
  async #checkAssertion(
    challenge: string,
    response: unknown,
  ): Promise<Assertion | undefined> {
    const parsed = AuthenticationResponse.safeParse(response);
    if (!parsed.success) return undefined;

    const stored = this.#store.get(parsed.data.id);
    if (stored === undefined) return undefined;

    const rp = this.#relyingParty();
    const verification = await verifyAuthenticationResponse({
      // Zod-validated above; cast to the library's JSON type at this boundary.
      response: parsed.data as unknown as Parameters<
        typeof verifyAuthenticationResponse
      >[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
        counter: stored.counter,
        transports: stored.transports as
          | Parameters<
              typeof verifyAuthenticationResponse
            >[0]["credential"]["transports"]
          | undefined,
      },
    });
    if (!verification.verified) return undefined;
    const { newCounter, userVerified } = verification.authenticationInfo;
    return { credentialId: stored.id, newCounter, userVerified };
  }

  /**
   * Record a check that passed — for a passkey assertion, advance its
   * passkey's replay counter and stamp the last use — in memory at once,
   * returning the write that makes it durable. A password (no assertion)
   * leaves nothing to record. Undefined, recording nothing, when the passkey
   * was revoked while its assertion was being checked.
   */
  #recordUse(assertion: Assertion | undefined): Promise<void> | undefined {
    if (assertion === undefined) return Promise.resolve();
    if (this.#store.get(assertion.credentialId) === undefined) return undefined;
    return this.#store.recordUse(
      assertion.credentialId,
      assertion.newCounter,
      this.#now(),
    );
  }

  /**
   * Check the step-up `req` carries for `action`. A password session's must be
   * the password, throttled per client like a sign-in. A passkey session's
   * must be a user-verified assertion by a registered passkey over a live
   * `stepup` challenge minted for `action` by that session (consumed either
   * way, so a mismatched use spends it); whatever the browser posted, a bad
   * assertion just fails. Records nothing: a passed passkey step-up returns its
   * assertion, for the caller to record with the change it authorizes.
   */
  async #stepUp(
    req: AccountRequest,
    action: AccountAction,
  ): Promise<StepUpCheck> {
    const { session, stepUp } = req;
    if (session.m === "pw") {
      if (stepUp === undefined || !("password" in stepUp))
        return { ok: false, reason: "password-required" };
      const checked = await this.#checkPassword(stepUp.password, req.client);
      return checked.ok ? { ok: true, assertion: undefined } : checked;
    }
    if (stepUp === undefined || !("flowId" in stepUp))
      return { ok: false, reason: "passkey-check-failed" };
    const flow = this.#take(stepUp.flowId);
    if (
      flow?.kind !== "stepup" ||
      !sameAction(flow.action, action) ||
      !sameSession(flow.session, session)
    )
      return { ok: false, reason: "passkey-check-failed" };
    try {
      const asserted = await this.#checkAssertion(
        flow.challenge,
        stepUp.response,
      );
      if (asserted?.userVerified) return { ok: true, assertion: asserted };
    } catch {
      // A malformed assertion fails like any other bad one.
    }
    return { ok: false, reason: "passkey-check-failed" };
  }

  /**
   * Check `password` against the password file for the client at `client`
   * (undefined: no usable address, so only the global budget applies — see
   * {@link LoginThrottle}). A locked-out client is refused without a check.
   * Otherwise the try counts as a failure before the (slow) check runs — so
   * concurrent guesses cannot outrun the throttle — and a match clears the
   * client's count. A failure that starts a lockout is reported as the
   * lockout.
   */
  async #checkPassword(
    password: string,
    client: string | undefined,
  ): Promise<{ ok: true } | PasswordRefusal> {
    const now = this.#now();
    const allowed = this.#throttle.check(client, now);
    if (!allowed.ok)
      return {
        ok: false,
        reason: "throttled",
        retryAfterSec: allowed.retryAfterSec,
      };
    this.#throttle.fail(client, now);
    if (await this.#passwordMatches(password)) {
      this.#throttle.succeed(client);
      return { ok: true };
    }
    const locked = this.#throttle.check(client, now);
    return locked.ok
      ? { ok: false, reason: "wrong-password" }
      : { ok: false, reason: "throttled", retryAfterSec: locked.retryAfterSec };
  }

  /** Whether `password` is the one set; false when none is set or its hash is unusable (logged). */
  async #passwordMatches(password: string): Promise<boolean> {
    const stored = await this.#password();
    if (stored === undefined) return false;
    try {
      return await Bun.password.verify(password, stored.hash);
    } catch (err) {
      console.error(`omp-remote auth: password hash unusable: ${String(err)}`);
      return false;
    }
  }

  /**
   * The password file as it is now: undefined when none is set — or when it
   * cannot be read or parsed, which is logged, so a broken file fails closed.
   */
  async #password(): Promise<PasswordFile | undefined> {
    try {
      return await readPassword(this.#cfg.passwordPath);
    } catch (err) {
      console.error(
        `omp-remote auth: password file unreadable: ${String(err)}`,
      );
      return undefined;
    }
  }

  /** Where passkey ceremonies run. Throws while passkeys are off: nothing routes a ceremony here then. */
  #relyingParty(): RelyingParty {
    if (this.#rp === undefined)
      throw new Error("passkeys are off: no publicUrl is configured");
    return this.#rp;
  }

  /**
   * Hold `challenge` under a fresh flowId for `ceremony`, or undefined when no
   * slot can be made for it. Expired ceremonies are swept first, so a dead one
   * never takes a live one's room.
   */
  #mint(challenge: string, ceremony: Ceremony): string | undefined {
    const now = this.#now();
    for (const [id, pending] of this.#pending)
      if (now >= pending.expiresAt) this.#pending.delete(id);
    if (!this.#makeRoom(ceremony)) return undefined;
    const flowId = randomBytes(16).toString("base64url");
    this.#pending.set(flowId, {
      ...ceremony,
      challenge,
      expiresAt: now + CHALLENGE_TTL_MS,
    });
    return flowId;
  }

  /**
   * Make a slot for `ceremony` within the caps, or report there is none. A
   * login from a known address at {@link MAX_PENDING_LOGINS_PER_CLIENT}
   * displaces that address's own oldest pending login. Otherwise, with
   * every slot held, any ceremony displaces the oldest pending login of the
   * client holding the most (logins with no usable address — every request
   * looks alike, as behind a proxy that hides the client — count as one
   * client), so a flood gives way to everyone else rather than refusing them:
   * it cancels its own logins long before another client's lone one. An
   * enrolment or a step-up (both session-gated) never gives way; with only
   * those held, a new ceremony is refused.
   */
  #makeRoom(ceremony: Ceremony): boolean {
    if (ceremony.kind === "authenticate" && ceremony.client !== undefined) {
      let oldestOwn: string | undefined;
      let own = 0;
      for (const [flowId, pending] of this.#pending) {
        if (
          pending.kind !== "authenticate" ||
          pending.client !== ceremony.client
        )
          continue;
        oldestOwn ??= flowId;
        own += 1;
      }
      if (oldestOwn !== undefined && own >= MAX_PENDING_LOGINS_PER_CLIENT) {
        this.#pending.delete(oldestOwn);
        return true;
      }
    }
    if (this.#pending.size < MAX_PENDING_CEREMONIES) return true;
    const displaced = oldestOfLargestShare(pendingLogins(this.#pending));
    if (displaced === undefined) return false;
    this.#pending.delete(displaced);
    return true;
  }

  /** One-shot: take the ceremony pending under `flowId`, or undefined if unknown or expired. */
  #take(flowId: string): PendingCeremony | undefined {
    const pending = this.#pending.get(flowId);
    if (pending === undefined) return undefined;
    this.#pending.delete(flowId);
    if (this.#now() >= pending.expiresAt) return undefined;
    return pending;
  }
}

/** Each pending login's flowId and the client address it came from, oldest first. */
function* pendingLogins(
  pending: ReadonlyMap<string, PendingCeremony>,
): Generator<[string, string | undefined]> {
  for (const [flowId, ceremony] of pending)
    if (ceremony.kind === "authenticate") yield [flowId, ceremony.client];
}

/** Whether a step-up minted for `minted` may authorize `requested`. */
function sameAction(minted: AccountAction, requested: AccountAction): boolean {
  switch (minted.action) {
    case "revoke":
      return (
        requested.action === "revoke" &&
        requested.credentialId === minted.credentialId
      );
    case "password-sign-in":
      return (
        requested.action === "password-sign-in" &&
        requested.enabled === minted.enabled
      );
    case "revoke-machine":
      return (
        requested.action === "revoke-machine" &&
        requested.machineId === minted.machineId
      );
    default:
      return requested.action === minted.action;
  }
}

/**
 * Whether two verified tokens carry the same sign-in: same method and subject,
 * issued at the same second for the same lifetime under the same epoch.
 */
function sameSession(a: SessionTokenPayload, b: SessionTokenPayload): boolean {
  return (
    a.m === b.m &&
    a.sub === b.sub &&
    a.iat === b.iat &&
    a.exp === b.exp &&
    (a.ep ?? 0) === (b.ep ?? 0)
  );
}

/** Oldest registration first; passkeys enrolled before dates were recorded lead. */
function byCreatedAt(a: StoredCredential, b: StoredCredential): number {
  if (a.createdAt === undefined) return b.createdAt === undefined ? 0 : -1;
  if (b.createdAt === undefined) return 1;
  return a.createdAt - b.createdAt;
}

/**
 * Load the credential store and build a `WebAuthnGate`. Kept separate from the
 * pure `WebAuthnConfig` so config parsing stays side-effect free while store IO
 * happens here.
 */
export async function createWebAuthnGate(
  cfg: WebAuthnConfig,
  credentialStorePath: string,
): Promise<WebAuthnGate> {
  const store = await CredentialStore.load(credentialStorePath);
  return new WebAuthnGate(cfg, store);
}
