import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type TokenStorage,
  rememberSessionToken,
  restoreSessionToken,
} from "../src/core/auth";
import { SignInPreferences } from "../src/core/sign-in-preferences";
import { renderLoginView } from "../src/ui/render";

// Register a DOM only for this file (for the passkey screen) so happy-dom's
// globals never leak into the crypto/WebSocket-based suites in the same process.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => document.body.replaceChildren());

/** A Map-backed `localStorage` stand-in that outlives any one page load. */
function deviceStorage(): TokenStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/**
 * Show the passkey screen as this device's choice sets it, press Continue
 * with passkey untouched, and resolve whether that sign-in asks to be kept.
 */
function signInAsShown(keepSignedIn: boolean): Promise<boolean> {
  const root = document.createElement("div");
  document.body.append(root);
  const asked = Promise.withResolvers<boolean>();
  renderLoginView(
    root,
    {
      methods: { password: false, passkey: true },
      passkeyAvailable: true,
      onPasswordLogin: async () => ({ ok: false, reason: "wrong-password" }),
      onPasskeyLogin: async (remember) => asked.resolve(remember),
    },
    document.createElement("p"),
    keepSignedIn,
  );
  const login = [...root.querySelectorAll("button")].find(
    (node) => node.textContent === "Continue with passkey",
  );
  if (!login) throw new Error("no Continue with passkey button");
  login.click();
  return asked.promise;
}

test("Keep me signed in survives a reload and sets whether the passkey screen keeps the sign-in", async () => {
  const storage = deviceStorage();
  expect(new SignInPreferences(storage).keepSignedIn).toBe(false);
  expect(await signInAsShown(new SignInPreferences(storage).keepSignedIn)).toBe(
    false,
  );

  expect(new SignInPreferences(storage).setKeepSignedIn(true)).toBe(true);
  const reloaded = new SignInPreferences(storage);
  expect(reloaded.keepSignedIn).toBe(true);
  expect(await signInAsShown(reloaded.keepSignedIn)).toBe(true);
});

test("turning Keep me signed in off forgets the remembered sign-in at once; turning it on restores none", () => {
  const storage = deviceStorage();
  const token = `${Buffer.from(JSON.stringify({ sub: "c", exp: 2_000_000_000 })).toString("base64url")}.sig`;
  const now = 1_900_000_000_000;
  rememberSessionToken(storage, token);
  // A device already keeping a sign-in chose that when it signed in.
  const preferences = new SignInPreferences(storage);
  expect(preferences.keepSignedIn).toBe(true);

  preferences.setKeepSignedIn(false);
  expect(restoreSessionToken(storage, now)).toBeUndefined();
  // On applies from the next sign-in; it brings no sign-in back by itself.
  preferences.setKeepSignedIn(true);
  expect(restoreSessionToken(storage, now)).toBeUndefined();
});
