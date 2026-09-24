import type {
  PushManagerLike,
  PushSubscribeDeps,
  PushSubscriptionLike,
} from "../../src/core/push-subscribe";
import type { CacheStorageLike } from "../../src/core/sw-caches";

/**
 * Cache Storage as this origin's page and service worker share it: `caches`
 * serves either side, and `written()` resolves once the next write has landed.
 * `unreadable` makes every open fail, as storage the browser denies does.
 */
export function fakeCaches(opts: { unreadable?: boolean } = {}) {
  const stores = new Map<string, Map<string, string>>();
  let nextWrite = Promise.withResolvers<void>();
  const caches: CacheStorageLike = {
    async open(cacheName) {
      if (opts.unreadable)
        throw new DOMException("storage denied", "SecurityError");
      const entries = stores.get(cacheName) ?? new Map<string, string>();
      stores.set(cacheName, entries);
      return {
        async match(url) {
          const body = entries.get(url);
          return body === undefined ? undefined : new Response(body);
        },
        async put(url, response) {
          entries.set(url, await response.text());
          const landed = nextWrite;
          nextWrite = Promise.withResolvers<void>();
          landed.resolve();
        },
      };
    },
  };
  return { caches, written: () => nextWrite.promise };
}

/** What a browser `PushSubscription.toJSON()` gives the relay. */
export const SUB_JSON = {
  endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
  keys: { p256dh: "cGtleQ", auth: "YXV0aA" },
};

/** A relay with push configured. */
export const RELAY: Record<string, unknown> = {
  "/push/vapid": { publicKey: "BEexampleKey" },
  "/push/subscription": {},
};

export interface RelayCall {
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A relay answering each path in `routes` with its JSON (404 elsewhere), recording `calls`. */
export function fakeRelay(
  routes: Record<string, unknown>,
  calls: RelayCall[],
): PushSubscribeDeps["fetch"] {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({
      path,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const payload = routes[path];
    return new Response(JSON.stringify(payload ?? { error: "not found" }), {
      status: payload === undefined ? 404 : 200,
      headers: { "content-type": "application/json" },
    });
  }) as PushSubscribeDeps["fetch"];
}

/**
 * A browser push manager double: one subscription at most, which `subscribe`
 * creates and `unsubscribe` drops, under a notification permission the test
 * changes as a user would in the browser's settings.
 */
export function fakePushManager(
  opts: { subscribed?: boolean; permission?: PermissionState } = {},
) {
  const seen = { subscribes: 0, unsubscribes: 0 };
  let permission = opts.permission ?? "granted";
  const sub: PushSubscriptionLike = {
    toJSON: () => SUB_JSON,
    async unsubscribe() {
      seen.unsubscribes += 1;
      current = null;
      return true;
    },
  };
  let current: PushSubscriptionLike | null = opts.subscribed ? sub : null;
  const pushManager: PushManagerLike = {
    async getSubscription() {
      return current;
    },
    async subscribe() {
      seen.subscribes += 1;
      current = sub;
      return sub;
    },
    async permissionState() {
      return permission;
    },
  };
  return {
    pushManager,
    seen,
    subscribed: () => current !== null,
    /** The answer a permission prompt gives now. */
    prompt: async (): Promise<NotificationPermission> =>
      permission === "denied" ? "denied" : "granted",
    allow: () => {
      permission = "granted";
    },
  };
}
