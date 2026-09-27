/**
 * The app icon's badge (the Badging API), on the page's `navigator` or the
 * service worker's. Browsers without it, or refusing it (an app not
 * installed, no permission), leave the icon as it is.
 */
export interface BadgeApi {
  setAppBadge(contents?: number): Promise<void>;
  clearAppBadge(): Promise<void>;
}

/** `target`'s badge methods bound to it, or undefined where the browser has none. */
export function badgeApi(
  target: Partial<BadgeApi> | undefined,
): BadgeApi | undefined {
  const set = target?.setAppBadge;
  const clear = target?.clearAppBadge;
  if (typeof set !== "function" || typeof clear !== "function")
    return undefined;
  return {
    setAppBadge: (contents) => set.call(target, contents),
    clearAppBadge: () => clear.call(target),
  };
}

/** Show `count` on the app badge, clearing it at zero. Never throws or rejects. */
export async function showBadge(
  badge: BadgeApi | undefined,
  count: number,
): Promise<void> {
  try {
    if (count > 0) await badge?.setAppBadge(count);
    else await badge?.clearAppBadge();
  } catch {
    // Refused: the icon keeps what it shows.
  }
}
