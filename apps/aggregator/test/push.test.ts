import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FetchFn, PushService } from "../src/push";
import { PushSubscriptionStore } from "../src/push-store";
import type { VapidKeys } from "../src/vapid";
import { decryptPushBody, makeSubscriber } from "./helpers/webpush-receiver";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tempStore(): Promise<PushSubscriptionStore> {
  const dir = await mkdtemp(join(tmpdir(), "omp-pushsvc-"));
  dirs.push(dir);
  return PushSubscriptionStore.load(join(dir, "subs.json"));
}

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

const subA = {
  endpoint: "https://fcm.googleapis.com/fcm/send/aaa",
  keys: { p256dh: "cGtleUE", auth: "YXV0aEE" },
};
const subB = {
  endpoint: "https://updates.push.services.mozilla.com/wpush/v2/bbb",
  keys: { p256dh: "cGtleUI", auth: "YXV0aEI" },
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

function recorder(status = 201): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { status };
  };
  return { fetch, calls };
}

test("notifyAll without a notice pushes a payloadless VAPID request to every subscription", async () => {
  const store = await tempStore();
  await store.add(subA);
  await store.add(subB);
  const { fetch, calls } = recorder();
  const svc = new PushService({
    keys: await makeKeys(),
    store,
    fetch,
    now: () => 1_700_000_000_000,
  });

  await svc.notifyAll();

  expect(calls.map((c) => c.url).sort()).toEqual(
    [subA.endpoint, subB.endpoint].sort(),
  );
  for (const c of calls) {
    expect(c.body).toBeUndefined();
    expect(c.headers.Authorization?.startsWith("vapid t=")).toBe(true);
    expect(c.headers.TTL).toBe("3600");
  }
  // The fan-out wire carries NO session content whatsoever.
  const wire = JSON.stringify(calls);
  for (const forbidden of ["sessionId", "title", "prompt", "idle", "approval"])
    expect(wire.includes(forbidden)).toBe(false);
});

test("with a notice, each subscription gets it RFC 8291-encrypted to its own keys", async () => {
  const store = await tempStore();
  const alice = await makeSubscriber();
  const bob = await makeSubscriber();
  const subs = [
    { endpoint: subA.endpoint, keys: alice.keys },
    { endpoint: subB.endpoint, keys: bob.keys },
  ];
  for (const s of subs) await store.add(s);
  const { fetch, calls } = recorder();
  const svc = new PushService({ keys: await makeKeys(), store, fetch });
  const notice = JSON.stringify({ v: 1, m: "m1", n: "aXY", ct: "c2VhbGVk" });

  await svc.notifyAll(undefined, notice);

  expect(calls.map((c) => c.url)).toEqual([subA.endpoint, subB.endpoint]);
  const receivers = [alice, bob];
  for (const [i, c] of calls.entries()) {
    const me = receivers[i];
    if (me === undefined || c.body === undefined)
      throw new Error("expected an encrypted body per subscription");
    expect(c.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(c.headers["Content-Type"]).toBe("application/octet-stream");
    expect(c.headers.TTL).toBe("3600");
    expect(c.headers.Authorization?.startsWith("vapid t=")).toBe(true);
    expect(
      new TextDecoder().decode(await decryptPushBody(c.body, me.pair, me.auth)),
    ).toBe(notice);
  }
});

test("with a notice, a subscription with unusable keys is skipped, not fatal to the fan-out", async () => {
  const store = await tempStore();
  const bob = await makeSubscriber();
  await store.add(subA); // garbage p256dh/auth
  await store.add({ endpoint: subB.endpoint, keys: bob.keys });
  const { fetch, calls } = recorder();
  const svc = new PushService({ keys: await makeKeys(), store, fetch });

  await svc.notifyAll(undefined, "sealed");

  expect(calls.map((c) => c.url)).toEqual([subB.endpoint]);
  // Not a 404/410, so the subscription is kept.
  expect(store.list()).toHaveLength(2);
});

test("a 410 Gone prunes the subscription; a 201 keeps it", async () => {
  const store = await tempStore();
  await store.add(subA);
  await store.add(subB);
  // subA gone, subB fine.
  const fetch: FetchFn = async (url) => ({
    status: url === subA.endpoint ? 410 : 201,
  });
  const svc = new PushService({ keys: await makeKeys(), store, fetch });

  await svc.notifyAll();
  expect(store.list().map((s) => s.endpoint)).toEqual([subB.endpoint]);
});

test("a transport error on one endpoint never breaks the fan-out", async () => {
  const store = await tempStore();
  await store.add(subA);
  await store.add(subB);
  const hit: string[] = [];
  const fetch: FetchFn = async (url) => {
    hit.push(url);
    if (url === subA.endpoint) throw new Error("ECONNRESET");
    return { status: 201 };
  };
  const svc = new PushService({ keys: await makeKeys(), store, fetch });

  await svc.notifyAll(); // must not reject
  expect(hit).toContain(subB.endpoint);
  // The failed one is NOT pruned (only 404/410 prune), both remain.
  expect(store.list()).toHaveLength(2);
});

test("vapidPublicKey exposes the app-server key for the PWA", async () => {
  const store = await tempStore();
  const keys = await makeKeys();
  const svc = new PushService({ keys, store, fetch: recorder().fetch });
  expect(svc.vapidPublicKey()).toBe(keys.publicKey);
});

test("a bad VAPID key is swallowed, never an unhandled rejection", async () => {
  const store = await tempStore();
  await store.add(subA);
  let fetched = false;
  const fetch: FetchFn = async () => {
    fetched = true;
    return { status: 201 };
  };
  const svc = new PushService({
    keys: {
      publicKey: Buffer.from("too-short").toString("base64url"),
      privateKey: "AAAA",
      subject: "mailto:me@example.com",
    },
    store,
    fetch,
  });
  await svc.notifyAll(); // must resolve, not reject
  expect(fetched).toBe(false); // never reached the send loop
});

test("given the token epoch, notifyAll wakes only subscriptions made under it or before epochs were recorded; retireBefore drops the rest for good", async () => {
  const store = await tempStore();
  const legacy = {
    endpoint: "https://web.push.apple.com/legacy",
    keys: subA.keys,
  };
  await store.add(legacy); // stored before subscriptions carried an epoch
  await store.add(subA, 0);
  await store.add(subB, 1);
  const { fetch, calls } = recorder();
  const svc = new PushService({ keys: await makeKeys(), store, fetch });

  // Signed out everywhere (epoch 1), the epoch-0 device is never woken, even
  // before its subscription is retired.
  await svc.notifyAll(1);
  expect(calls.map((c) => c.url)).toEqual([legacy.endpoint, subB.endpoint]);

  await svc.retireBefore(1);
  expect(store.list()).toEqual([{ ...subB, ep: 1 }]);
  calls.length = 0;
  await svc.notifyAll(1);
  expect(calls.map((c) => c.url)).toEqual([subB.endpoint]);
});
