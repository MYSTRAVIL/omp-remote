/// <reference lib="dom" />
import { z } from "zod";
import type { PushPreferences } from "./push-preferences";

/** The slice of a browser `PushSubscription` the flow uses. */
export interface PushSubscriptionLike {
  toJSON(): object;
  unsubscribe(): Promise<boolean>;
}

/**
 * The slice of the browser `PushManager` the subscribe flow uses — structural so
 * it is trivially faked in tests (the real one lives on a `ServiceWorkerRegistration`).
 */
export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(opts: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array;
  }): Promise<PushSubscriptionLike>;
  permissionState(opts: { userVisibleOnly: boolean }): Promise<PermissionState>;
}

/**
 * Dependencies of the Web Push subscribe flow, injected so it is testable without
 * a browser. `pushManager` is absent when the browser lacks push support (then the
 * flow is a no-op). `token` is the session token authorising `POST /push/subscription`.
 */
export interface PushSubscribeDeps {
  baseUrl: string;
  fetch: typeof fetch;
  pushManager: PushManagerLike | undefined;
  token: string;
}

/** The relay refused a setup step; `message` says why, as a clause for Settings. */
export class PushSetupError extends Error {}

const VapidResponse = z.object({ publicKey: z.string() });

/**
 * Decode a base64url VAPID public key into the raw byte array a `PushManager`
 * wants as `applicationServerKey` (the browser rejects a plain string).
 */
function decodeApplicationServerKey(b64url: string): Uint8Array {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Enrol this device for metadata-only attention pushes: fetch the aggregator's
 * VAPID public key, subscribe via the browser `PushManager` (reusing an existing
 * subscription if present), and register it with the aggregator. Returns `true`
 * on success, `false` when push is unsupported. A refusal by the relay throws a
 * `PushSetupError`; a network or permission failure propagates as the browser
 * raised it.
 */
export async function subscribeToPush(
  deps: PushSubscribeDeps,
): Promise<boolean> {
  if (!deps.pushManager) return false;

  const res = await deps.fetch(`${deps.baseUrl}/push/vapid`);
  if (res.status === 404)
    throw new PushSetupError("the relay doesn't send push notifications");
  const vapid = VapidResponse.safeParse(
    res.ok ? await res.json().catch(() => undefined) : undefined,
  );
  if (!vapid.success)
    throw new PushSetupError("the relay didn't answer as expected");

  const existing = await deps.pushManager.getSubscription();
  const sub =
    existing ??
    (await deps.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeApplicationServerKey(vapid.data.publicKey),
    }));

  const registered = await deps.fetch(`${deps.baseUrl}/push/subscription`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${deps.token}`,
    },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!registered.ok)
    throw new PushSetupError(
      registered.status === 401
        ? "your sign-in has expired"
        : "the relay didn't answer as expected",
    );
  return true;
}

/**
 * Drop this device's push subscription, if it has one. The relay is not told:
 * the push service answers its next push to the old endpoint with 410 Gone,
 * and the relay prunes the subscription then.
 */
export async function unsubscribeFromPush(
  pushManager: PushManagerLike,
): Promise<void> {
  const sub = await pushManager.getSubscription();
  await sub?.unsubscribe();
}

/** What push does on this device now, as Settings > Notifications shows it. */
export type PushState =
  /** This browser, or this way of opening the app, has no Web Push. */
  | { readonly status: "unsupported" }
  /** The browser blocks notifications from this site. */
  | { readonly status: "blocked" }
  | { readonly status: "turning-on" }
  | { readonly status: "turning-off" }
  /** Registered with the relay. */
  | { readonly status: "on" }
  /** Off; `problem` says why turning it on just failed. */
  | { readonly status: "off"; readonly problem?: string }
  /** On, but registering this device failed; `problem` says why. */
  | { readonly status: "failed"; readonly problem: string };

export interface PushEnrolmentDeps {
  baseUrl: string;
  fetch: typeof fetch;
  /** The service worker's push manager; undefined where there is no Web Push. */
  pushManager(): Promise<PushManagerLike | undefined>;
  /** Ask for notification permission; called within the user's tap. */
  requestPermission(): Promise<NotificationPermission>;
  preferences: PushPreferences;
}

/** The browser blocks notifications from this site. */
async function isBlocked(pushManager: PushManagerLike): Promise<boolean> {
  try {
    const state = await pushManager.permissionState({ userVisibleOnly: true });
    return state === "denied";
  } catch {
    return false;
  }
}

/** Why registering this device failed, as a clause for Settings. */
function describeFailure(error: unknown): string {
  if (error instanceof PushSetupError) return error.message;
  if (error instanceof TypeError) return "the relay couldn't be reached";
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return "notifications weren't allowed";
  return "the browser's push service refused this device";
}

/**
 * Keeps this device's Web Push subscription in step with its push preference.
 * Signing in registers the device while push is on (subscribing first when it
 * has no subscription, which may ask for permission) and drops a leftover
 * subscription while it is off. Turning push on from Settings asks for
 * permission within the tap and saves "on" only once the device is
 * registered, so a failure leaves it off. Turning it off saves at once, then
 * unsubscribes. Requests run one at a time; one a newer choice overtook is
 * skipped.
 */
export class PushEnrolment {
  readonly preferences: PushPreferences;
  readonly #deps: PushEnrolmentDeps;
  readonly #listeners = new Set<() => void>();
  #state: PushState;
  #token: string | undefined;
  #queue = Promise.resolve();
  /** Bumped by every choice made in Settings; a request made before it is out of date. */
  #choice = 0;

  constructor(deps: PushEnrolmentDeps) {
    this.#deps = deps;
    this.preferences = deps.preferences;
    this.#state = { status: deps.preferences.enabled ? "turning-on" : "off" };
  }

  get state(): PushState {
    return this.#state;
  }

  /**
   * Signed in with `token`: register this device while push is on, or drop a
   * subscription left behind while it is off. Overtakes no choice in flight.
   */
  signedIn(token: string): Promise<void> {
    this.#token = token;
    return this.#request(async (pushManager, current) => {
      if (this.preferences.enabled) {
        await this.#register(pushManager, current);
        return;
      }
      // An unsubscribe that fails is tried again at the next sign-in.
      await unsubscribeFromPush(pushManager).catch(() => {});
      const blocked = await isBlocked(pushManager);
      if (current()) this.#show({ status: blocked ? "blocked" : "off" });
    });
  }

  /** Turn push on or off for this device; turning it on asks for permission, so call it from the user's tap. */
  setEnabled(on: boolean): Promise<void> {
    this.#choice += 1;
    if (on) {
      // Asked now, while the tap still counts as the user's gesture.
      const permission = this.#deps.requestPermission();
      this.#show({ status: "turning-on" });
      return this.#request((pushManager, current) =>
        this.#register(pushManager, current, permission),
      );
    }
    this.preferences.setEnabled(false);
    this.#show({ status: "turning-off" });
    return this.#request(async (pushManager, current) => {
      // An unsubscribe that fails is tried again at the next sign-in.
      await unsubscribeFromPush(pushManager).catch(() => {});
      if (current()) this.#show({ status: "off" });
    });
  }

  /** Call `listener` after every change of `state`; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Run `work` after every earlier request, unless a choice made in Settings
   * overtakes it first. `current` says whether it still stands.
   */
  #request(
    work: (
      pushManager: PushManagerLike,
      current: () => boolean,
    ) => Promise<void>,
  ): Promise<void> {
    const choice = this.#choice;
    const current = (): boolean => choice === this.#choice;
    this.#queue = this.#queue.then(async () => {
      if (!current()) return;
      try {
        const pushManager = await this.#deps.pushManager();
        if (pushManager) await work(pushManager, current);
        else if (current()) this.#show({ status: "unsupported" });
      } catch (error) {
        if (current()) this.#fail(describeFailure(error));
      }
    });
    return this.#queue;
  }

  /**
   * Subscribe when needed and register this device with the relay. Given the
   * answer to a permission request (a choice made in Settings), a success
   * also saves push as on.
   */
  async #register(
    pushManager: PushManagerLike,
    current: () => boolean,
    permission?: Promise<NotificationPermission>,
  ): Promise<void> {
    const answer = await permission;
    if (answer === "denied" || (await isBlocked(pushManager))) {
      if (current()) this.#show({ status: "blocked" });
      return;
    }
    if (answer === "default") {
      if (current()) this.#fail("notifications weren't allowed");
      return;
    }
    const token = this.#token;
    if (token === undefined) throw new PushSetupError("you aren't signed in");
    try {
      await subscribeToPush({
        baseUrl: this.#deps.baseUrl,
        fetch: this.#deps.fetch,
        pushManager,
        token,
      });
    } catch (error) {
      const blocked = await isBlocked(pushManager);
      if (!current()) return;
      if (blocked) this.#show({ status: "blocked" });
      else this.#fail(describeFailure(error));
      return;
    }
    if (!current()) return;
    if (permission) this.preferences.setEnabled(true);
    this.#show({ status: "on" });
  }

  /** Registering failed: "failed" while push stays on, else off with the reason. */
  #fail(problem: string): void {
    this.#show(
      this.preferences.enabled
        ? { status: "failed", problem }
        : { status: "off", problem },
    );
  }

  #show(state: PushState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
