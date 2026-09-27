/// <reference lib="webworker" />

// First: it configures Zod before any schema below is built.
import "./zod-jitless";
import { badgeApi } from "./core/app-badge";
import { CostlyRemovals } from "./core/costly-removals";
import { DismissedNotices } from "./core/dismissed-notices";
import {
  SHELL_CACHE_PREFIX,
  readNotifyDetail,
  readNotifyKeys,
  readQuietWhileOpen,
  staleShellCaches,
} from "./core/sw-caches";
import {
  NOTIFICATION_BADGE,
  NOTIFICATION_ICON,
  handlePush,
  openFromNotification,
  reportDismissed,
} from "./core/sw-push";

// In a shared tsc program the DOM lib types `self` as `Window`; in the service
// worker it is a `ServiceWorkerGlobalScope`. Narrow it at this runtime boundary.
const worker = self as unknown as ServiceWorkerGlobalScope;

// Replaced at build time (apps/web/build.ts) with the build id, so a new deploy
// changes the cache name → the browser reinstalls the SW and re-precaches.
declare const __OMP_BUILD_ID__: string;

const CACHE = `${SHELL_CACHE_PREFIX}${__OMP_BUILD_ID__}`;

// The session notifications the user dismissed, which the page reports to
// their machines; one record, so this worker's changes to it run in turn.
const dismissed = new DismissedNotices(caches);
// The clears that left no notification showing with no window on screen,
// counted against a daily cap; one record, so this worker's clears run in turn.
const removals = new CostlyRemovals(caches);

const SHELL = [
  "/",
  "/index.html",
  "/main.js",
  "/styles.css",
  "/icon.svg",
  "/manifest.webmanifest",
  "/fonts/geist-latin-variable.woff2",
  "/fonts/geist-mono-latin-variable.woff2",
  NOTIFICATION_ICON,
  NOTIFICATION_BADGE,
];

worker.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        // A new cache name must not copy old bytes from the browser HTTP cache.
        cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))),
      )
      .then(() => worker.skipWaiting()),
  );
});

// Drop the shells of earlier deploys, and nothing else: the prefs cache holds
// the page's choices for this worker and must survive every deploy.
worker.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(staleShellCaches(keys, CACHE).map((k) => caches.delete(k))),
      )
      .then(() => worker.clients.claim()),
  );
});

// Cache-first for the static shell; everything else (the WSS, /auth/*) goes to
// the network untouched — the transcript stream is never cached. The shell is
// cached without a query, so a window a tapped notification opens at
// `/?open=…` loads the same cached page.
worker.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin) return;
  if (!SHELL.includes(url.pathname) && url.pathname !== "/") return;
  event.respondWith(
    caches
      .match(request, { ignoreSearch: true })
      .then((hit) => hit ?? fetch(request)),
  );
});

// A sealed push notice: the machine id in the clear, the notice sealed with
// that machine's notify key, which the page copies into the prefs cache along
// with the machine's name here. The relay pushes every subscribed device
// alike; this device filters on its own: with "Quiet while the app is open"
// on (also read from the prefs cache), a push that lands while a window of the
// app is on screen is shown silently and closed at once. A clear closes its
// session's notification; past a daily cap on the closes Chromium charges
// for, it leaves one saying the session no longer waits instead. Each session
// notification shown or closed sets the app badge where the worker has one,
// and a new one for a session drops the record of its last one's dismissal.
// See `handlePush`.
worker.addEventListener("push", (event) => {
  event.waitUntil(
    handlePush(
      {
        clients: worker.clients,
        registration: worker.registration,
        quietWhileOpen: () => readQuietWhileOpen(caches),
        notifyKeys: () => readNotifyKeys(caches),
        notifyDetail: () => readNotifyDetail(caches),
        forgetDismissed: (target) => dismissed.forget(target),
        removals,
        now: () => Date.now(),
        badge: badgeApi(worker.navigator),
      },
      event.data?.text(),
    ),
  );
});

// Tapping a session's notification opens that session: in the open window,
// else in a new one; the generic notification just brings the app forward.
worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    openFromNotification(worker.clients, event.notification.data),
  );
});

// Dismissing a session's notification that still said it waits is recorded
// for the page, which tells its machine to send no clear for it; the open
// windows are told at once. See `reportDismissed`.
worker.addEventListener("notificationclose", (event) => {
  event.waitUntil(
    reportDismissed(
      {
        clients: worker.clients,
        recordDismissed: (target) => dismissed.record(target),
      },
      event.notification,
    ),
  );
});
