/// <reference lib="dom" />
// Throwaway harness: the real workspace with Settings > Account open. Its
// passkey requests go through the real API client to a fake relay in this
// page, so every state can be eyeballed and screenshotted without a relay or a
// passkey. Query parameters pick the state:
//   ?passkeys=1           only this device's passkey (Revoke off, with why)
//   ?list=loading|error   the passkey list never answers, or fails
//   ?revoke=403|404|409   Revoke is refused with that status
//   ?everywhere=403       Sign out everywhere fails its passkey check
//   ?prompt=wait|cancel   the passkey prompt never answers, or is dismissed
// Theme and density follow Settings > Appearance, as in the app.
import { z } from "zod";
import {
  AppearancePreferences,
  applyAppearance,
} from "../src/core/appearance-preferences";
import {
  type AuthDeps,
  type Passkey,
  listPasskeys,
  revokePasskey,
  signOutEverywhere,
} from "../src/core/auth";
import type { MachineNode } from "../src/core/session-tree";
import { SignInPreferences } from "../src/core/sign-in-preferences";
import { pinShellToViewport } from "../src/ui/app-shell";
import {
  type ControlHandlers,
  renderLoginView,
  renderTree,
} from "../src/ui/render";

const params = new URLSearchParams(location.search);
const appearance = new AppearancePreferences();
applyAppearance(appearance);
pinShellToViewport();

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const now = Date.now();
let passkeys: Passkey[] = [
  { id: "legacy01", createdAt: null, lastUsedAt: null, current: false },
  {
    id: "phone7Qx",
    createdAt: now - 40 * DAY,
    lastUsedAt: now - 3 * DAY,
    current: false,
  },
  {
    id: "deskT3xw",
    createdAt: now - 16 * DAY,
    lastUsedAt: now - 2 * MINUTE,
    current: true,
  },
];
if (params.get("passkeys") === "1")
  passkeys = passkeys.filter((passkey) => passkey.current);

/** The relay's error body for each refusal status (the account contract). */
const REFUSALS: Record<string, string> = {
  "401": "unauthorized",
  "403": "passkey check failed",
  "404": "not found",
  "409": "last passkey",
};
const RevokeBody = z.object({ credentialId: z.string() });
const unanswered = new Promise<never>(() => {});

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The fake relay: the account routes as the aggregator answers them. */
async function relay(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const path = new URL(String(input)).pathname;
  if (path === "/auth/account/passkeys") {
    if (params.get("list") === "loading") return unanswered;
    if (params.get("list") === "error")
      return answer(500, { error: "internal" });
    return answer(200, { passkeys });
  }
  if (path === "/auth/account/challenge")
    return answer(200, { flowId: "preview", options: { challenge: "cHJl" } });
  if (path === "/auth/account/passkeys/revoke") {
    const refused = params.get("revoke");
    if (refused !== null)
      return answer(Number(refused), { error: REFUSALS[refused] });
    const { credentialId } = RevokeBody.parse(JSON.parse(String(init?.body)));
    const revoked = passkeys.find((passkey) => passkey.id === credentialId);
    passkeys = passkeys.filter((passkey) => passkey.id !== credentialId);
    return answer(200, { revoked: true, signedOut: revoked?.current === true });
  }
  if (path === "/auth/account/sign-out-everywhere") {
    const refused = params.get("everywhere");
    if (refused !== null)
      return answer(Number(refused), { error: REFUSALS[refused] });
    return answer(200, { signedOut: true });
  }
  return answer(404, { error: "not found" });
}

const auth: AuthDeps = {
  baseUrl: location.origin,
  fetch: relay as typeof fetch,
  // Boundary casts: stand-ins for the library's ceremonies.
  startRegistration: (async () => {
    throw new Error("unused");
  }) as unknown as AuthDeps["startRegistration"],
  startAuthentication: (async () => {
    const prompt = params.get("prompt");
    if (prompt === "wait") await unanswered;
    if (prompt === "cancel")
      throw new DOMException("The request was dismissed.", "NotAllowedError");
    return {
      id: "preview",
      rawId: "preview",
      response: {},
      type: "public-key",
    };
  }) as unknown as AuthDeps["startAuthentication"],
};
const token = "preview.token";
const signIn = new SignInPreferences(localStorage);

const app = document.getElementById("app");
if (!app) throw new Error("missing #app");
const root = app;

const noop = (): void => {};
const handlers: ControlHandlers = {
  onSelect: noop,
  onBack: noop,
  onOverlay: () => ({ dismiss: noop }),
  onPrompt: async () => true,
  onInterrupt: async () => true,
  onServiceTier: async () => true,
  onSetModel: async () => true,
  onSetThinkingLevel: async () => true,
  onCompact: async () => true,
  onCloseSession: async () => true,
  onUpload: async () => "resource",
  onSpawn: async () => true,
  onCancelSpawn: noop,
  onInteractionReply: async () => true,
  onRenameMachine: () => true,
  // As main.ts does: the passkey screen replaces the workspace.
  onSignOut: (notice) => {
    const status = document.createElement("p");
    renderLoginView(
      root,
      { onLogin: async () => {}, onRegister: async () => false },
      status,
      signIn.keepSignedIn,
    );
    if (notice !== undefined) status.textContent = notice;
  },
  account: {
    passkeys: () => listPasskeys(auth, token),
    revokePasskey: (credentialId) => revokePasskey(auth, token, credentialId),
    signOutEverywhere: () => signOutEverywhere(auth, token),
  },
  signIn,
  appearance,
};

const tree: MachineNode[] = [
  {
    machineId: "my-desktop",
    label: "my-desktop",
    projects: [
      {
        project: "omp-remote",
        sessions: [
          {
            id: "a",
            cwd: "/home/me/omp-remote",
            project: "omp-remote",
            model: "opus",
            title: "Add passkey management",
            pid: 1,
            startedAt: now - 30 * MINUTE,
          },
        ],
      },
    ],
  },
];
renderTree(root, tree, handlers);
root.querySelector<HTMLButtonElement>("button.settings")?.click();
