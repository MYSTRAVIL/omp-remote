/**
 * What this app keeps in Cache Storage, which the page and the service worker
 * share (a worker has no localStorage). Each deploy precaches its shell under
 * its own name, and activating it deletes the shells before it. The prefs
 * cache holds what the page saves for the worker to read (choices, and each
 * paired machine's notify key); it has no build in its name and outlives
 * every deploy.
 */

import { z } from "zod";
import { fromBase64Url, toBase64Url } from "./base64";

/** A deploy's shell cache is named this plus its build id. */
export const SHELL_CACHE_PREFIX = "omp-remote-shell-";
/** Choices the page saves for the service worker. */
export const PREFS_CACHE = "omp-remote-prefs";
/** "Quiet while the app is open": body `1` for on, `0` for off. */
const QUIET_WHILE_OPEN_URL = "/__prefs/quiet-while-open";
/** "Quiet while the app is open" on a device that never chose. */
export const QUIET_WHILE_OPEN_DEFAULT = true;
/**
 * Each paired machine's notify key (base64url) and its name on this device:
 * JSON `{[machineId]: {key, label}}`.
 */
const NOTIFY_KEYS_URL = "/__prefs/notify-keys";

const StoredNotifyKeys = z.record(
  z.string(),
  z.object({ key: z.string().min(1), label: z.string() }),
);

/** What the service worker needs to open one machine's push notices and name it. */
export interface NotifyMachine {
  /** `notifyKey(rx)` of this device's pairing with the machine. */
  readonly key: Uint8Array;
  /** The machine's name as this device shows it. */
  readonly label: string;
}

/** The slice of `CacheStorage` used here. */
export interface CacheStorageLike {
  open(cacheName: string): Promise<CacheLike>;
}

/** The slice of a `Cache` used here. */
export interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}

/**
 * The caches to delete once the shell cache `current` is active: the shells
 * of earlier deploys, never the prefs cache or anything else.
 */
export function staleShellCaches(
  cacheNames: readonly string[],
  current: string,
): string[] {
  return cacheNames.filter(
    (name) => name !== current && name.startsWith(SHELL_CACHE_PREFIX),
  );
}

/** Save "Quiet while the app is open" where the service worker reads it. */
export async function saveQuietWhileOpen(
  caches: CacheStorageLike,
  on: boolean,
): Promise<void> {
  const prefs = await caches.open(PREFS_CACHE);
  await prefs.put(QUIET_WHILE_OPEN_URL, new Response(on ? "1" : "0"));
}

/**
 * "Quiet while the app is open" as the page last saved it. Never saved, or
 * unreadable, it is the default.
 */
export async function readQuietWhileOpen(
  caches: CacheStorageLike,
): Promise<boolean> {
  try {
    const prefs = await caches.open(PREFS_CACHE);
    const saved = await (await prefs.match(QUIET_WHILE_OPEN_URL))?.text();
    if (saved === "1") return true;
    if (saved === "0") return false;
  } catch {
    // Storage the worker can't read counts as never saved.
  }
  return QUIET_WHILE_OPEN_DEFAULT;
}

/**
 * Save every paired machine's notify key and name where the service worker
 * reads them, replacing the last save: a machine left out is forgotten.
 */
export async function saveNotifyKeys(
  caches: CacheStorageLike,
  machines: ReadonlyMap<string, NotifyMachine>,
): Promise<void> {
  const stored: z.infer<typeof StoredNotifyKeys> = Object.fromEntries(
    [...machines].map(([machineId, { key, label }]) => [
      machineId,
      { key: toBase64Url(key), label },
    ]),
  );
  const prefs = await caches.open(PREFS_CACHE);
  await prefs.put(NOTIFY_KEYS_URL, new Response(JSON.stringify(stored)));
}

/**
 * The notify keys and names as the page last saved them, by machineId. Never
 * saved, or unreadable, there are none.
 */
export async function readNotifyKeys(
  caches: CacheStorageLike,
): Promise<Map<string, NotifyMachine>> {
  try {
    const prefs = await caches.open(PREFS_CACHE);
    const saved = await (await prefs.match(NOTIFY_KEYS_URL))?.text();
    if (saved === undefined) return new Map();
    const stored = StoredNotifyKeys.parse(JSON.parse(saved));
    return new Map(
      Object.entries(stored).map(([machineId, { key, label }]) => [
        machineId,
        { key: fromBase64Url(key), label },
      ]),
    );
  } catch {
    // Storage the worker can't read, or a damaged save, counts as none.
    return new Map();
  }
}
