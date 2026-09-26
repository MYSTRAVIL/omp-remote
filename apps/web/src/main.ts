// First: it configures Zod before any schema below is built.
import "./zod-jitless";
import { notifyKey } from "@omp-remote/crypto";
import type { ControlFrame, DownlinkFrame } from "@omp-remote/protocol";
/// <reference lib="dom" />
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type { OrbState } from "thinking-orbs/engine";
import {
  AppearancePreferences,
  applyAppearance,
} from "./core/appearance-preferences";
import {
  type AuthDeps,
  type SignInMethods,
  authMethods,
  forgetSessionToken,
  hasRememberedSessionToken,
  listMachines,
  listPasskeys,
  loginPasskey,
  loginPassword,
  registerPasskey,
  rememberSessionToken,
  restoreSessionToken,
  revokeMachine,
  revokePasskey,
  sessionMethod,
  sessionTokenExpMs,
  setPasswordSignIn,
  signOutEverywhere,
} from "./core/auth";
import { capabilities } from "./core/capabilities";
import {
  type PairedMachine,
  PhoneClient,
  type SignOutReason,
  browserSocket,
} from "./core/client";
import { connectionStatus } from "./core/connection-state";
import { installSessionHistory } from "./core/history-nav";
import { randomId } from "./core/ids";
import { LaunchPreferences } from "./core/launch-preferences";
import { LocalClient } from "./core/local-client";
import { MachineCatalogs } from "./core/machine-catalogs";
import { MachineLabels } from "./core/machine-labels";
import { MachinePresence } from "./core/machine-presence";
import { NotifyAway } from "./core/notify-away";
import { claimPairing, takePairLinkCode, watchPairLinks } from "./core/pair";
import {
  forgetPairing,
  loadPairedMachines,
  pairedMachineIds,
  savePairing,
} from "./core/pairing-browser";
import { PushPreferences } from "./core/push-preferences";
import { PushEnrolment, type PushManagerLike } from "./core/push-subscribe";
import { AttachmentUploader } from "./core/resource-upload";
import { checkSession } from "./core/session-check";
import { SessionListCache } from "./core/session-list-cache";
import { SignInPreferences } from "./core/sign-in-preferences";
import { spawnFrame } from "./core/spawn-frame";
import { AppStore } from "./core/store";
import { type NotifyMachine, saveNotifyKeys } from "./core/sw-caches";
import {
  type NotificationTarget,
  OPEN_PARAM,
  OpenSessionMessage,
  openSessionTarget,
  sessionTag,
} from "./core/sw-push";
import { emptyTranscript } from "./core/transcript";
import { decideUpdateAction, readUpdateHistory } from "./core/update-policy";
import { registerServiceWorker } from "./register-sw";
import { pinShellToViewport } from "./ui/app-shell";
import { type SessionPulse, orbStateFor, sessionPulseFor } from "./ui/orb";
import { PairPrompt, type PairSource } from "./ui/pair-prompt";
import {
  type ControlHandlers,
  hasUnsentDraft,
  renderLoginView,
  renderSessionView,
  renderSpawnPending,
  renderTree,
} from "./ui/render";
import { UpdateNotice } from "./ui/update-notice";

// Replaced at build time (build.ts) with this bundle's short commit id.
declare const __OMP_BUILD_ID__: string;

// A `#pair=<code>` link comes off the address before anything else runs: no
// request, service worker or reload may carry the code. Once signed in, the
// pairing prompt asks before anything is claimed (see `connect`).
let pairLinkCode = takePairLinkCode(location, history);

// First, before anything paints: the theme and density chosen in Settings >
// Appearance, kept in step with each change and, for System, with the device.
const appearance = new AppearancePreferences();
applyAppearance(appearance);

const root = document.getElementById("app");
if (!root) throw new Error("missing #app root");
const app = root;
pinShellToViewport();

// Localhost dev mode: when served from a loopback origin, skip WebAuthn + pairing
// and talk straight to the host-agent's loopback client port. This can never
// trigger in production, which is served from the public aggregator domain.
const isLocalDev = ["localhost", "127.0.0.1", "[::1]"].includes(
  location.hostname,
);

// Passkey prompts open right now. An update reload would tear one down and
// fail its sign-in or step-up, so while one is open a new build is offered,
// not forced.
let openPasskeyPrompts = 0;
async function whilePasskeyOpen<T>(prompt: Promise<T>): Promise<T> {
  openPasskeyPrompts += 1;
  try {
    return await prompt;
  } finally {
    openPasskeyPrompts -= 1;
  }
}

const authDeps: AuthDeps = {
  baseUrl: location.origin,
  fetch: globalThis.fetch.bind(globalThis),
  startRegistration: (options) => whilePasskeyOpen(startRegistration(options)),
  startAuthentication: (options) =>
    whilePasskeyOpen(startAuthentication(options)),
};

// Storage is reached lazily so a denied `localStorage` only loses what it holds.
const deviceStorage = {
  getItem: (k: string) => localStorage.getItem(k),
  setItem: (k: string, v: string) => localStorage.setItem(k, v),
  removeItem: (k: string) => localStorage.removeItem(k),
};
// The last session list this device showed, painted on a cold load until the
// live snapshot replaces it. Cleared on sign-out.
const sessionListCache = new SessionListCache(deviceStorage);
// "Keep me signed in" on this device, edited in Settings > Account. Session
// titles stay on this device only for a remembered sign-in, so turning it off
// drops them along with the token.
const signIn = new SignInPreferences(deviceStorage);
signIn.subscribe(() => {
  if (!signIn.keepSignedIn) sessionListCache.persist(false);
});
// When this device last saw each machine online, shown in Settings > Machines.
const machinePresence = new MachinePresence(deviceStorage);
// Each machine's last-known model catalog, offered by the new-session dialog.
const store = new AppStore(
  Date.now,
  new MachineCatalogs(deviceStorage),
  sessionListCache,
  machinePresence,
);
// Names given to machines on this device; the store shows them in its tree.
const machineLabels = new MachineLabels(deviceStorage);
store.setMachineLabels(machineLabels.names);
// How long the user must be away from each machine before it pushes, chosen
// here per machine; each machine is told on every connect.
const awayPolicy = new NotifyAway(deviceStorage);

// Back-gesture support: mirror the tree↔session view in browser history so the
// Android/browser back gesture returns to the sessions list instead of leaving
// the PWA, and closes an open overlay (image viewer, dialog, drawer, menu)
// before anything else. Every selection flows through `nav` (see
// core/history-nav).
const nav = installSessionHistory({
  history,
  select: (id) => {
    store.select(id);
    closeSeenNotification();
  },
  onPopState: (handler) =>
    window.addEventListener("popstate", (event) => handler(event.state)),
});

// A phone-initiated spawn shows a waiting screen until the host reports the
// matching session; if none registers within this window, the screen flips to a
// failure the user can dismiss.
const SPAWN_TIMEOUT_MS = 60_000;
let spawnTimer: number | undefined;
function clearSpawnTimer(): void {
  if (spawnTimer !== undefined) {
    window.clearTimeout(spawnTimer);
    spawnTimer = undefined;
  }
}
function beginPendingSpawn(
  machineId: string,
  cwd: string,
  spawnId: string,
  resume: string | undefined,
): void {
  clearSpawnTimer();
  store.beginSpawn({ machineId, cwd, spawnId, resume });
  spawnTimer = window.setTimeout(() => {
    spawnTimer = undefined;
    store.failSpawn();
  }, SPAWN_TIMEOUT_MS);
}
function cancelPendingSpawn(): void {
  clearSpawnTimer();
  store.clearSpawn();
}
/**
 * Continue: reopen a session that ended this load as a resume spawn on its own
 * machine and project, with the saved default approval mode. omp restores the
 * session's own model; read the preference now, since Settings may change it.
 */
function continueSession(
  sessionId: string,
  spawn: ControlHandlers["onSpawn"],
): Promise<boolean> {
  const ended = store.endedSession(sessionId);
  if (!ended) return Promise.resolve(false);
  return spawn(ended.machineId, {
    cwd: ended.meta.cwd,
    approvalMode: new LaunchPreferences().approvalMode,
    resume: sessionId,
  });
}
let client: PhoneClient | undefined;
let sessionToken: string | undefined;
/**
 * The current client has been connected to the relay at least once. Before
 * that, the connection dot says "Connecting…"; after, "Reconnecting…".
 */
let relayConnectedOnce = false;

/** What the sign-in screen says when a sign-in ends while the app is open. */
const SIGNED_OUT_NOTICE: Record<SignOutReason, string> = {
  revoked: "You were signed out. Sign in again to continue.",
  expired: "Your sign-in expired. Sign in again to continue.",
};

/** This device's session token; the account requests run only while signed in. */
function signedInToken(): string {
  if (sessionToken === undefined) throw new Error("not signed in");
  return sessionToken;
}

// This device's push choices (Settings > Notifications) and its Web Push
// subscription, kept in step: registered at sign-in while push is on. The
// quiet choice is copied into Cache Storage, where the service worker reads
// it; local dev runs no service worker, so there is nothing to copy for.
// `globalThis.caches` is undefined outside a secure context.
const pushPreferences = new PushPreferences(
  isLocalDev ? undefined : globalThis.caches,
);
const push = new PushEnrolment({
  baseUrl: location.origin,
  fetch: globalThis.fetch.bind(globalThis),
  pushManager: async () =>
    (await swRegistration)?.pushManager as PushManagerLike | undefined,
  // Async, so a browser without the Notification API refuses instead of throwing.
  requestPermission: async () => Notification.requestPermission(),
  preferences: pushPreferences,
});

// One uploader for the sealed path; resource frames ride the channel directly
// (they are inert until a UV-gated prompt references the resulting id).
const uploader = new AttachmentUploader((machineId, frame) => {
  const channel = client?.channelFor(machineId);
  if (!channel) return false;
  channel.sendFrame(frame);
  return true;
});
store.setResourceSink((frame) => uploader.handleFrame(frame));

// A pairing status line kept OUTSIDE #app so the outcome survives the tree
// redraw a successful pair triggers.
const pairStatus = document.createElement("p");
pairStatus.className = "pair-status";
pairStatus.setAttribute("role", "status");
// Every code, typed or from a link, goes through this prompt: the machine is
// trusted (its host key saved) only once the user says the codes match.
const pairPrompt = new PairPrompt({
  claim: async (code) => {
    const token = sessionToken;
    if (token === undefined) throw new Error("signed out");
    return claimPairing(
      {
        baseUrl: location.origin,
        fetch: globalThis.fetch.bind(globalThis),
        token,
        getItem: (k) => localStorage.getItem(k),
        setItem: (k, v) => localStorage.setItem(k, v),
      },
      code,
    );
  },
  // `connect` re-reads the pairing blob, now carrying the new host key, so
  // the machine joins the tree.
  trust: async ({ machineId, hostPub }) => {
    const token = sessionToken;
    if (token === undefined) throw new Error("signed out");
    savePairing(
      (k) => localStorage.getItem(k),
      (k, v) => localStorage.setItem(k, v),
      machineId,
      hostPub,
    );
    await connect(token);
  },
});

// Control frames go straight onto the machine's sealed channel; false when it
// has none. The sign-in is the only passkey check.
function sendControl(machineId: string, frame: ControlFrame): boolean {
  const channel = client?.channelFor(machineId);
  if (!channel) return false;
  channel.sendFrame(frame);
  return true;
}

// Settings > About: this bundle's build and the builds this browser updated to.
const build = {
  id: __OMP_BUILD_ID__,
  updates: () => readUpdateHistory(deviceStorage),
};

const handlers: ControlHandlers = {
  onSelect: (id) => nav.open(id),
  onBack: () => nav.back(),
  onOverlay: (close) => nav.overlay(close),
  onPrompt: async (text, mode, attachments) => {
    const session = store.selectedSession();
    const machineId = store.selectedMachineId();
    if (!session || !machineId) return false;
    const sent = sendControl(machineId, {
      t: "prompt",
      sessionId: session.id,
      text,
      mode,
      attachments,
    });
    if (sent)
      store.addPendingPrompt(
        session.id,
        text,
        mode === "aside" ? "followUp" : mode,
      );
    return sent;
  },
  onInterrupt: async () => {
    const session = store.selectedSession();
    const machineId = store.selectedMachineId();
    if (!session || !machineId) return false;
    return sendControl(machineId, {
      t: "interrupt",
      sessionId: session.id,
    });
  },
  onServiceTier: async (sessionId, enabled) => {
    const machineId = store.machineIdForSession(sessionId);
    if (!machineId) return false;
    return sendControl(machineId, {
      t: "serviceTier",
      sessionId,
      enabled,
    });
  },
  onSetModel: async (sessionId, model) => {
    const machineId = store.machineIdForSession(sessionId);
    if (!machineId) return false;
    return sendControl(machineId, {
      t: "setModel",
      sessionId,
      model,
    });
  },
  onSetThinkingLevel: async (sessionId, level) => {
    const machineId = store.machineIdForSession(sessionId);
    if (!machineId) return false;
    return sendControl(machineId, {
      t: "setThinkingLevel",
      sessionId,
      level,
    });
  },
  onCompact: async (sessionId) => {
    const machineId = store.machineIdForSession(sessionId);
    if (!machineId) return false;
    return sendControl(machineId, {
      t: "compact",
      sessionId,
    });
  },
  onCloseSession: async (sessionId) => {
    const machineId = store.machineIdForSession(sessionId);
    if (!machineId) return false;
    return sendControl(machineId, { t: "closeSession", sessionId });
  },
  onUpload: async (sessionId, file, onProgress) => {
    const machineId = store.machineIdForSession(sessionId);
    if (!machineId) throw new Error("session has no machine");
    return uploader.upload(machineId, sessionId, file, onProgress);
  },
  // A read like `sync`: straight onto the sealed channel. The channel is
  // checked first so a fetch that cannot go yet is not spent; the next draw
  // asks again.
  onMediaFetch: (sessionId, mediaId) => {
    const machineId = store.machineIdForSession(sessionId);
    const channel =
      machineId === undefined ? undefined : client?.channelFor(machineId);
    if (channel && store.claimMediaFetch(sessionId, mediaId))
      channel.sendFrame({ t: "mediaFetch", sessionId, mediaId });
  },
  onSpawn: async (machineId, opts) => {
    const spawnId = randomId();
    const sent = sendControl(machineId, spawnFrame(machineId, opts, spawnId));
    if (sent) beginPendingSpawn(machineId, opts.cwd, spawnId, opts.resume);
    return sent;
  },
  onContinue: (sessionId) => continueSession(sessionId, handlers.onSpawn),
  // A read like `sync`: straight onto the sealed channel, no passkey check.
  // The held answer is dropped first, so the list loads afresh.
  history: {
    request: (machineId, cwd) => {
      const channel = client?.channelFor(machineId);
      if (!channel) return false;
      store.clearHistory(machineId, cwd);
      channel.sendFrame({ t: "historyRequest", cwd });
      return true;
    },
    entries: (machineId, cwd) => store.historyFor(machineId, cwd),
  },
  onCancelSpawn: cancelPendingSpawn,
  onInteractionReply: async (sessionId, id, response) => {
    const machineId = store.machineIdForSession(sessionId);
    if (
      !store.pendingInteractions(sessionId).some((request) => request.id === id)
    )
      return true;
    if (!machineId) return false;
    const sent = sendControl(machineId, {
      t: "interactionReply",
      sessionId,
      id,
      response,
    });
    if (sent) store.dismissInteraction(sessionId, id);
    return sent;
  },
  onPair: (code) => pairAndRefresh(code, "typed"),
  onSignOut: signOut,
  onRenameMachine: renameMachine,
  onForgetMachine: forgetAndRefresh,
  pairedMachines: () => {
    const names = machineLabels.names;
    return new Map(
      pairedMachineIds((k) => localStorage.getItem(k)).map((machineId) => [
        machineId,
        names.get(machineId) ?? machineId,
      ]),
    );
  },
  machineLastSeen: (machineId) => machinePresence.lastSeen(machineId),
  notifyAway: {
    awaySec: (machineId) => awayPolicy.awaySec(machineId),
    setAwaySec: (machineId, awaySec) => {
      const saved = awayPolicy.set(machineId, awaySec);
      client?.sendNotifyPolicy(machineId);
      return saved;
    },
  },
  push,
  build,
  relayState: () => client?.relayState ?? "offline",
  connectionStatus: () =>
    connectionStatus({
      relay: client?.relayState ?? "offline",
      connectedOnce: relayConnectedOnce,
      networkOnline: navigator.onLine,
    }),
  onRetryConnection: () => client?.wake(),
  appearance,
  // Async, so a request made after sign-out rejects instead of throwing.
  account: {
    get method() {
      return sessionMethod(sessionToken ?? "") ?? "passkey";
    },
    passkeyAvailable: capabilities().passkey,
    methods: async () => authMethods(authDeps),
    passkeys: async () => listPasskeys(authDeps, signedInToken()),
    revokePasskey: async (credentialId, check) =>
      revokePasskey(authDeps, signedInToken(), credentialId, check),
    addPasskey: async (check) =>
      registerPasskey(authDeps, signedInToken(), check),
    machines: async () => listMachines(authDeps, signedInToken()),
    revokeMachine: async (machineId, check) =>
      revokeMachine(authDeps, signedInToken(), machineId, check),
    setPasswordSignIn: async (enabled, check) =>
      setPasswordSignIn(authDeps, signedInToken(), enabled, check),
    signOutEverywhere: async (check) =>
      signOutEverywhere(authDeps, signedInToken(), check),
  },
  signIn,
};

/** The active handler set; swapped to loopback senders in local dev mode. */
let activeHandlers: ControlHandlers = handlers;

// Drive the app straight from the loopback host-agent: no auth, no aggregator.
// The store renders identically because the loopback frames are the same
// `ClientMessage`s the sealed phone path carries.
function connectLocal(): void {
  const local = new LocalClient(store);
  const send = (frame: DownlinkFrame): true => {
    local.send(frame);
    return true;
  };
  const localUploader = new AttachmentUploader((_machineId, frame) => {
    local.send(frame);
    return true;
  });
  store.setResourceSink((frame) => localUploader.handleFrame(frame));
  activeHandlers = {
    onSelect: (id) => nav.open(id),
    onBack: () => nav.back(),
    onOverlay: (close) => nav.overlay(close),
    onPrompt: async (text, mode, attachments) => {
      const session = store.selectedSession();
      if (!session) return false;
      const sent = send({
        t: "prompt",
        sessionId: session.id,
        text,
        mode,
        attachments,
      });
      if (sent)
        store.addPendingPrompt(
          session.id,
          text,
          mode === "aside" ? "followUp" : mode,
        );
      return sent;
    },
    onInterrupt: async () => {
      const session = store.selectedSession();
      return session ? send({ t: "interrupt", sessionId: session.id }) : false;
    },
    onServiceTier: async (sessionId, enabled) =>
      send({ t: "serviceTier", sessionId, enabled }),
    onSetModel: async (sessionId, model) =>
      send({ t: "setModel", sessionId, model }),
    onSetThinkingLevel: async (sessionId, level) =>
      send({ t: "setThinkingLevel", sessionId, level }),
    onCompact: async (sessionId, instructions) =>
      send({ t: "compact", sessionId, instructions }),
    onCloseSession: async (sessionId) => send({ t: "closeSession", sessionId }),
    onUpload: async (sessionId, file, onProgress) => {
      const machineId = store.machineIdForSession(sessionId) ?? sessionId;
      return localUploader.upload(machineId, sessionId, file, onProgress);
    },
    onMediaFetch: (sessionId, mediaId) => {
      if (store.claimMediaFetch(sessionId, mediaId))
        send({ t: "mediaFetch", sessionId, mediaId });
    },
    onSpawn: async (machineId, opts) => {
      const spawnId = randomId();
      const sent = send(spawnFrame(machineId, opts, spawnId));
      if (sent) beginPendingSpawn(machineId, opts.cwd, spawnId, opts.resume);
      return sent;
    },
    onContinue: (sessionId) =>
      continueSession(sessionId, activeHandlers.onSpawn),
    history: {
      request: (machineId, cwd) => {
        store.clearHistory(machineId, cwd);
        return send({ t: "historyRequest", cwd });
      },
      entries: (machineId, cwd) => store.historyFor(machineId, cwd),
    },
    onCancelSpawn: cancelPendingSpawn,
    onRenameMachine: renameMachine,
    onInteractionReply: async (sessionId, id, response) => {
      const ok = send({ t: "interactionReply", sessionId, id, response });
      store.dismissInteraction(sessionId, id);
      return ok;
    },
    machineLastSeen: (machineId) => machinePresence.lastSeen(machineId),
    build,
    appearance,
  };
  local.start();
  draw();
}

function orbFor(id: string): OrbState | null {
  return orbStateFor(store.transcriptFor(id), store.needsAttention(id));
}

function pulseFor(id: string): SessionPulse | null {
  return sessionPulseFor(
    store.transcriptFor(id),
    store.needsAttention(id),
    store.pendingInteractions(id).length > 0,
  );
}

function draw(): void {
  const connecting = store.connecting();
  const rail = {
    tree: store.tree(),
    sessionPulse: pulseFor,
    orbState: orbFor,
    connecting,
  };
  const pending = store.pendingSpawn();
  if (pending) {
    renderSpawnPending(app, pending, activeHandlers, rail);
    return;
  }
  const selected = store.selectedSession();
  if (selected)
    renderSessionView(
      app,
      selected,
      store.transcriptFor(selected.id) ?? emptyTranscript(),
      activeHandlers,
      store.pendingInteractions(selected.id),
      store.catalogFor(selected.id),
      rail,
    );
  else renderTree(app, rail.tree, activeHandlers, pulseFor, orbFor, connecting);
}

// A replay or a busy stream lands many frames per animation frame; the store
// changes on each, but the screen is redrawn once per frame.
let drawFrame: number | undefined;
function scheduleDraw(): void {
  if (drawFrame !== undefined) return;
  drawFrame = requestAnimationFrame(() => {
    drawFrame = undefined;
    draw();
  });
}

// The service worker opens each machine's sealed push notices with the key its
// pairing derives (`notifyKey(rx)`) and names the machine as this device does,
// so both are copied into Cache Storage for it whenever the paired machines
// load (sign-in, pair, forget) and after a rename. Copies run one at a time,
// each writing the machines and names as they are when it runs, so the newest
// is the one left. Local dev runs no service worker; `globalThis.caches` is
// undefined outside a secure context.
const workerCaches = isLocalDev ? undefined : globalThis.caches;
let pairedForWorker: readonly PairedMachine[] = [];
let notifyKeysCopied = Promise.resolve();
function copyNotifyKeys(): void {
  if (workerCaches === undefined) return;
  notifyKeysCopied = notifyKeysCopied
    .then(async () => {
      const machines = new Map<string, NotifyMachine>();
      for (const { machineId, keys } of pairedForWorker)
        machines.set(machineId, {
          key: await notifyKey(keys.rx),
          label: machineLabels.names.get(machineId) ?? machineId,
        });
      await saveNotifyKeys(workerCaches, machines);
    })
    .catch(() => {
      // Unwritable: the worker keeps its last copy, and a machine it has no
      // key for gets the generic notification.
    });
}

/**
 * Close the notification of the session the user now sees: selected while
 * this page is on screen, or on screen again with it selected. The worker
 * shows one per session, under its session tag.
 */
function closeSeenNotification(): void {
  const container = isLocalDev ? undefined : navigator.serviceWorker;
  const session = store.selectedSession();
  const machineId = store.selectedMachineId();
  if (
    !container ||
    document.visibilityState !== "visible" ||
    session === undefined ||
    machineId === undefined
  )
    return;
  const tag = sessionTag(machineId, session.id);
  void container.ready
    .then(async (registration) => {
      for (const shown of await registration.getNotifications({ tag }))
        shown.close();
    })
    .catch(() => {
      // No notifications to close where the worker can't be reached.
    });
}

/** The session a tapped notification asked for while signed out, opened at sign-in. */
let notifiedSession: string | undefined;

/**
 * Open the session a tapped notification stands for, as a tap in the session
 * list does; signed out, it opens once signed in. One from a machine no
 * longer paired here is ignored.
 */
function openNotified(target: NotificationTarget): void {
  const paired = pairedMachineIds((k) => localStorage.getItem(k));
  if (!paired.includes(target.machineId)) return;
  if (client === undefined) notifiedSession = target.sessionId;
  else activeHandlers.onSelect(target.sessionId);
}

async function connect(token: string): Promise<void> {
  sessionToken = token;
  const machines = await loadPairedMachines((k) => localStorage.getItem(k));
  pairedForWorker = machines;
  copyNotifyKeys();
  const wsUrl = `${location.origin.replace(/^http/, "ws")}/client?token=${encodeURIComponent(token)}`;
  // Rebuild from scratch: tear down any previous client so re-connecting after a
  // pair never leaves a second live socket. `draw` is subscribed once at boot.
  client?.stop();
  // `relayConnectedOnce` spans the sign-in, not one client: a rebuild (after a
  // pair or a forget) while the relay is unreachable still says reconnecting.
  const next = new PhoneClient(() => browserSocket(wsUrl), machines, store, {
    // Settings > About and the connection dot show the relay link, so a
    // change redraws.
    onRelayState: (state) => {
      if (state === "connected") relayConnectedOnce = true;
      scheduleDraw();
    },
    // The relay ended this sign-in ("revoked": a passkey was revoked, or every
    // device was signed out, possibly from another device), or its token ran
    // out or is no longer accepted ("expired"): straight to the sign-in screen.
    onSignedOut: (reason) => signOut(SIGNED_OUT_NOTICE[reason]),
    tokenExpiresAt: sessionTokenExpMs(token),
    checkSession: () => checkSession(authDeps, token),
    notifyAwaySec: (machineId) => awayPolicy.awaySec(machineId),
  });
  client = next;
  next.start();
  // A token already expired signs out synchronously inside start(): the login
  // screen is up and this client is gone, so draw no workspace for it.
  if (client !== next) return;
  draw();
  void push.signedIn(token);
  // A notification tapped before sign-in opens its session now.
  const notified = notifiedSession;
  notifiedSession = undefined;
  if (notified !== undefined) activeHandlers.onSelect(notified);
  // A pairing link opened before sign-in is offered now; nothing is claimed
  // until the user presses Pair.
  const linked = pairLinkCode;
  pairLinkCode = undefined;
  if (linked !== undefined) void pairAndRefresh(linked, "link");
}

// Forget a remembered device: drop the stored token, tear the client down, and
// return to the login screen, which shows `notice` when given. Works whether
// or not the token was persisted.
function signOut(notice?: string): void {
  forgetSessionToken(localStorage);
  sessionListCache.clear();
  sessionToken = undefined;
  relayConnectedOnce = false;
  client?.stop();
  client = undefined;
  void renderLogin(notice);
}

// Pair a new machine through the prompt (a link's code asks first), then say
// which one was paired. Signed out, a code waits for the next sign-in.
async function pairAndRefresh(code: string, source: PairSource): Promise<void> {
  if (sessionToken === undefined) {
    pairLinkCode = code;
    return;
  }
  pairStatus.textContent = "";
  const machineId = await pairPrompt.pair(code, source);
  if (machineId !== undefined) pairStatus.textContent = `Paired ${machineId}.`;
}

// Name a machine on this device only; the store overlays the name on its tree,
// so the rail, session header and dialogs all show it.
function renameMachine(machineId: string, label: string): boolean {
  const saved = machineLabels.rename(machineId, label);
  store.setMachineLabels(machineLabels.names);
  copyNotifyKeys();
  // Redraw now: the settings row regains focus right after this returns, and a
  // reorder deferred to the next frame would detach the focused row.
  draw();
  return saved;
}

// Forget a machine on this browser only: drop its host key from the pairing
// blob (the phone identity and other machines stay), its name on this device
// and everything the store holds for it, then rebuild the client without it.
// The host keeps running and pairs again with a new code; nothing is revoked
// host-side.
async function forgetAndRefresh(machineId: string): Promise<boolean> {
  forgetPairing(
    (k) => localStorage.getItem(k),
    (k, v) => localStorage.setItem(k, v),
    machineId,
  );
  // Stop the old client first so a frame already in flight can't re-add it.
  client?.stop();
  client = undefined;
  machineLabels.rename(machineId, "");
  store.setMachineLabels(machineLabels.names);
  store.forgetMachine(machineId);
  // Its notices stop opening at once, even if reconnecting fails below.
  pairedForWorker = pairedForWorker.filter(
    (machine) => machine.machineId !== machineId,
  );
  copyNotifyKeys();
  // The forget is done once storage is written; a failed reconnect is reported
  // separately so the user isn't told to retry a forget that already happened.
  if (sessionToken === undefined) return true;
  try {
    await connect(sessionToken);
    return true;
  } catch {
    draw();
    return false;
  }
}

/** A new sign-in: keep it as chosen, then open the workspace with it. */
async function signedIn(token: string, remember: boolean): Promise<void> {
  // The choice made here is this device's Keep me signed in from now on; off
  // also forgets a sign-in remembered before.
  signIn.setKeepSignedIn(remember);
  if (remember) rememberSessionToken(localStorage, token);
  // Session titles stay on this device only for a remembered sign-in.
  sessionListCache.persist(remember);
  await connect(token);
}

async function renderLogin(notice?: string): Promise<void> {
  // A redraw queued before sign-out must not paint the tree over the login.
  if (drawFrame !== undefined) cancelAnimationFrame(drawFrame);
  drawFrame = undefined;
  // Unreachable, the relay can't say: offer every sign-in this browser can
  // do, and the attempt reports the failure.
  const methods: SignInMethods = await authMethods(authDeps).catch(() => ({
    password: true,
    passkey: true,
  }));
  // Signed in meanwhile (a remembered token restored, say): stay there.
  if (sessionToken !== undefined) return;
  const status = document.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");
  renderLoginView(
    app,
    {
      methods,
      passkeyAvailable: capabilities().passkey,
      onPasswordLogin: async (password, remember) => {
        const result = await loginPassword(authDeps, password, remember);
        if (result.ok) await signedIn(result.token, remember);
        return result;
      },
      onPasskeyLogin: async (remember) => {
        status.textContent = "Waiting for passkey…";
        try {
          const result = await loginPasskey(authDeps, remember);
          if (result.verified && result.token)
            await signedIn(result.token, remember);
          else status.textContent = "Sign-in failed.";
        } catch {
          status.textContent = "Sign-in failed.";
        }
      },
    },
    status,
    signIn.keepSignedIn,
  );
  // Set once the live region is on screen, so assistive technology reads it.
  if (notice !== undefined) status.textContent = notice;
}

// Register the service worker up front; its `pushManager` is reused to enrol for
// attention pushes after login.
const swRegistration = isLocalDev
  ? Promise.resolve(undefined)
  : registerServiceWorker(navigator, "/sw.js");
// Apply a new deploy: when a freshly installed SW claims this page, the new
// shell (main.js/styles.css) only runs after a reload. Reload at once and say
// so on the next load; when a session holds an unsent draft, offer the reload
// instead so the draft survives until the user is ready. Guarded to fire once,
// and never on the first-ever install (no prior controller).
const updateNotice = new UpdateNotice({
  storage: {
    getItem: (k) => sessionStorage.getItem(k),
    setItem: (k, v) => sessionStorage.setItem(k, v),
    removeItem: (k) => sessionStorage.removeItem(k),
  },
  history: deviceStorage,
  reload: () => location.reload(),
});
updateNotice.announce(__OMP_BUILD_ID__);
if (!isLocalDev && navigator.serviceWorker) {
  let handled = false;
  const hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (handled || !hadController) return;
    handled = true;
    updateNotice.apply(
      decideUpdateAction({
        hasDraft: hasUnsentDraft(app),
        passkeyOpen: openPasskeyPrompts > 0,
      }),
    );
  });
  // A tapped notification asks this window to open its session.
  navigator.serviceWorker.addEventListener("message", (event) => {
    const message = OpenSessionMessage.safeParse(event.data);
    if (message.success) openNotified(message.data);
  });
}
document.body.append(pairStatus, pairPrompt.node);
// Resolve a pending spawn the moment the host reports its session (matched by
// the spawnId nonce), opening it through `nav` so history stays correct.
// Registered before `draw` so the session view replaces the waiting screen in
// one pass.
store.subscribe(() => {
  if (store.pendingSpawn()?.status !== "waiting") return;
  const id = store.resolveSpawn();
  if (id === undefined) return;
  clearSpawnTimer();
  store.clearSpawn();
  nav.open(id);
});
store.subscribe(scheduleDraw);
// Settings > Notifications shows the push registration as it settles; once
// signed out, nothing may paint the workspace over the login screen.
push.subscribe(() => {
  if (client) scheduleDraw();
});

// Resume from background: a suspended tab freezes the keepalive, so the relay
// may have idle-closed the socket while the client never saw it (half-open).
// Visible again, the client probes: a healthy link stays (no redial, no full
// resync), a dead or down one redials at once. The network coming back or a
// bfcache restore redials outright.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") return;
  closeSeenNotification();
  client?.probe();
});
// The connection dot follows the network too; the redial alone may leave the
// relay link state unchanged (already dialling), so redraw either way.
window.addEventListener("online", () => {
  client?.wake();
  if (client) scheduleDraw();
});
window.addEventListener("offline", () => {
  if (client) scheduleDraw();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) client?.wake();
});
// Auto-connect a remembered device when its token is still unexpired (the
// aggregator re-verifies the signature and can still reject it); otherwise show
// the login screen. A stale or malformed stored token is cleared, not presented,
// and the login screen says the sign-in expired.
if (isLocalDev) {
  store.restoreCachedList();
  connectLocal();
} else {
  // A window opened by a tapped notification starts on its session. The
  // parameter comes off the address first, so a reload starts on the list.
  const address = new URL(location.href);
  const target = openSessionTarget(
    address.search,
    pairedMachineIds((k) => localStorage.getItem(k)),
  );
  if (address.searchParams.has(OPEN_PARAM)) {
    address.searchParams.delete(OPEN_PARAM);
    history.replaceState(history.state, "", address);
  }
  if (target !== undefined) openNotified(target);
  // A link opened while the app is open changes only the fragment: its code
  // comes off the address the same way and waits for the same prompt.
  watchPairLinks(window, location, history, (code) => {
    void pairAndRefresh(code, "link");
  });
  const hadSignIn = hasRememberedSessionToken(localStorage);
  const remembered = restoreSessionToken(localStorage, Date.now());
  if (remembered !== undefined) {
    // Paint the last known list at once; the live snapshot replaces it.
    store.restoreCachedList();
    void connect(remembered);
  } else {
    // No remembered sign-in: a list left by an expired one must not linger.
    sessionListCache.clear();
    void renderLogin(hadSignIn ? SIGNED_OUT_NOTICE.expired : undefined);
  }
}
