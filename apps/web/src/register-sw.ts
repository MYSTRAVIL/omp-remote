/// <reference lib="dom" />

/** The slice of `navigator` we need — structural so it is trivially faked in tests. */
export interface NavigatorLike {
  serviceWorker?: {
    register(scriptURL: string): Promise<ServiceWorkerRegistration>;
  };
}

/**
 * Register the PWA service worker if the browser supports it. Returns the
 * registration, or undefined when service workers are unavailable or registration
 * fails — the app runs fine online without one, so a failure must never throw.
 */
export async function registerServiceWorker(
  nav: NavigatorLike,
  scriptURL: string,
): Promise<ServiceWorkerRegistration | undefined> {
  if (!nav.serviceWorker) return undefined;
  try {
    return await nav.serviceWorker.register(scriptURL);
  } catch {
    return undefined;
  }
}
