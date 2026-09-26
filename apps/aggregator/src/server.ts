import { MachineId } from "@omp-remote/config";
import {
  PairClaimRequest,
  PairHostRequest,
  PairResultRequest,
} from "@omp-remote/protocol";
import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";
import { BlindRouter, type RouterPeer, type RouterPort } from "./blind-router";
import { CollabRelay, type CollabRole } from "./collab-relay";
import type { MachineStore } from "./machine-store";
import { type PairingBroker, PairingBrokerError } from "./pairing";
import type { PushService } from "./push";
import type { SessionTokenPayload } from "./session-token";
import { serveStatic } from "./static";
import { NewPushSubscription } from "./vapid";
import type { PasswordRefusal, StepUp, WebAuthnGate } from "./webauthn";

export interface AggregatorConfig {
  /**
   * The machines allowed to dial `/agent`, each by its own token presented as
   * `Authorization: Bearer` on the upgrade. A token claims only its own
   * machineId's route. Pairing issues the token; the owner can revoke it.
   */
  machines: MachineStore;
  /** TCP port to bind; `0` picks a free port (read back via `boundPort`). */
  port: number;
  /** Bind address; defaults to loopback (the nginx upstream on the aggregator server). */
  hostname?: string;
  /**
   * Whether a loopback peer is a reverse proxy that sets `X-Real-IP` to the
   * client it serves (nginx, or Caddy with `header_up X-Real-IP
   * {remote_host}`), so its value keys the per-client limits (see
   * `clientAddress`). Default false: forwarded headers are ignored, since a
   * proxy that passes the client's own `X-Real-IP` through would let every
   * request pick its own key.
   */
  trustProxy?: boolean;
  /**
   * Per-socket outbound cap in bytes: a socket whose unsent backlog is over it
   * is closed with 1013 so its peer reconnects and resyncs (see `WsPort`).
   */
  maxBufferedBytes?: number;
  /** Idle seconds before Bun closes a silent socket (keepalive window). */
  idleTimeoutSec?: number;
  /**
   * How often (ms) open `/client` sockets are rechecked: one whose token has
   * expired, or whose session is signed out by a change made outside this
   * process (the password set again), is closed 4401. Default 30 s.
   */
  clientRecheckMs?: number;
  /**
   * Access gate: password sign-in, and passkeys when it has a `publicUrl`.
   * When present, `/client` requires a valid session token (`?token=`) and the
   * `/auth/*` HTTP endpoints are served. When absent, `/client` is open (local
   * dev + the blind-relay tests).
   */
  auth?: WebAuthnGate;
  /**
   * Web Push attention fan-out. When present, `GET /push/vapid` and
   * `POST /push/subscription` are served, and a registered agent's clear
   * `{type:"attention"}` control triggers a push (spec §4.3) carrying, if the
   * agent sent one, its sealed notice — opaque bytes the aggregator cannot read.
   */
  push?: PushService;
  /**
   * Content-blind pairing broker. When present, `POST /pair/host` and
   * `POST /pair/result` (open: the rendezvous id is derived from the 128-bit
   * code) plus `POST /pair/claim` (session-token gated when auth is on) run
   * the brokered pairing ceremony (spec §7, §12). A claim issues the
   * machine's `/agent` token, which the host collects with its result. Only
   * public keys, MACs, a machine label, and a code-derived rendezvous id cross
   * it besides — never a private/session key.
   */
  pairing?: PairingBroker;
  /**
   * When true, serve the Collab relay wire at `/r/<roomId>?role=host|guest`
   * (additive, content-blind: only the 4-byte peerId header is touched). Lets
   * omp sessions host their Collab rooms here instead of `my.omp.sh`.
   */
  collabRelay?: boolean;
  /**
   * Directory holding the built PWA. When set, any GET/HEAD that no API route
   * claims is served from it with an SPA fallback to `index.html`.
   */
  webRoot?: string;
}

type Endpoint = "agent" | "client" | "collab";
export interface SocketData {
  readonly endpoint: Endpoint;
  port: WsPort | undefined;
  /**
   * For a client whose token was authentic: the session it carried, checked
   * for revocation on open, again whenever a revoke, sign-out-everywhere, or
   * password sign-in change lands, and for expiry or a password change at
   * every recheck (`clientRecheckMs`).
   */
  readonly session?: SessionTokenPayload;
  /**
   * For a client: its session was already signed out when it dialled (see
   * `WebAuthnGate.isSignedOut`), so it is closed as signed out on open.
   */
  readonly signedOut?: boolean;
  /**
   * The router role of an `/agent` or `/client` socket, fixed at upgrade — for
   * an agent, the machineId its token is bound to. Unset for collab.
   */
  readonly peer?: RouterPeer;
  /** Collab room membership, assigned on open for the `/r/<roomId>` endpoint. */
  collab?: { roomId: string; role: CollabRole; peerId: number };
}

/**
 * Per-socket unsent-backlog cap. Over it the socket closes with 1013. Sized to
 * hold one whole sealed image (an 8 MiB `MAX_RESOURCE_BYTES` image is ~14 MiB
 * as base64 chunks sealed and base64-wrapped again), so fetching one image on a
 * phone slower than the host does not trip the close it would then repeat.
 */
const DEFAULT_MAX_BUFFERED = 16 << 20; // 16 MiB
const DEFAULT_IDLE_TIMEOUT_SEC = 120;
/** Default `clientRecheckMs`: the phone's own keepalive period. */
const DEFAULT_CLIENT_RECHECK_MS = 30_000;
/**
 * Largest HTTP request body the server reads; over it Bun answers 413 unread.
 * Every body it accepts is small JSON — a pairing request, a password, a
 * push subscription, a WebAuthn response (attestation "none", so no
 * certificate chain) — while Bun's default of 128 MiB would let one request
 * park that much in memory. WebSocket frames have their own limit.
 */
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
/**
 * Close code + reason for a `/client` socket whose session was signed out
 * (its passkey removed, signed out everywhere, password sign-in turned off, or
 * the password changed) — 4401, the app-range echo of 401.
 */
const SIGNED_OUT_CODE = 4401;
const SIGNED_OUT_REASON = "signed out";
/**
 * Close code for an `/agent` socket whose token no longer admits it — 4403,
 * the app-range echo of 403 — with the reason: the owner revoked the machine,
 * or a re-pair issued it a new token.
 */
const REVOKED_CODE = 4403;
const REVOKED_REASON = "machine revoked";
const REPLACED_REASON = "token replaced";

/** A machine as the owner's account view lists it (epoch ms). */
interface MachineView {
  machineId: string;
  joinedAt: number;
  lastSeenAt?: number;
  /** Whether its agent is registered on the router right now. */
  online: boolean;
}

/** The machine registry, as the account routes see it. */
interface AccountMachines {
  list(): MachineView[];
  /** Revoke the machine's token and close its sockets; false when unknown. */
  revoke(machineId: string): Promise<boolean>;
}
/**
 * Close code + reason for a socket whose unsent backlog outgrew the cap — 1013
 * "Try Again Later": its peer reconnects and resyncs instead of losing frames.
 */
const BACKPRESSURE_CODE = 1013;
const BACKPRESSURE_REASON = "backpressure";

/**
 * A `ServerWebSocket` seen through the router's `RouterPort` lens. Outbound is
 * bounded: once the socket's unsent backlog is over the cap, the port closes
 * with 1013 "backpressure" instead of queueing more (a slow peer can't OOM the
 * VPS) or dropping the frame (a dropped sealed frame would silently desync the
 * E2E stream). Every peer takes the close as transient: the phone and the
 * host-agent reconnect and resync, and omp's Collab client reconnects. Once the
 * port is closed — on overflow or by the relay — every send is a no-op.
 */
export class WsPort implements RouterPort {
  readonly id: string;
  readonly #ws: ServerWebSocket<SocketData>;
  readonly #maxBuffered: number;
  #closed = false;
  constructor(
    id: string,
    ws: ServerWebSocket<SocketData>,
    maxBuffered: number,
  ) {
    this.id = id;
    this.#ws = ws;
    this.#maxBuffered = maxBuffered;
  }
  send(raw: string): void {
    if (this.#writable()) this.#ws.send(raw);
  }
  sendText(text: string): void {
    this.send(text);
  }
  sendBinary(data: Uint8Array): void {
    if (this.#writable()) this.#ws.send(data);
  }
  close(code?: number, reason?: string): void {
    if (this.#closed) return;
    // Marked first: Bun runs the close handler synchronously, so anything it
    // triggers already sees this port closed.
    this.#closed = true;
    this.#ws.close(code, reason);
  }
  /** Whether a frame may be queued now; a port over the cap closes instead. */
  #writable(): boolean {
    if (this.#closed) return false;
    if (this.#ws.getBufferedAmount() <= this.#maxBuffered) return true;
    this.close(BACKPRESSURE_CODE, BACKPRESSURE_REASON);
    return false;
  }
}

/**
 * The public, content-blind aggregator. Terminates host-agent uplinks (`/agent`)
 * and phone connections (`/client`) over WSS and hands every line to the
 * `BlindRouter`, which forwards sealed envelopes by their clear `route` only.
 * The server never reads frame plaintext or holds any key.
 */
export class AggregatorServer {
  readonly #cfg: AggregatorConfig;
  readonly #router: BlindRouter;
  readonly #collab: CollabRelay | undefined;
  readonly #maxBuffered: number;
  readonly #idleTimeoutSec: number;
  /** Open authenticated `/client` sockets, each with the session it opened under. */
  readonly #clientSessions = new Map<
    ServerWebSocket<SocketData>,
    SessionTokenPayload
  >();
  /** Open `/agent` sockets, each with the machineId its token is bound to. */
  readonly #agentSockets = new Map<ServerWebSocket<SocketData>, string>();
  #http: Server<SocketData> | undefined;
  #clientRecheck: Timer | undefined;
  #nextId = 0;

  constructor(cfg: AggregatorConfig) {
    this.#cfg = cfg;
    const push = cfg.push;
    const auth = cfg.auth;
    this.#router = new BlindRouter({
      // Only subscriptions made under the current token epoch are woken; the
      // agent's sealed notice (if any) rides along as the opaque payload.
      onAttention: push
        ? (_machineId, notice) => void push.notifyAll(auth?.tokenEpoch, notice)
        : undefined,
    });
    this.#collab = cfg.collabRelay ? new CollabRelay() : undefined;
    this.#maxBuffered = cfg.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED;
    this.#idleTimeoutSec = cfg.idleTimeoutSec ?? DEFAULT_IDLE_TIMEOUT_SEC;
  }

  /** The actual TCP port the server bound to (resolves `port: 0`). */
  get boundPort(): number {
    const port = this.#http?.port;
    if (port === undefined) throw new Error("aggregator not started");
    return port;
  }

  start(): void {
    const self = this;
    const closeRevokedClients = (): void => self.#closeRevokedClients();
    const accountMachines: AccountMachines = {
      list: () => self.#machineList(),
      revoke: (machineId) => self.#revokeMachine(machineId),
    };
    const trustProxy = this.#cfg.trustProxy ?? false;
    // A re-pair's token dialled for the first time and replaced the machine's
    // old one: the sockets the old token opened go.
    const closeReplaced = (machineId: string): void =>
      self.#closeAgents(machineId, REPLACED_REASON);
    if (this.#cfg.auth !== undefined)
      this.#clientRecheck = setInterval(
        () => void self.#closeEndedClients(),
        this.#cfg.clientRecheckMs ?? DEFAULT_CLIENT_RECHECK_MS,
      );
    this.#http = Bun.serve<SocketData>({
      hostname: this.#cfg.hostname ?? "127.0.0.1",
      port: this.#cfg.port,
      idleTimeout: this.#idleTimeoutSec,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      async fetch(req, server) {
        const url = new URL(req.url);
        const { pathname } = url;
        const auth = self.#cfg.auth;
        const push = self.#cfg.push;
        if (auth && pathname.startsWith("/auth/"))
          return handleAuthRequest(
            auth,
            push,
            pathname,
            req,
            clientAddress(
              server.requestIP(req)?.address,
              req.headers,
              trustProxy,
            ),
            closeRevokedClients,
            accountMachines,
          );
        if (push && pathname.startsWith("/push/"))
          return handlePushRequest(push, auth, pathname, req);
        const pairing = self.#cfg.pairing;
        if (pairing && pathname.startsWith("/pair/"))
          return handlePairRequest(
            pairing,
            auth,
            self.#cfg.machines,
            pathname,
            req,
            clientAddress(
              server.requestIP(req)?.address,
              req.headers,
              trustProxy,
            ),
          );
        const collab = self.#collab;
        if (collab) {
          const roomMatch = /^\/r\/([A-Za-z0-9_-]{10,64})$/.exec(pathname);
          const role = url.searchParams.get("role");
          if (roomMatch && (role === "host" || role === "guest")) {
            if (
              server.upgrade(req, {
                data: {
                  endpoint: "collab",
                  port: undefined,
                  collab: { roomId: roomMatch[1] ?? "", role, peerId: 0 },
                },
              })
            )
              return undefined;
            return new Response("expected websocket upgrade", { status: 426 });
          }
        }
        const endpoint: Endpoint | undefined =
          pathname === "/agent"
            ? "agent"
            : pathname === "/client"
              ? "client"
              : undefined;
        if (endpoint === undefined) {
          const webRoot = self.#cfg.webRoot;
          if (webRoot === undefined)
            return new Response("omp-remote aggregator", { status: 404 });
          return serveStatic(webRoot, req, pathname).then(
            (res) =>
              res ?? new Response("omp-remote aggregator", { status: 404 }),
          );
        }
        // `/agent` authenticates at upgrade with its machine's token (see
        // `agentPeer`); `/client` is gated by a session token when auth is on.
        let session: SessionTokenPayload | undefined;
        let signedOut = false;
        if (endpoint === "client" && auth) {
          const token = url.searchParams.get("token");
          // A forged, expired, or missing token is refused here. An authentic
          // one is let in even if signed out since, to be closed as signed out
          // on open: a browser sees only 1006 for a refused upgrade, never why.
          session = token ? auth.authenticSession(token) : undefined;
          if (session === undefined)
            return new Response("unauthorized", { status: 401 });
          signedOut = await auth.isSignedOut(session);
        }
        // A client's attaches count against its signed-in subject, across
        // all of that subject's sockets (see `BlindRouter`).
        const peer: RouterPeer | undefined =
          endpoint === "agent"
            ? agentPeer(req, self.#cfg.machines)
            : { endpoint: "client", subject: session?.sub };
        if (peer === undefined)
          return new Response("unauthorized", { status: 401 });
        if (peer.endpoint === "agent") {
          let adopted: boolean;
          try {
            adopted = await self.#cfg.machines.adopt(
              peer.machineId,
              bearerOf(req) ?? "",
            );
          } catch (err) {
            console.error(
              `omp-remote pairing: adopting a renewed token failed: ${String(err)}`,
            );
            return new Response("service unavailable", { status: 503 });
          }
          if (adopted) closeReplaced(peer.machineId);
        }
        if (
          server.upgrade(req, {
            data: { endpoint, port: undefined, peer, session, signedOut },
          })
        )
          return undefined;
        return new Response("expected websocket upgrade", { status: 426 });
      },
      websocket: {
        sendPings: true,
        // Bun drops a send once a socket is over this limit (16 MiB by
        // default). Keep it above our cap so the 1013 close always comes
        // first and no frame is ever dropped silently.
        backpressureLimit: this.#maxBuffered + (1 << 20),
        open(ws) {
          const { session } = ws.data;
          const auth = self.#cfg.auth;
          if (session !== undefined && auth !== undefined) {
            // A signed-out sign-in only learns that: closed at once, sent
            // nothing, never routed. Rechecked here against the store, in case
            // a change landed while the upgrade was under way.
            if (ws.data.signedOut || auth.isRevoked(session)) {
              ws.close(SIGNED_OUT_CODE, SIGNED_OUT_REASON);
              return;
            }
            self.#clientSessions.set(ws, session);
          }
          const port = new WsPort(`p${self.#nextId++}`, ws, self.#maxBuffered);
          ws.data.port = port;
          const { peer } = ws.data;
          if (peer?.endpoint === "agent") {
            self.#agentSockets.set(ws, peer.machineId);
            self.#cfg.machines.touch(peer.machineId, Date.now());
          }
          const collab = self.#collab;
          if (ws.data.endpoint === "collab" && ws.data.collab && collab)
            ws.data.collab.peerId = collab.join(
              port,
              ws.data.collab.roomId,
              ws.data.collab.role,
            );
        },
        message(ws, raw) {
          const port = ws.data.port;
          if (!port) return;
          const collab = self.#collab;
          if (ws.data.endpoint === "collab" && ws.data.collab && collab) {
            // Relay control is relay-originated only; peers send binary frames.
            if (typeof raw !== "string") {
              collab.routeBinary(
                port,
                ws.data.collab.roomId,
                ws.data.collab.role,
                ws.data.collab.peerId,
                raw,
              );
            }
            return;
          }
          // Only `/agent` and `/client` sockets carry a router role.
          const peer = ws.data.peer;
          if (peer === undefined) return;
          self.#router.handleLine(
            port,
            typeof raw === "string" ? raw : raw.toString("utf8"),
            peer,
          );
        },
        close(ws) {
          const collab = self.#collab;
          if (ws.data.endpoint === "collab" && ws.data.collab && collab) {
            if (!ws.data.port) return;
            collab.leave(
              ws.data.port,
              ws.data.collab.roomId,
              ws.data.collab.role,
              ws.data.collab.peerId,
            );
            return;
          }
          self.#clientSessions.delete(ws);
          const machineId = self.#agentSockets.get(ws);
          if (machineId !== undefined) {
            self.#agentSockets.delete(ws);
            self.#cfg.machines.touch(machineId, Date.now());
          }
          if (ws.data.port) self.#router.disconnect(ws.data.port);
        },
      },
    });
  }

  stop(): void {
    clearInterval(this.#clientRecheck);
    this.#clientRecheck = undefined;
    this.#http?.stop(true);
    this.#http = undefined;
    this.#clientSessions.clear();
    this.#agentSockets.clear();
  }

  /**
   * Close (4401 "signed out") every open `/client` socket whose session a
   * revoke, sign-out-everywhere, or password sign-in change has just revoked.
   */
  #closeRevokedClients(): void {
    const auth = this.#cfg.auth;
    if (auth === undefined) return;
    for (const [ws, session] of this.#clientSessions) {
      if (!auth.isRevoked(session)) continue;
      this.#clientSessions.delete(ws);
      ws.close(SIGNED_OUT_CODE, SIGNED_OUT_REASON);
    }
  }

  /**
   * Close (4401 "signed out") every open `/client` socket whose session has
   * ended since it opened: its token expired, or it was signed out by a change
   * this process did not make (see `WebAuthnGate.hasEnded`).
   */
  async #closeEndedClients(): Promise<void> {
    const auth = this.#cfg.auth;
    if (auth === undefined) return;
    for (const [ws, session] of [...this.#clientSessions]) {
      if (!(await auth.hasEnded(session))) continue;
      // Closed meanwhile, by its peer or by a revoke that landed during the await.
      if (!this.#clientSessions.delete(ws)) continue;
      ws.close(SIGNED_OUT_CODE, SIGNED_OUT_REASON);
    }
  }

  /** Every machine allowed to dial `/agent`, with whether its agent is registered now. */
  #machineList(): MachineView[] {
    const online = new Set(this.#router.machineIds());
    return this.#cfg.machines
      .list()
      .map((m) => ({
        machineId: m.machineId,
        joinedAt: m.joinedAt,
        ...(m.lastSeenAt === undefined ? {} : { lastSeenAt: m.lastSeenAt }),
        online: online.has(m.machineId),
      }))
      .sort((a, b) => (a.machineId < b.machineId ? -1 : 1));
  }

  /**
   * Revoke `machineId`'s token and close every `/agent` socket it opened, so
   * the machine is offline at once and can never dial again. Resolves to
   * whether the machine was known.
   */
  async #revokeMachine(machineId: string): Promise<boolean> {
    const revoked = await this.#cfg.machines.revoke(machineId);
    this.#closeAgents(machineId, REVOKED_REASON);
    return revoked;
  }

  /** Close (4403, with `reason`) every `/agent` socket bound to `machineId`. */
  #closeAgents(machineId: string, reason: string): void {
    for (const [ws, bound] of this.#agentSockets)
      if (bound === machineId) ws.close(REVOKED_CODE, reason);
  }
}

/**
 * The step-up fields an account request carries (see `StepUp`): a passkey
 * assertion — the step-up challenge's `flowId` and the browser's `response` —
 * or the `password`. A body with neither carries no step-up, which is refused
 * like a failed one (403), not as a malformed request; only a mistyped field
 * is a 400.
 */
const StepUpFields = z.object({
  flowId: z.string().optional(),
  response: z.unknown().optional(),
  password: z.string().optional(),
});
/** POST body carrying a WebAuthn ceremony response: register and login verify. */
const VerifyBody = z.object({ flowId: z.string(), response: z.unknown() });
/** Login verify additionally carries the "remember this device" choice, which
 *  selects the longer token lifetime. Absent/false → the default short session. */
const LoginVerifyBody = VerifyBody.extend({ remember: z.boolean().optional() });
/** Password sign-in: the password, and the same "remember this device" choice. */
const PasswordLoginBody = z.object({
  password: z.string(),
  remember: z.boolean().optional(),
});
/** Revoke names the passkey to remove alongside its step-up. */
const RevokeBody = StepUpFields.extend({ credentialId: z.string() });
/** A password sign-in change names the setting it makes alongside its step-up. */
const PasswordSignInBody = StepUpFields.extend({ enabled: z.boolean() });
/** A machine revoke names the machine alongside its step-up. */
const MachineRevokeBody = StepUpFields.extend({ machineId: z.string() });
/**
 * The step-up challenge names the one action it is for: revoking a named
 * passkey, signing out everywhere, registering a passkey, turning password
 * sign-in on or off, or revoking a named machine. A body without one (what a
 * PWA from before step-ups were bound sends) is a 400: an unbound step-up is
 * what this refuses to mint.
 */
const ChallengeBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("revoke"), credentialId: z.string() }),
  z.object({ action: z.literal("sign-out-everywhere") }),
  z.object({ action: z.literal("register") }),
  z.object({ action: z.literal("password-sign-in"), enabled: z.boolean() }),
  z.object({ action: z.literal("revoke-machine"), machineId: z.string() }),
]);

/** Each account route and the one method it accepts. */
const ACCOUNT_ROUTES: Record<string, "GET" | "POST"> = {
  "/auth/account/passkeys": "GET",
  "/auth/account/challenge": "POST",
  "/auth/account/passkeys/revoke": "POST",
  "/auth/account/sign-out-everywhere": "POST",
  "/auth/account/password-sign-in": "POST",
  "/auth/account/machines": "GET",
  "/auth/account/machines/revoke": "POST",
};

/**
 * The routes that run a passkey ceremony, served only while passkeys are on
 * (the gate has a `publicUrl`); otherwise they are 404, as if absent.
 */
const PASSKEY_ROUTES: Record<string, true> = {
  "/auth/register/options": true,
  "/auth/register/verify": true,
  "/auth/login/options": true,
  "/auth/login/verify": true,
  "/auth/account/challenge": true,
};

/**
 * The HTTP answer to each way an account action or a registration can be
 * refused, but for a lockout (429, see `tooManyTries`) and a full ceremony
 * table (429, see `busy`). A wrong step-up password is a 401, like a wrong
 * sign-in password; every other failed step-up is a 403.
 */
const REFUSALS: Record<
  | "passkey-check-failed"
  | "password-required"
  | "wrong-password"
  | "not-found"
  | "last-passkey"
  | "credential-limit"
  | "passkey-session-required",
  { status: number; error: string }
> = {
  "passkey-check-failed": { status: 403, error: "passkey check failed" },
  "password-required": { status: 403, error: "password required" },
  "wrong-password": { status: 401, error: "wrong password" },
  "not-found": { status: 404, error: "not found" },
  "last-passkey": { status: 409, error: "last passkey" },
  "credential-limit": { status: 403, error: "credential-limit" },
  "passkey-session-required": {
    status: 403,
    error: "passkey session required",
  },
};

/** An account action or registration the gate refused. */
type Refusal =
  | { ok: false; reason: keyof typeof REFUSALS | "busy" }
  | PasswordRefusal;

/** The answer to a refused account action or registration. */
function refused(refusal: Refusal): Response {
  if (refusal.reason === "throttled")
    return tooManyTries(refusal.retryAfterSec);
  if (refusal.reason === "busy") return busy();
  const { status, error } = REFUSALS[refusal.reason];
  return json({ error }, status);
}

/** The step-up `fields` carry, or undefined when none. The password wins if both are sent. */
function stepUpOf(fields: z.infer<typeof StepUpFields>): StepUp | undefined {
  if (fields.password !== undefined) return { password: fields.password };
  if (fields.flowId !== undefined)
    return { flowId: fields.flowId, response: fields.response };
  return undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 429 for a ceremony that found no pending slot it may take (see the gate's
 * `#makeRoom`); a slot frees within a challenge lifetime, 60 s.
 */
function busy(): Response {
  return new Response(JSON.stringify({ error: "busy" }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "60" },
  });
}

/**
 * 429 `{ retryAfterSec }` for a password try the gate's throttle refused: the
 * client failed too often and may try again after that many seconds.
 */
function tooManyTries(retryAfterSec: number): Response {
  return new Response(JSON.stringify({ retryAfterSec }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSec),
    },
  });
}

/**
 * The client a request came from, which the per-client limits key on (the
 * gate's pending logins and password throttle, the broker's pending
 * pairings): the socket peer's {@link clientKey}. When `trustProxy` is set
 * and the peer is loopback — the reverse proxy in front of the server — the
 * address the proxy forwarded is taken instead: `X-Real-IP`, else the last
 * `X-Forwarded-For` hop (the one the proxy appended). Neither header is read
 * from any other peer, nor at all without `trustProxy`: a proxy that passes
 * the client's own `X-Real-IP` through would let each request pick its key.
 * Undefined when that leaves no usable identity — a loopback or unspecified
 * address, as every request carries behind a proxy that is not trusted or
 * hides the client — so the gate never lumps all clients into one address's
 * share of pending logins (its password throttle does lump them together: a
 * lockout beats a brute force).
 */
export function clientAddress(
  peer: string | undefined,
  headers: Headers,
  trustProxy: boolean,
): string | undefined {
  if (peer === undefined) return undefined;
  const direct = clientKey(peer);
  if (direct !== undefined || !trustProxy) return direct;
  const forwarded =
    headers.get("x-real-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return forwarded ? clientKey(forwarded) : undefined;
}

/**
 * `address` as a per-client key, or undefined when it names this host or no
 * host at all (loopback, unspecified). IPv4 is kept as is, and an
 * IPv4-mapped IPv6 address unwrapped to it. Any other IPv6 address is cut to
 * its /64, written `a:b:c:d::/64`: one subscriber's usual allocation, so a
 * client cannot mint a fresh key from each address in its own prefix. A
 * string that parses as neither is kept verbatim.
 */
export function clientKey(address: string): string | undefined {
  const groups = ipv6Groups(address);
  if (groups === undefined)
    return address.startsWith("127.") || address === "0.0.0.0"
      ? undefined
      : address;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0) {
    if (f === 0xffff)
      return clientKey(`${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`);
    if (f === 0 && g === 0 && h <= 1) return undefined; // `::` or `::1`
  }
  return `${[a, b, c, d].map((x) => x.toString(16)).join(":")}::/64`;
}

/**
 * The eight 16-bit groups of the IPv6 address `address` (a zone index
 * dropped, `::` expanded, a dotted IPv4 tail read as two groups), or
 * undefined when it is not one.
 */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase().split("%")[0] ?? "";
  const v4Tail = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4Tail !== null) {
    const octets = v4Tail.slice(2, 6).map(Number);
    if (octets.some((o) => o > 255)) return undefined;
    const [o1 = 0, o2 = 0, o3 = 0, o4 = 0] = octets;
    const hi = ((o1 << 8) | o2).toString(16);
    const lo = ((o3 << 8) | o4).toString(16);
    text = `${v4Tail[1]}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const split = (part: string | undefined): string[] =>
    part ? part.split(":") : [];
  const head = split(halves[0]);
  const tail = split(halves[1]);
  const zeros = 8 - head.length - tail.length;
  if (halves.length === 2 ? zeros < 1 : zeros !== 0) return undefined;
  const groups = [
    ...head,
    ...Array<string>(halves.length === 2 ? zeros : 0).fill("0"),
    ...tail,
  ];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * Handle the `/auth/*` endpoints — the passkey ceremonies here, everything
 * else in its own handler. Kept off the WS path: these are ordinary JSON
 * requests. The gate does all crypto; this only routes and shapes responses.
 * While passkeys are off, the passkey routes are 404. A bad ceremony body or a
 * thrown parse never leaks internals — it 400s.
 */
async function handleAuthRequest(
  gate: WebAuthnGate,
  push: PushService | undefined,
  pathname: string,
  req: Request,
  client: string | undefined,
  closeRevokedClients: () => void,
  machines: AccountMachines,
): Promise<Response> {
  if (PASSKEY_ROUTES[pathname] && !gate.passkeysOn)
    return json({ error: "not found" }, 404);
  if (pathname === "/auth/methods") return handleMethodsRequest(gate, req);
  if (pathname === "/auth/session") return handleSessionRequest(gate, req);
  if (pathname.startsWith("/auth/account/"))
    return handleAccountRequest(
      gate,
      push,
      pathname,
      req,
      client,
      closeRevokedClients,
      machines,
    );
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (pathname === "/auth/login/password")
    return handlePasswordLogin(gate, req, client);
  if (pathname === "/auth/register/options")
    return handleRegisterOptions(gate, req, client);
  try {
    switch (pathname) {
      case "/auth/register/verify": {
        const body = VerifyBody.safeParse(await req.json());
        if (!body.success) return json({ error: "bad request" }, 400);
        return json(
          await gate.verifyRegistration(body.data.flowId, body.data.response),
        );
      }
      case "/auth/login/options": {
        const minted = await gate.authenticationOptions(client);
        return minted === undefined ? busy() : json(minted);
      }
      case "/auth/login/verify": {
        const body = LoginVerifyBody.safeParse(await req.json());
        if (!body.success) return json({ error: "bad request" }, 400);
        const result = await gate.verifyAuthentication(
          body.data.flowId,
          body.data.response,
          body.data.remember ?? false,
        );
        return json(result, result.verified ? 200 : 401);
      }
      default:
        return json({ error: "not found" }, 404);
    }
  } catch {
    return json({ error: "bad request" }, 400);
  }
}

/**
 * `GET /auth/methods`: which sign-ins work now, `{ password, passkey }`.
 * Unauthenticated — the login screen asks before anyone signs in — and never
 * cached, since turning password sign-in off changes it.
 */
async function handleMethodsRequest(
  gate: WebAuthnGate,
  req: Request,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  return new Response(JSON.stringify(await gate.methods()), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

/**
 * `POST /auth/login/password` `{ password, remember }`: sign in with the
 * password, answered as a passkey login is — `{ verified: true, token }`. A
 * refused sign-in is a 401 with the same body whatever the cause (a wrong
 * password, none set, or a sign-out-everywhere landing meanwhile); a client
 * the throttle has locked out gets 429 `{ retryAfterSec }`, as does the
 * failure that starts the lockout; password sign-in turned off is a 403.
 */
async function handlePasswordLogin(
  gate: WebAuthnGate,
  req: Request,
  client: string | undefined,
): Promise<Response> {
  const body = PasswordLoginBody.safeParse(await readJsonBody(req));
  if (!body.success) return json({ error: "bad request" }, 400);
  try {
    const result = await gate.passwordLogin(
      body.data.password,
      body.data.remember ?? false,
      client,
    );
    if (result.ok) return json({ verified: true, token: result.token });
    if (result.reason === "throttled")
      return tooManyTries(result.retryAfterSec);
    if (result.reason === "disabled")
      return json({ error: "password sign-in disabled" }, 403);
    return json({ verified: false }, 401);
  } catch (err) {
    console.error(`omp-remote auth: password sign-in failed: ${String(err)}`);
    return json({ error: "internal error" }, 500);
  }
}

/**
 * `POST /auth/register/options`: start adding a passkey. It needs a session
 * the gate accepts (401) and a fresh step-up: a passkey assertion over a
 * challenge minted for registering, or the password. No body, a non-JSON
 * one, or one without step-up fields carries no step-up (403) rather than
 * being malformed; only a mistyped field is a 400. A store that cannot record
 * the step-up's use is a 500.
 */
async function handleRegisterOptions(
  gate: WebAuthnGate,
  req: Request,
  client: string | undefined,
): Promise<Response> {
  const session = await sessionOf(gate, req);
  if (session === undefined) return json({ error: "unauthorized" }, 401);
  const body = StepUpFields.safeParse((await readJsonBody(req)) ?? {});
  if (!body.success) return json({ error: "bad request" }, 400);
  try {
    const result = await gate.registrationOptions({
      session,
      stepUp: stepUpOf(body.data),
      client,
    });
    if (!result.ok) return refused(result);
    return json({ flowId: result.flowId, options: result.options });
  } catch (err) {
    console.error(
      `omp-remote auth: registration options failed: ${String(err)}`,
    );
    return json({ error: "internal error" }, 500);
  }
}

/**
 * `GET /auth/session`: whether the relay still accepts the bearer's session
 * token — 204 if so, 401 when it is missing, forged, expired, or signed out.
 * The PWA asks when its `/client` dials keep failing: a browser sees only 1006
 * for a refused upgrade, so it cannot otherwise tell a dead token from a dead
 * link.
 */
async function handleSessionRequest(
  gate: WebAuthnGate,
  req: Request,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if ((await sessionOf(gate, req)) === undefined)
    return json({ error: "unauthorized" }, 401);
  // Never cached: a stored 204 would vouch for a token after it ended.
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Handle the account routes: list passkeys, mint a passkey step-up challenge,
 * revoke a passkey, sign out everywhere, turn password sign-in on or off. Each
 * needs a session token the gate accepts. Checks run in a fixed order — route
 * (404), method (405), token (401), body (400), then for the actions the fresh
 * step-up (see `refused`: 403, or 401 for a wrong password, 429 for a
 * lockout) before the action's own rules (404/409). Turning password sign-in
 * off needs a passkey session, which is checked before the step-up (403). A
 * passkey step-up passes only for the action, passkey or setting, and session
 * its challenge was minted for; a password session's step-up is the password.
 * A landed change closes the sockets it signed out before answering; one the
 * store failed to write — and so undid — is a 500 that closes nothing. A
 * landed sign-out also retires every push subscription made before it.
 */
async function handleAccountRequest(
  gate: WebAuthnGate,
  push: PushService | undefined,
  pathname: string,
  req: Request,
  client: string | undefined,
  closeRevokedClients: () => void,
  machines: AccountMachines,
): Promise<Response> {
  const method = ACCOUNT_ROUTES[pathname];
  if (method === undefined) return json({ error: "not found" }, 404);
  if (req.method !== method) return json({ error: "method not allowed" }, 405);
  const session = await sessionOf(gate, req);
  if (session === undefined) return json({ error: "unauthorized" }, 401);
  try {
    switch (pathname) {
      case "/auth/account/passkeys":
        return json({ passkeys: gate.passkeys(session.sub) });
      case "/auth/account/machines":
        return json({ machines: machines.list() });
      case "/auth/account/machines/revoke": {
        const body = MachineRevokeBody.safeParse(await readJsonBody(req));
        if (!body.success) return json({ error: "bad request" }, 400);
        const { machineId } = body.data;
        const result = await gate.authorize(
          { action: "revoke-machine", machineId },
          { session, stepUp: stepUpOf(body.data), client },
        );
        if (!result.ok) return refused(result);
        if (!(await machines.revoke(machineId)))
          return json({ error: "not found" }, 404);
        return json({ revoked: true });
      }
      case "/auth/account/challenge": {
        const body = ChallengeBody.safeParse(await readJsonBody(req));
        if (!body.success) return json({ error: "bad request" }, 400);
        const minted = await gate.stepUpOptions(body.data, session);
        return minted === undefined ? busy() : json(minted);
      }
      case "/auth/account/passkeys/revoke": {
        const body = RevokeBody.safeParse(await readJsonBody(req));
        if (!body.success) return json({ error: "bad request" }, 400);
        const { credentialId } = body.data;
        const result = await gate.revokePasskey(credentialId, {
          session,
          stepUp: stepUpOf(body.data),
          client,
        });
        if (!result.ok) return refused(result);
        closeRevokedClients();
        return json({ revoked: true, signedOut: credentialId === session.sub });
      }
      case "/auth/account/sign-out-everywhere": {
        // The body is the step-up alone: none at all is a missing step-up.
        const body = StepUpFields.safeParse((await readJsonBody(req)) ?? {});
        if (!body.success) return json({ error: "bad request" }, 400);
        const result = await gate.signOutEverywhere({
          session,
          stepUp: stepUpOf(body.data),
          client,
        });
        if (!result.ok) return refused(result);
        closeRevokedClients();
        // Already undeliverable (see `PushService.notifyAll`); dropping them
        // is cleanup, so a failed write is logged, not the sign-out's failure.
        await push?.retireBefore(gate.tokenEpoch).catch((err: unknown) => {
          console.error(
            `omp-remote account: retiring push subscriptions failed: ${String(err)}`,
          );
        });
        return json({ signedOut: true });
      }
      case "/auth/account/password-sign-in": {
        const body = PasswordSignInBody.safeParse(await readJsonBody(req));
        if (!body.success) return json({ error: "bad request" }, 400);
        const result = await gate.setPasswordSignIn(body.data.enabled, {
          session,
          stepUp: stepUpOf(body.data),
          client,
        });
        if (!result.ok) return refused(result);
        closeRevokedClients();
        return json({ passwordSignIn: gate.passwordSignIn });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (err) {
    // Bodies parse without throwing and a failed step-up is refused, so what
    // throws here is the server's own failure — a store write, say.
    console.error(`omp-remote account: ${pathname} failed: ${String(err)}`);
    return json({ error: "internal error" }, 500);
  }
}

/**
 * Handle the Web Push endpoints. `GET /push/vapid` returns the app-server public
 * key (not secret — the browser needs it as `applicationServerKey`).
 * `POST /push/subscription` stores a device's push subscription; when the auth
 * gate is on it requires a valid session token (Bearer), so only an
 * authenticated device may enrol for pushes, and the subscription is tagged
 * with that token's epoch: a sign-out-everywhere since stops its pushes. A
 * subscription whose push service is off the allowlist, or whose key is
 * oversized, is a 400 that stores nothing (see `NewPushSubscription`); stored
 * ones are never re-checked. Neither endpoint ever handles session content —
 * the subscription is push routing material only.
 */
async function handlePushRequest(
  push: PushService,
  auth: WebAuthnGate | undefined,
  pathname: string,
  req: Request,
): Promise<Response> {
  if (pathname === "/push/vapid") {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json({ publicKey: push.vapidPublicKey() });
  }
  if (pathname === "/push/subscription") {
    if (req.method !== "POST")
      return json({ error: "method not allowed" }, 405);
    let epoch: number | undefined;
    if (auth) {
      const session = await sessionOf(auth, req);
      if (session === undefined)
        return new Response("unauthorized", { status: 401 });
      epoch = session.ep ?? 0;
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "bad request" }, 400);
    }
    const sub = NewPushSubscription.safeParse(body);
    if (!sub.success) return json({ error: "bad request" }, 400);
    await push.subscribe(sub.data, epoch);
    return new Response(null, { status: 204 });
  }
  return json({ error: "not found" }, 404);
}

/**
 * Handle the aggregator-brokered pairing endpoints (spec §7, §12). Every body is
 * Zod-parsed and only public keys, MACs, a machine label, the code-derived
 * `rendezvousId`, and — to the host that registered it — the machine's new
 * `/agent` token ever cross this path, never a private/session key.
 * `/pair/host` and `/pair/result` are open: the rendezvous id derives from the
 * 128-bit code, and the broker's TTL, `maxPending`, and per-client share
 * (keyed on `client`) bound what they hold. A `/pair/host` that presents the
 * machine's current token as `Authorization: Bearer` registers a renewal.
 * `/pair/claim` is gated by the session token when the auth gate is on; a
 * claim issues the machine's token, which the host collects with its result.
 * Only a renewal may claim a machine that exists — anything else is a 409
 * `{ error: "machine-exists", machineId }`, and the host's next `/pair/result`
 * is `{ status: "refused", reason: "machine-exists" }`. A renewal's token only
 * joins the machine's current one (`MachineStore.renew`): the current token
 * keeps working, and is replaced (its open `/agent` sockets closed,
 * `closeReplaced`) only when the host, having verified the phone, first dials
 * with the new one. A bad JSON body is a 400, never a throw.
 */
async function handlePairRequest(
  broker: PairingBroker,
  auth: WebAuthnGate | undefined,
  machines: MachineStore,
  pathname: string,
  req: Request,
  client: string | undefined,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  switch (pathname) {
    case "/pair/host": {
      const parsed = PairHostRequest.safeParse(await readJsonBody(req));
      // The machineId becomes a token's binding: it must be one a token can hold.
      if (
        !parsed.success ||
        !MachineId.safeParse(parsed.data.machineId).success
      )
        return json({ error: "bad request" }, 400);
      // A token that is stale, revoked, or another machine's renews nothing;
      // the pairing may still create the machine if it does not exist.
      const bearer = bearerOf(req);
      const renews =
        bearer !== undefined &&
        machines.authenticate(bearer) === parsed.data.machineId;
      try {
        return json(broker.registerHost(parsed.data, { client, renews }));
      } catch (err) {
        if (err instanceof PairingBrokerError)
          return json({ error: "pairing broker full" }, 503);
        throw err;
      }
    }
    case "/pair/claim": {
      if (auth && (await sessionOf(auth, req)) === undefined)
        return new Response("unauthorized", { status: 401 });
      const parsed = PairClaimRequest.safeParse(await readJsonBody(req));
      if (!parsed.success) return json({ error: "bad request" }, 400);
      const { rendezvousId } = parsed.data;
      const claimed = broker.claim(parsed.data);
      if (claimed === undefined)
        return json({ error: "no pending pairing" }, 404);
      const { machineId } = claimed.response;
      // Checked and issued with no await between, so no other claim interleaves.
      const exists = machines.list().some((m) => m.machineId === machineId);
      if (exists && !claimed.renews) {
        broker.refuse(rendezvousId, "machine-exists");
        return json({ error: "machine-exists", machineId }, 409);
      }
      let agentToken: string;
      try {
        // A renewal adds a token beside the machine's current one; only the
        // host's first dial with it retires the current one (see `adopt`).
        agentToken = exists
          ? await machines.renew(machineId)
          : await machines.issue(machineId, Date.now());
      } catch (err) {
        // No token, no pairing: the host's poll finds nothing and times out.
        broker.drop(rendezvousId);
        console.error(
          `omp-remote pairing: issuing a token failed: ${String(err)}`,
        );
        return json({ error: "internal error" }, 500);
      }
      broker.grant(rendezvousId, agentToken);
      return json(claimed.response);
    }
    case "/pair/result": {
      const parsed = PairResultRequest.safeParse(await readJsonBody(req));
      if (!parsed.success) return json({ error: "bad request" }, 400);
      return json(broker.result(parsed.data));
    }
    default:
      return json({ error: "not found" }, 404);
  }
}

/** Read a JSON request body, or `undefined` when the bytes are not valid JSON. */
async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** The token a request presents as `Authorization: Bearer <token>`, or undefined. */
function bearerOf(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

/**
 * The session behind a request's `Authorization: Bearer <session token>`, or
 * undefined when the header is missing or not Bearer, or the gate refuses the
 * token (forged, expired, or signed out).
 */
async function sessionOf(
  gate: WebAuthnGate,
  req: Request,
): Promise<SessionTokenPayload | undefined> {
  const token = bearerOf(req);
  return token === undefined ? undefined : gate.verifySessionToken(token);
}

/**
 * Authenticate an `/agent` upgrade into its router role: the
 * `Authorization: Bearer` token must be one the machine store issued, and the
 * socket is bound to that token's machineId. `undefined` means refuse the
 * upgrade.
 */
function agentPeer(
  req: Request,
  machines: MachineStore,
): RouterPeer | undefined {
  const token = bearerOf(req);
  const machineId =
    token === undefined ? undefined : machines.authenticate(token);
  return machineId === undefined ? undefined : { endpoint: "agent", machineId };
}
