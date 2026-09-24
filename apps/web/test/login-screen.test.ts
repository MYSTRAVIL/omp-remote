import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PasswordLoginResult, SignInMethods } from "../src/core/auth";
import { type LoginOptions, renderLoginView } from "../src/ui/render";

// Register a DOM only for this file and tear it down after, so happy-dom's
// globals never leak into the crypto/WebSocket-based suites in the same process.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => document.body.replaceChildren());

interface LoginScreen {
  password: HTMLInputElement;
  form: HTMLFormElement;
  submit: HTMLButtonElement;
  passkey: HTMLButtonElement;
  status: HTMLElement;
  card: HTMLElement;
}

function mount(overrides: Partial<LoginOptions> = {}): LoginScreen {
  const root = document.createElement("div");
  document.body.append(root);
  const status = document.createElement("p");
  renderLoginView(
    root,
    {
      methods: { password: true, passkey: true },
      passkeyAvailable: true,
      onPasswordLogin: async () => ({ ok: true, token: "t" }),
      onPasskeyLogin: async () => {},
      ...overrides,
    },
    status,
  );
  const password = root.querySelector<HTMLInputElement>("input[type=password]");
  const form = password?.form;
  const submit = form?.querySelector<HTMLButtonElement>("button[type=submit]");
  const passkey = [...root.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("passkey"),
  );
  const card = root.querySelector<HTMLElement>(".login-card");
  if (!password || !form || !submit || !passkey || !card)
    throw new Error("the sign-in screen is missing a control");
  return { password, form, submit, passkey, status, card };
}

/** Shown to the user: neither it nor any ancestor is hidden. */
function shown(node: HTMLElement): boolean {
  for (let at: HTMLElement | null = node; at; at = at.parentElement)
    if (at.hidden) return false;
  return true;
}

/** Resolves once the card leaves its busy state, i.e. the action settled. */
function settled(card: HTMLElement): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const observer = new MutationObserver(() => {
    if (card.hasAttribute("aria-busy")) return;
    observer.disconnect();
    resolve();
  });
  observer.observe(card, { attributes: true, attributeFilter: ["aria-busy"] });
  return promise;
}

function typePassword(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("the password field shows exactly when the relay offers password sign-in", () => {
  for (const password of [true, false]) {
    const methods: SignInMethods = { password, passkey: true };
    const screen = mount({ methods });
    expect(shown(screen.password)).toBe(password);
    document.body.replaceChildren();
  }
});

test("the passkey button shows only when the relay offers passkeys and this browser can use them", () => {
  const cases = [
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ] as const;
  for (const [offered, available, expected] of cases) {
    const screen = mount({
      methods: { password: true, passkey: offered },
      passkeyAvailable: available,
    });
    expect(shown(screen.passkey)).toBe(expected);
    document.body.replaceChildren();
  }
});

test("the password field is a sign-in password: autofilled as one, not spellchecked", () => {
  const { password } = mount();
  expect(password.autocomplete).toBe("current-password");
  expect(password.spellcheck).toBe(false);
  expect(password.labels?.[0]?.textContent).toBe("Password");
});

test("signing in passes the password and the remember choice", async () => {
  const sent: [string, boolean][] = [];
  const screen = mount({
    onPasswordLogin: async (password, remember) => {
      sent.push([password, remember]);
      return { ok: true, token: "t" };
    },
  });
  expect(screen.submit.disabled).toBe(true);
  typePassword(screen.password, "correct horse battery");
  expect(screen.submit.disabled).toBe(false);
  const done = settled(screen.card);
  screen.form.requestSubmit();
  await done;
  expect(sent).toEqual([["correct horse battery", false]]);
});

test("a lockout says how long to wait, and the password stays to retry", async () => {
  const result: PasswordLoginResult = {
    ok: false,
    reason: "throttled",
    retryAfterSec: 32,
  };
  const screen = mount({ onPasswordLogin: async () => result });
  typePassword(screen.password, "guess");
  const done = settled(screen.card);
  screen.form.requestSubmit();
  await done;
  expect(screen.status.textContent).toBe(
    "Too many attempts. Try again in 32 s.",
  );
  expect(screen.password.value).toBe("guess");
});

test("a wrong password and a failed request each say so", async () => {
  const wrong = mount({
    onPasswordLogin: async () => ({ ok: false, reason: "wrong-password" }),
  });
  typePassword(wrong.password, "guess");
  let done = settled(wrong.card);
  wrong.form.requestSubmit();
  await done;
  expect(wrong.status.textContent).toBe("Wrong password. Try again.");
  document.body.replaceChildren();

  const offline = mount({
    onPasswordLogin: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  typePassword(offline.password, "guess");
  done = settled(offline.card);
  offline.form.requestSubmit();
  await done;
  expect(offline.status.textContent).toBe(
    "Couldn't sign in. Check your connection and try again.",
  );
});
