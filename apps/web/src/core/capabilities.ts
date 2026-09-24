/**
 * Which secure-context features this page can use. On a plain-HTTP origin
 * (the default for local-network setups) passkeys, the service worker and push
 * are all off; the UI reads this to say so instead of failing.
 */
export interface Capabilities {
  secure: boolean;
  passkey: boolean;
  push: boolean;
}

export function capabilities(): Capabilities {
  const secure = globalThis.isSecureContext === true;
  return {
    secure,
    passkey: secure && typeof globalThis.PublicKeyCredential !== "undefined",
    push:
      secure &&
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator,
  };
}
