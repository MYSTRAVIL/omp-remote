/**
 * Service-worker push behaviour, factored out of `sw.ts` so it is unit-testable
 * without a live worker. A push carries a `NotifyEnvelope`: the machine id in
 * the clear and a notice sealed with that machine's notify key, which only
 * this device and the machine hold, so the relay carrying it reads nothing
 * (spec §4.3). An attention notice shows one notification per session, named
 * after it; a clear notice closes it, or, past a daily cap on clears that
 * leave none showing, says the session no longer waits (see `clearSession`).
 * A push this device can't open (no payload from an older agent, a machine
 * not paired here, a damaged or foreign envelope) shows one generic
 * notification. A session's notification the user dismisses is reported to
 * its machine through the page (see `reportDismissed`).
 */

import {
  type NoticeReason,
  NotifyEnvelope,
  type NotifyNotice,
  openNotice,
} from "@omp-remote/protocol";
import { z } from "zod";
import { type BadgeApi, showBadge } from "./app-badge";
import type { CostlyRemovals } from "./costly-removals";
import type { NotifyDetail, NotifyMachine } from "./sw-caches";

export const ATTENTION_TAG = "omp-remote-attention";
/** The tag of the notification a quiet push shows and closes at once. */
export const QUIET_TAG = "omp-remote-quiet";
export const ATTENTION_TITLE = "omp-remote";
export const ATTENTION_BODY = "A session needs your attention";
/** The app icon a notification shows. */
export const NOTIFICATION_ICON = "/icons/icon-192.png";
/** The monochrome badge Android shows in the status bar. */
export const NOTIFICATION_BADGE = "/icons/badge-96.png";
/** The query parameter naming the session a window opens on: `<machineId>:<sessionId>`. */
export const OPEN_PARAM = "open";

/** What a session's notification says it is waiting for. */
const REASON_TEXT: Record<NoticeReason, string> = {
  approval: "Needs approval",
  question: "Question",
  idle: "Waiting for you",
};

/** What a session's notification says once the session no longer waits. */
export const SETTLED_BODY = "No longer waiting";

/** The session a notification stands for; tapping it opens that session. */
export const NotificationTarget = z.object({
  machineId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type NotificationTarget = z.infer<typeof NotificationTarget>;

/** What the worker posts an open window of the app when a session's notification is tapped. */
export const OpenSessionMessage = NotificationTarget.extend({
  type: z.literal("open-session"),
});
export type OpenSessionMessage = z.infer<typeof OpenSessionMessage>;

/**
 * What the worker posts every window of the app when the user dismisses a
 * session's notification that still said the session waits (see
 * `reportDismissed`).
 */
export const NoticeDismissedMessage = NotificationTarget.extend({
  type: z.literal("notice-dismissed"),
});
export type NoticeDismissedMessage = z.infer<typeof NoticeDismissedMessage>;

/** Every message the worker posts a window of the app. */
export const WorkerMessage = z.discriminatedUnion("type", [
  OpenSessionMessage,
  NoticeDismissedMessage,
]);
export type WorkerMessage = z.infer<typeof WorkerMessage>;

/**
 * What a session's notification carries: the session a tap opens, and
 * `settled` once it says the session no longer waits (see `clearSession`).
 */
const SessionNotificationData = NotificationTarget.extend({
  settled: z.literal(true).optional(),
});
type SessionNotificationData = z.infer<typeof SessionNotificationData>;

/** What starts the tag of each session's notification. */
const SESSION_TAG_PREFIX = "session:";

/** A session's notification tag: one notification per session, each replacing the last. */
export function sessionTag(machineId: string, sessionId: string): string {
  return `${SESSION_TAG_PREFIX}${machineId}:${sessionId}`;
}

/** The address a new window opens at for a tapped session. */
export function openSessionUrl({
  machineId,
  sessionId,
}: NotificationTarget): string {
  return `/?${OPEN_PARAM}=${encodeURIComponent(machineId)}:${encodeURIComponent(sessionId)}`;
}

/**
 * The session a window was opened at by `openSessionUrl`, when its machine is
 * paired here. A machine id may hold a colon itself, so the paired ids decide
 * where it ends; the longest one that fits wins.
 */
export function openSessionTarget(
  search: string,
  pairedMachineIds: readonly string[],
): NotificationTarget | undefined {
  const value = new URLSearchParams(search).get(OPEN_PARAM);
  if (value === null) return undefined;
  let found: NotificationTarget | undefined;
  for (const machineId of pairedMachineIds) {
    if (!value.startsWith(`${machineId}:`)) continue;
    const sessionId = value.slice(machineId.length + 1);
    if (sessionId !== "" && machineId.length > (found?.machineId.length ?? -1))
      found = { machineId, sessionId };
  }
  return found;
}

/** The options this worker shows a notification with. */
export interface NotificationSpec {
  body: string;
  tag: string;
  renotify?: boolean;
  silent?: boolean;
  icon?: string;
  badge?: string;
  /** The session a tap opens, and whether it no longer waits. */
  data?: SessionNotificationData;
}

/** A notification this worker is showing, as `getNotifications` returns it. */
export interface ShownNotification {
  readonly tag: string;
  readonly title: string;
  /** What it was shown with: {@link NotificationSpec.data}, as the browser kept it. */
  readonly data: unknown;
  close(): void;
}

/** The slice of a `ServiceWorkerRegistration` used to show and close notifications. */
export interface NotificationShower {
  showNotification(title: string, options: NotificationSpec): Promise<void>;
  /** The notifications showing under `filter.tag`; every one without a filter. */
  getNotifications(filter?: {
    tag: string;
  }): Promise<readonly ShownNotification[]>;
}

/** A window of this app, as the worker's `clients` API reports it. */
export interface WindowClientLike {
  readonly visibilityState: DocumentVisibilityState;
  focus(): Promise<unknown>;
  postMessage(message: WorkerMessage): void;
}

/** The slice of the SW `clients` API used to find, focus and open app windows. */
export interface ClientsLike {
  matchAll(opts: {
    type: "window";
    includeUncontrolled: boolean;
  }): Promise<readonly WindowClientLike[]>;
  openWindow(url: string): Promise<WindowClientLike | null>;
}

export interface PushDeps {
  clients: ClientsLike;
  registration: NotificationShower;
  /** Settings > Notifications > "Quiet while the app is open" is on. */
  quietWhileOpen(): Promise<boolean>;
  /** Each paired machine's notify key and name, as the page last saved them. */
  notifyKeys(): Promise<ReadonlyMap<string, NotifyMachine>>;
  /** Settings > Notifications > "Notification detail" level. */
  notifyDetail(): Promise<NotifyDetail>;
  /**
   * Drop the record that the user dismissed this session's notification (see
   * `reportDismissed`): a new notice for the session supersedes it, and the
   * page must not tell the machine the new one was seen.
   */
  forgetDismissed(target: NotificationTarget): Promise<void>;
  /**
   * The clears that left no notification showing with no window on screen,
   * counted against the daily cap; one per worker, so clears run in turn
   * (see `clearSession`).
   */
  removals: Pick<CostlyRemovals, "remove">;
  /** The time now, in epoch milliseconds. */
  now(): number;
  /** The worker's app badge; undefined where the browser has none. */
  badge?: BadgeApi;
}

/** A notice this device opened, with the machine that sealed it and its name here. */
type OpenedNotice = NotifyNotice & {
  readonly machineId: string;
  readonly label: string;
};

/**
 * Open a push payload. Its machine must be paired here and that machine's key
 * must open the notice; anything else is undefined, never a throw.
 */
async function openPayload(
  deps: PushDeps,
  payload: string | undefined,
): Promise<OpenedNotice | undefined> {
  if (payload === undefined) return undefined;
  try {
    const envelope = NotifyEnvelope.safeParse(JSON.parse(payload));
    if (!envelope.success) return undefined;
    const machine = (await deps.notifyKeys()).get(envelope.data.m);
    if (machine === undefined) return undefined;
    const notice = await openNotice(machine.key, envelope.data);
    return { ...notice, machineId: envelope.data.m, label: machine.label };
  } catch {
    // Not JSON, or a key that doesn't open it: an altered envelope, or one
    // sealed for an earlier pairing.
    return undefined;
  }
}

/**
 * A window of the app is on screen in this browser. A failed lookup counts as
 * none: every push must still show a notification (see `showQuietly`).
 */
async function appOnScreen(clients: ClientsLike): Promise<boolean> {
  const windows = await clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .catch((): readonly WindowClientLike[] => []);
  return windows.some((client) => client.visibilityState === "visible");
}

/**
 * Show a notification silently under its own tag and close it at once, for a
 * push that should show the user nothing; notifications already showing stay.
 * The subscription promised `userVisibleOnly`, so every push must show one.
 * WebKit counts each push that ends without `showNotification` as silent,
 * never resets the count, and at the third removes the subscription
 * (`maxSilentPushCount` in Source/WebKit/Shared/WebPushDaemonConstants.h,
 * enforced by `PushService::incrementSilentPushCount` in Source/WebKit/webpushd/PushService.mm).
 * Chromium counts the notifications still showing once a push is handled
 * instead, so one shown and closed here counts for nothing there: it excuses
 * a push that leaves none only while a page of the site is on screen (see
 * `clearSession`). The close can lose a race with the browser drawing it (seen
 * on Android), so it says only what is true of the push: the session's own
 * notification, or that it no longer waits, never a wait it can't name. A tap
 * on one left behind opens its session, as its notification's would.
 */
async function showQuietly(
  reg: NotificationShower,
  quiet: { title: string; body: string; data?: NotificationTarget },
): Promise<void> {
  await reg.showNotification(quiet.title, {
    body: quiet.body,
    tag: QUIET_TAG,
    silent: true,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
    data: quiet.data,
  });
  for (const shown of await reg.getNotifications({ tag: QUIET_TAG }))
    shown.close();
}

/** What a quiet push says when it names no session: nothing waits on it. */
const QUIET_UNNAMED = { title: ATTENTION_TITLE, body: SETTLED_BODY };

/**
 * An attention notice as its session's notification: titled after the session
 * (else its project), saying on which machine and project it runs, and what it
 * is waiting for.
 */
function sessionNotification(
  notice: Extract<OpenedNotice, { kind: "attention" }>,
  detail: NotifyDetail,
): { title: string; options: NotificationSpec } {
  const tag = sessionTag(notice.machineId, notice.sessionId);
  const data = { machineId: notice.machineId, sessionId: notice.sessionId };

  if (detail === "private") {
    return {
      title: ATTENTION_TITLE,
      options: {
        body: ATTENTION_BODY,
        tag,
        renotify: true,
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_BADGE,
        data,
      },
    };
  }

  const where = [notice.label, notice.project]
    .filter((part) => part !== "")
    .join(" · ");
  const reason = REASON_TEXT[notice.reason];

  if (detail === "session") {
    const why = reason;
    return {
      title: notice.title || notice.project || "Session",
      options: {
        body: where === "" ? why : `${where}\n${why}`,
        tag,
        renotify: true,
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_BADGE,
        data,
      },
    };
  }

  // preview: original behavior
  const why = notice.detail === "" ? reason : `${reason}: ${notice.detail}`;
  return {
    title: notice.title || notice.project || "Session",
    options: {
      body: where === "" ? why : `${where}\n${why}`,
      tag,
      renotify: true,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
      data,
    },
  };
}

/**
 * Set the app badge to the sessions whose notification is showing and still
 * waiting (the `session:` tags not settled), clearing it at none. A worker
 * without a badge, or one that fails, leaves the badge as it is: the push is
 * handled either way.
 */
async function badgeShownSessions(deps: PushDeps): Promise<void> {
  if (deps.badge === undefined) return;
  try {
    const shown = await deps.registration.getNotifications();
    await showBadge(
      deps.badge,
      shown.filter(
        (notification) =>
          notification.tag.startsWith(SESSION_TAG_PREFIX) &&
          !isSettled(notification),
      ).length,
    );
  } catch {
    // The notifications can't be listed: the badge keeps what it shows.
  }
}

/** A session's notification that says the session no longer waits. */
function isSettled(notification: ShownNotification): boolean {
  const data = SessionNotificationData.safeParse(notification.data);
  return data.success && data.data.settled === true;
}

/**
 * Close every notification that only says its session no longer waits (see
 * `clearSession`): once another notification shows, or the app is on screen,
 * nothing needs it. Notifications that can't be listed stay.
 */
export async function closeSettled(
  reg: Pick<NotificationShower, "getNotifications">,
): Promise<void> {
  try {
    for (const shown of await reg.getNotifications())
      if (isSettled(shown)) shown.close();
  } catch {
    // The notifications can't be listed: they stay until dismissed.
  }
}

/**
 * Close a session's notification for its clear notice, as a native app
 * would. Once a push is handled, Chromium counts this app's notifications
 * still showing; with none and no page of the site on screen it spends the
 * site's silent-push budget, and once that is spent it shows its own "This
 * site has been updated in the background" notification, which names no
 * session (`DidCountVisibleNotifications` and `ProcessSilentPush` in
 * chrome/browser/push_messaging/push_messaging_notification_manager.cc). A
 * close is free while another waiting notification of the app stays showing
 * (a settled one doesn't vouch: the next attention push or the page may
 * close it first) or a window of the app is on screen. A costly one is made
 * and counted while the day's count is under `COSTLY_REMOVALS_PER_DAY`;
 * past it the notification is replaced, silently, by one saying the
 * session no longer waits, which goes once another notification shows, the
 * app comes on screen, or the user dismisses it; a tap on it still opens the
 * session. Every close still shows and closes a quiet one, which WebKit
 * needs and Chromium counts for nothing (see `showQuietly`). A clear whose
 * notification is already gone can only do that, saying the session no
 * longer waits; it spends the budget alike when nothing else shows, so it is
 * counted too, at the cap as well. The page tells the machine when the user
 * has the session on screen or dismissed its notification (see
 * `reportDismissed`), so the machine sends none for a notification gone here.
 */
async function clearSession(
  deps: PushDeps,
  notice: Extract<OpenedNotice, { kind: "clear" }>,
): Promise<void> {
  const reg = deps.registration;
  const tag = sessionTag(notice.machineId, notice.sessionId);
  await deps.removals.remove(deps.now(), async (underCap) => {
    const showing = await reg.getNotifications();
    const own = showing.filter((shown) => shown.tag === tag);
    const last = own[0];
    const free =
      showing.some(
        (shown) =>
          shown.tag !== tag && shown.tag !== QUIET_TAG && !isSettled(shown),
      ) || (await appOnScreen(deps.clients));
    if (last !== undefined && !free && !underCap) {
      await reg.showNotification(last.title, {
        body: SETTLED_BODY,
        tag,
        silent: true,
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_BADGE,
        data: {
          machineId: notice.machineId,
          sessionId: notice.sessionId,
          settled: true,
        },
      });
      return false;
    }
    for (const shown of own) shown.close();
    // Closing one is not showing one: this push still shows its own.
    await showQuietly(reg, {
      title: last?.title ?? (notice.label || ATTENTION_TITLE),
      body: SETTLED_BODY,
      data: { machineId: notice.machineId, sessionId: notice.sessionId },
    });
    return !free;
  });
}

/**
 * Handle one push; `payload` is its data as text, undefined when it has none.
 * The relay pushes every subscribed device alike, so this device filters on
 * its own: while a window of the app is on screen here and "Quiet while the
 * app is open" is on, a notice is shown silently and closed at once (its
 * session's notification as it would show, or, for a push this device can't
 * open, that nothing waits). Otherwise an attention notice shows (or
 * replaces) its session's notification, and a push this device can't open
 * shows the generic one, whose shared tag collapses repeats; either closes
 * the notifications that only say a session no longer waits. An attention
 * notice supersedes the user's dismissal of its session's last notification.
 * A clear notice closes its session's notification, or, past the day's cap
 * on costly closes, says the session no longer waits (see `clearSession`).
 * Showing or closing a session's notification sets the app badge to the
 * sessions still waiting with one showing; a quiet or generic push leaves it.
 */
export async function handlePush(
  deps: PushDeps,
  payload: string | undefined,
): Promise<void> {
  const reg = deps.registration;
  const opened = await openPayload(deps, payload);
  if (opened?.kind === "clear") {
    await clearSession(deps, opened);
    await badgeShownSessions(deps);
    return;
  }
  const quiet =
    (await appOnScreen(deps.clients)) && (await deps.quietWhileOpen());
  if (opened === undefined) {
    if (quiet) {
      await showQuietly(reg, QUIET_UNNAMED);
      return;
    }
    await reg.showNotification(ATTENTION_TITLE, {
      body: ATTENTION_BODY,
      tag: ATTENTION_TAG,
      renotify: true,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
    });
    await closeSettled(reg);
    return;
  }
  const { title, options } = sessionNotification(
    opened,
    await deps.notifyDetail(),
  );
  const target = { machineId: opened.machineId, sessionId: opened.sessionId };
  if (quiet) {
    await showQuietly(reg, { title, body: options.body, data: target });
    await deps.forgetDismissed(target);
    return;
  }
  await reg.showNotification(title, options);
  await deps.forgetDismissed(target);
  await closeSettled(reg);
  await badgeShownSessions(deps);
}

/**
 * A tap on a notification (`data` is its data): bring the app to the
 * foreground on the session it stands for. An open window is focused and
 * told which session to open; with none, a new window opens on it. The
 * generic notification names no session, so the app just comes forward.
 */
export async function openFromNotification(
  clients: ClientsLike,
  data: unknown,
): Promise<void> {
  const target = NotificationTarget.safeParse(data);
  const windows = await clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const first = windows[0];
  if (first) {
    if (target.success)
      first.postMessage({ type: "open-session", ...target.data });
    await first.focus();
    return;
  }
  await clients.openWindow(target.success ? openSessionUrl(target.data) : "/");
}

/** What `reportDismissed` needs of the worker. */
export interface DismissDeps {
  clients: ClientsLike;
  /** Keep the dismissal where the page reads it (see `DismissedNotices`). */
  recordDismissed(target: NotificationTarget): Promise<void>;
}

/**
 * The user dismissed a notification (`notificationclose`; a close by this
 * app raises none). A session's notification that still said the session
 * waits is gone, so its machine must send no clear for it: a clear finding
 * nothing to close is a push that shows nothing (see `clearSession`). The
 * worker holds no sealed channel to tell the machine, so it records the
 * dismissal for the page, which tells it once its channel is ready, and
 * tells every window of the app now. The generic, quiet and settled
 * notifications leave nothing for a clear to find, so none is reported.
 */
export async function reportDismissed(
  deps: DismissDeps,
  notification: { readonly tag: string; readonly data: unknown },
): Promise<void> {
  const data = SessionNotificationData.safeParse(notification.data);
  if (!data.success || data.data.settled === true) return;
  const { machineId, sessionId } = data.data;
  if (notification.tag !== sessionTag(machineId, sessionId)) return;
  await deps.recordDismissed({ machineId, sessionId });
  const windows = await deps.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .catch((): readonly WindowClientLike[] => []);
  for (const client of windows)
    client.postMessage({ type: "notice-dismissed", machineId, sessionId });
}
