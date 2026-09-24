import {
  AggregatorControl,
  type MachinesMsg,
  RoutedEnvelope,
} from "@omp-remote/protocol";

/**
 * A connected peer, abstracted away from the transport. `id` must be stable and
 * unique for the lifetime of the connection.
 */
export interface RouterPort {
  readonly id: string;
  send(raw: string): void;
  close(): void;
}

/**
 * The endpoint a line arrived on, which decides what the sender may do. An
 * `/agent` socket carries the machineId its token is bound to: the only route
 * it may register. A `/client` socket carries the subject of the session
 * token it opened with when the gate is on — only an identity to count its
 * attaches against, never anything about what it carries.
 */
export type RouterPeer =
  | { readonly endpoint: "client"; readonly subject?: string }
  | { readonly endpoint: "agent"; readonly machineId: string };

/**
 * A phone attaches once per paired machine, a handful in practice, from a few
 * tabs and devices; 128 bounds the attaches one signed-in subject (a passkey)
 * holds across all its sockets. Every passkey the gate admits
 * (`MAX_CREDENTIALS`, 20) at this cap still cannot fill {@link MAX_ROUTES}.
 */
export const MAX_ATTACHES_PER_SUBJECT = 128;
/** A single-user relay routes a few dozen machines; 4096 (64 full phones) bounds the routes attaches create. */
export const MAX_ROUTES = 4096;

/** Why a phone's attach was refused, sent back as the `error` control's reason. */
type AttachRefusal = "attach limit" | "route limit";

interface Route {
  agent?: RouterPort;
  clients: Set<RouterPort>;
}

export interface BlindRouterConfig {
  /**
   * Called when a REGISTERED agent sends a clear `{type:"attention"}` control.
   * The router stays content-blind — it passes no session identity, only the
   * machine route that asked for a push fan-out and the control's optional
   * `notice`: an opaque sealed envelope it forwards verbatim and cannot open. A
   * client (non-agent) port can never trigger this.
   */
  onAttention?: (machineId: string, notice: string | undefined) => void;
}

/**
 * The content-blind switching core of the aggregator. It reads ONLY the clear
 * control `type` and the clear `route` of a sealed envelope; it never parses,
 * decrypts, logs, or re-serializes frame plaintext, and it forwards data lines
 * VERBATIM. This is the networked analogue of `@omp-remote/crypto`'s `BlindRelay`
 * and the place the blind-relay invariant (§7) is enforced.
 *
 * It also keeps each phone's view of which machines are online current, with
 * the same clear `machines` list a `list` answers: every client attached to a
 * route hears it again when the route's agent registers or goes away, and a
 * client whose envelope finds no agent on its route hears it in reply.
 */
export class BlindRouter {
  readonly #onAttention:
    | ((machineId: string, notice: string | undefined) => void)
    | undefined;
  /**
   * machineId -> its agent and attached phones. A route is dropped once it has
   * neither; phones' attaches may create at most {@link MAX_ROUTES} of them.
   */
  readonly #routes = new Map<string, Route>();
  /** portId -> the machineId it registered as an agent for. */
  readonly #agentOf = new Map<string, string>();
  /** portId -> machineIds it attached to as a client. */
  readonly #clientRoutes = new Map<string, Set<string>>();
  /** portId -> whose allowance its attaches count against (see `#attachRefusal`). */
  readonly #attachOwner = new Map<string, string>();
  /** owner -> attaches it holds, summed over all of its sockets. */
  readonly #attachCount = new Map<string, number>();

  constructor(cfg: BlindRouterConfig = {}) {
    this.#onAttention = cfg.onAttention;
  }

  /**
   * Handle one line from `port`, arriving on `peer`'s endpoint. Roles are
   * enforced here: only an agent registers, only a client lists or attaches,
   * and a sealed envelope moves only along a route its sender has joined — a
   * registered agent to that route's clients, an attached client to that
   * route's agent (with none live, the client is sent the machine list
   * instead). Everything else is dropped.
   */
  handleLine(port: RouterPort, raw: string, peer: RouterPeer): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return; // unparseable → drop, never throw
    }
    // Control messages carry a discriminant `type`; sealed data envelopes carry
    // only the clear `route` (plus opaque `n`/`ct` we never touch).
    const control =
      typeof json === "object" && json !== null && "type" in json
        ? json
        : undefined;
    if (control !== undefined) {
      this.#handleControl(port, control, peer);
      return;
    }
    const env = RoutedEnvelope.safeParse(json);
    if (!env.success) return;
    this.#forward(port, peer, env.data.route, raw);
  }

  #handleControl(port: RouterPort, json: unknown, peer: RouterPeer): void {
    const parsed = AggregatorControl.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.type) {
      case "register": {
        // A client can never claim a route; its register is ignored outright.
        if (peer.endpoint !== "agent") return;
        // A machine's token claims that machine's route and no other.
        if (msg.machineId !== peer.machineId) {
          port.send(JSON.stringify({ type: "error", reason: "unauthorized" }));
          port.close();
          return;
        }
        const route = this.#routeFor(msg.machineId);
        // A new agent generation supersedes the old one: close the stale socket
        // and drop its binding so it can no longer forward on this route (a
        // lingering old uplink after a reconnect must not keep injecting frames).
        const previous = route.agent;
        if (previous && previous !== port) {
          this.#agentOf.delete(previous.id);
          previous.close();
        }
        route.agent = port;
        this.#agentOf.set(port.id, msg.machineId);
        // The phones on this route see the machine online again.
        this.#announce([msg.machineId]);
        return;
      }
      case "attach": {
        // Only a phone joins a route; an agent attaching would receive its
        // clients' traffic for a machine it never registered.
        if (peer.endpoint !== "client") return;
        const owner = attachOwner(port, peer);
        const refusal = this.#attachRefusal(port.id, owner, msg.machineId);
        if (refusal !== undefined) {
          // Refused whole: no route, no membership. The socket stays up on
          // the routes it already joined.
          port.send(JSON.stringify({ type: "error", reason: refusal }));
          return;
        }
        this.#routeFor(msg.machineId).clients.add(port);
        let set = this.#clientRoutes.get(port.id);
        if (!set) {
          set = new Set();
          this.#clientRoutes.set(port.id, set);
          this.#attachOwner.set(port.id, owner);
        }
        if (!set.has(msg.machineId)) {
          set.add(msg.machineId);
          this.#attachCount.set(owner, (this.#attachCount.get(owner) ?? 0) + 1);
        }
        this.#sendMachines(port);
        return;
      }
      case "list":
        if (peer.endpoint === "client") this.#sendMachines(port);
        return;
      case "attention": {
        // Only a REGISTERED agent may trigger a push fan-out — a client (phone)
        // port sending this is ignored, so it can't spam the user's devices.
        const machineId = this.#agentOf.get(port.id);
        if (machineId !== undefined) this.#onAttention?.(machineId, msg.notice);
        return;
      }
      case "ping":
        // Application-level keepalive: answer so the peer's idle NAT mapping and
        // any intermediate proxy stay alive (spec §9). Content-blind — no route.
        port.send(JSON.stringify({ type: "pong" }));
        return;
    }
  }

  /**
   * Why the client socket `portId`, whose attaches count against `owner`, may
   * not attach to `machineId` now, or undefined when it may. Re-attaching a
   * route it joined is always fine. A new one must fit the owner's
   * {@link MAX_ATTACHES_PER_SUBJECT}, summed over all of the owner's sockets,
   * and may create a route only while fewer than {@link MAX_ROUTES} exist;
   * joining an existing route, such as a registered machine's, takes no room.
   * An agent's register is never capped: it holds its machine's token, and
   * refusing it would let phones' attaches keep a real machine offline.
   */
  #attachRefusal(
    portId: string,
    owner: string,
    machineId: string,
  ): AttachRefusal | undefined {
    if (this.#clientRoutes.get(portId)?.has(machineId)) return undefined;
    if ((this.#attachCount.get(owner) ?? 0) >= MAX_ATTACHES_PER_SUBJECT)
      return "attach limit";
    if (!this.#routes.has(machineId) && this.#routes.size >= MAX_ROUTES)
      return "route limit";
    return undefined;
  }

  #forward(
    from: RouterPort,
    peer: RouterPeer,
    machineId: string,
    raw: string,
  ): void {
    const route = this.#routes.get(machineId);
    if (!route) return; // no such route → dropped, no crash
    // Directional, and only along a route the sender joined: the route's own
    // agent broadcasts to every attached client; an attached client reaches
    // only the agent (phones never see each other's sealed traffic). An
    // unregistered agent or a client that never attached cannot inject.
    if (peer.endpoint === "agent") {
      if (route.agent === from)
        for (const client of route.clients) client.send(raw);
    } else if (route.clients.has(from)) {
      // With no agent live the line is dropped; the current list tells the
      // phone its machine is offline instead of leaving the prompt to vanish.
      if (route.agent) route.agent.send(raw);
      else this.#sendMachines(from);
    }
  }

  /** Remove a disconnected port from every route it participated in. */
  disconnect(port: RouterPort): void {
    const agentRoute = this.#agentOf.get(port.id);
    if (agentRoute !== undefined) {
      const route = this.#routes.get(agentRoute);
      // Only clear the slot if THIS port still owns it (a reconnect may have
      // already replaced us).
      const owned = route !== undefined && route.agent === port;
      if (owned) route.agent = undefined;
      this.#agentOf.delete(port.id);
      this.#pruneEmpty(agentRoute);
      // The route's phones learn the machine went offline.
      if (owned) this.#announce([agentRoute]);
    }
    const attached = this.#clientRoutes.get(port.id);
    if (attached) {
      for (const machineId of attached) {
        this.#routes.get(machineId)?.clients.delete(port);
        this.#pruneEmpty(machineId);
      }
      this.#clientRoutes.delete(port.id);
      const owner = this.#attachOwner.get(port.id);
      this.#attachOwner.delete(port.id);
      if (owner !== undefined) {
        const left = (this.#attachCount.get(owner) ?? 0) - attached.size;
        if (left > 0) this.#attachCount.set(owner, left);
        else this.#attachCount.delete(owner);
      }
    }
  }

  /** machineIds that currently have a live agent, sorted for determinism. */
  machineIds(): string[] {
    const out: string[] = [];
    for (const [id, route] of this.#routes) if (route.agent) out.push(id);
    return out.sort();
  }

  /** Route entries held right now, agent-owned or phone-only (tests/metrics). */
  get routeCount(): number {
    return this.#routes.size;
  }

  #routeFor(machineId: string): Route {
    let route = this.#routes.get(machineId);
    if (!route) {
      route = { clients: new Set() };
      this.#routes.set(machineId, route);
    }
    return route;
  }

  #pruneEmpty(machineId: string): void {
    const route = this.#routes.get(machineId);
    if (route && !route.agent && route.clients.size === 0)
      this.#routes.delete(machineId);
  }

  #sendMachines(port: RouterPort): void {
    port.send(this.#machinesLine());
  }

  /**
   * Send the machine list, once each, to every client attached to any of
   * `machineIds`' routes: a route's agent came or went. Only phones are ever
   * attached, so an agent socket never hears it.
   */
  #announce(machineIds: readonly string[]): void {
    const clients = new Set<RouterPort>();
    for (const machineId of machineIds)
      for (const client of this.#routes.get(machineId)?.clients ?? [])
        clients.add(client);
    if (clients.size === 0) return;
    const line = this.#machinesLine();
    for (const client of clients) client.send(line);
  }

  /** The clear `machines` control listing every machine with a live agent. */
  #machinesLine(): string {
    const msg: MachinesMsg = {
      type: "machines",
      machineIds: this.machineIds(),
    };
    return JSON.stringify(msg);
  }
}

/**
 * Whose attach allowance a client socket spends: its signed-in subject's,
 * shared by every socket that subject opens; or, with no gate (no subject),
 * the socket's own. Prefixed so a subject never collides with a port id.
 */
function attachOwner(
  port: RouterPort,
  peer: { readonly subject?: string },
): string {
  return peer.subject === undefined ? `port:${port.id}` : `sub:${peer.subject}`;
}
