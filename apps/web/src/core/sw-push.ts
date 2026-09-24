/**
 * Service-worker push behaviour, factored out of `sw.ts` so it is unit-testable
 * without a live worker. A push carries a `NotifyEnvelope`: the machine id in
 * the clear and a notice sealed with that machine's notify key, which only
 * this device and the machine hold, so the relay carrying it reads nothing
 * (spec §4.3). An attention notice shows one notification per session, named
 * after it; a clear notice closes it. A push this device can't open (no
 * payload from an older agent, a machine not paired here, a damaged or
 * foreign envelope) shows one generic notification.
 */

import {
  type NoticeReason,
  NotifyEnvelope,
  type NotifyNotice,
  openNotice,
} from "@omp-remote/protocol";
import { z } from "zod";
import type { NotifyMachine } from "./sw-caches";

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

/** A session's notification tag: one notification per session, each replacing the last. */
export function sessionTag(machineId: string, sessionId: string): string {
  return `session:${machineId}:${sessionId}`;
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
  /** The session a tap opens. */
  data?: NotificationTarget;
}

/** A notification this worker is showing, as `getNotifications` returns it. */
export interface ShownNotification {
  close(): void;
}

/** The slice of a `ServiceWorkerRegistration` used to show and close notifications. */
export interface NotificationShower {
  showNotification(title: string, options: NotificationSpec): Promise<void>;
  getNotifications(filter: {
    tag: string;
  }): Promise<readonly ShownNotification[]>;
}

/** A window of this app, as the worker's `clients` API reports it. */
export interface WindowClientLike {
  readonly visibilityState: DocumentVisibilityState;
  focus(): Promise<unknown>;
  postMessage(message: OpenSessionMessage): void;
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
 * Chromium excuses a push that shows none while a page of the site is on
 * screen (chrome/browser/push_messaging/push_messaging_notification_manager.cc).
 * WebKit never does: it counts each push that ends without `showNotification`
 * as silent, never resets the count, and at the third removes the
 * subscription (`maxSilentPushCount` in Source/WebKit/Shared/WebPushDaemonConstants.h,
 * enforced by `PushService::incrementSilentPushCount` in Source/WebKit/webpushd/PushService.mm).
 */
async function showQuietly(reg: NotificationShower): Promise<void> {
  await reg.showNotification(ATTENTION_TITLE, {
    body: ATTENTION_BODY,
    tag: QUIET_TAG,
    silent: true,
  });
  for (const shown of await reg.getNotifications({ tag: QUIET_TAG }))
    shown.close();
}

/**
 * An attention notice as its session's notification: titled after the session
 * (else its project), saying on which machine and project it runs, and what it
 * is waiting for.
 */
function sessionNotification(
  notice: Extract<OpenedNotice, { kind: "attention" }>,
): { title: string; options: NotificationSpec } {
  const where = [notice.label, notice.project]
    .filter((part) => part !== "")
    .join(" · ");
  const reason = REASON_TEXT[notice.reason];
  const why = notice.detail === "" ? reason : `${reason}: ${notice.detail}`;
  return {
    title: notice.title || notice.project || "Session",
    options: {
      body: where === "" ? why : `${where}\n${why}`,
      tag: sessionTag(notice.machineId, notice.sessionId),
      renotify: true,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
      data: { machineId: notice.machineId, sessionId: notice.sessionId },
    },
  };
}

/**
 * Handle one push; `payload` is its data as text, undefined when it has none.
 * The relay pushes every subscribed device alike, so this device filters on
 * its own: while a window of the app is on screen here and "Quiet while the
 * app is open" is on, a notice is shown silently and closed at once.
 * Otherwise an attention notice shows (or replaces) its session's
 * notification, and a push this device can't open shows the generic one,
 * whose shared tag collapses repeats. A clear notice closes its session's
 * notification.
 */
export async function handlePush(
  deps: PushDeps,
  payload: string | undefined,
): Promise<void> {
  const reg = deps.registration;
  const opened = await openPayload(deps, payload);
  if (opened?.kind === "clear") {
    const tag = sessionTag(opened.machineId, opened.sessionId);
    for (const shown of await reg.getNotifications({ tag })) shown.close();
    // Closing one is not showing one: this push still shows its own.
    await showQuietly(reg);
    return;
  }
  if ((await appOnScreen(deps.clients)) && (await deps.quietWhileOpen())) {
    await showQuietly(reg);
    return;
  }
  if (opened === undefined) {
    await reg.showNotification(ATTENTION_TITLE, {
      body: ATTENTION_BODY,
      tag: ATTENTION_TAG,
      renotify: true,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
    });
    return;
  }
  const { title, options } = sessionNotification(opened);
  await reg.showNotification(title, options);
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
