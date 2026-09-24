/// <reference lib="dom" />
import {
  DEV_CLIENT_SECRET_PATH,
  DevClientSecretResponse,
  type DownlinkFrame,
  SealedFrame,
  devClientProtocols,
} from "@omp-remote/protocol";
import type { AppStore } from "./store";

/** Machine label shown for the loopback host-agent in local dev mode. */
export const LOCAL_MACHINE_ID = "local";
/** The host-agent's default loopback client port (bound to 127.0.0.1). */
export const LOCAL_CLIENT_URL = "ws://127.0.0.1:4319";

/** The dev-client secret from the local dev server (same origin), or
 *  `undefined` while it is unavailable (host-agent dev client not started). */
async function fetchDevClientSecret(): Promise<string | undefined> {
  try {
    const res = await fetch(DEV_CLIENT_SECRET_PATH, { cache: "no-store" });
    if (!res.ok) return undefined;
    const parsed = DevClientSecretResponse.safeParse(await res.json());
    return parsed.success ? parsed.data.secret : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Localhost-only development client. Talks straight to the host-agent's opt-in
 * loopback dev client (`agent.devClient` in config.json) — no aggregator, no WebAuthn,
 * no E2E sealing. The agent binds it to 127.0.0.1 and admits only allowlisted
 * origins presenting the per-install secret, which the local dev server
 * (apps/web/serve-dev.ts) hands this page; the caller gates this to a localhost
 * origin (see main.ts). It lets a developer — or Playwright — open the real app
 * against live sessions.
 *
 * Frames on this socket are the same unsealed `ClientMessage`s the sealed phone
 * path carries, so they feed the same `AppStore.applyFrame` and render identically.
 */
export class LocalClient {
  #ws: WebSocket | undefined;
  #secret: string | undefined;
  #stopped = false;
  readonly #store: AppStore;
  readonly #url: string;
  readonly #reconnectMs: number;

  constructor(store: AppStore, url = LOCAL_CLIENT_URL, reconnectMs = 1000) {
    this.#store = store;
    this.#url = url;
    this.#reconnectMs = reconnectMs;
  }

  start(): void {
    this.#stopped = false;
    void this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#ws?.close();
    this.#ws = undefined;
  }

  /** Send an unsealed downlink control frame straight to the host-agent. */
  send(frame: DownlinkFrame): void {
    this.#ws?.send(JSON.stringify(frame));
  }

  async #connect(): Promise<void> {
    // Fetched until the dev server has it, then kept for every reconnect.
    this.#secret ??= await fetchDevClientSecret();
    if (this.#stopped) return;
    if (this.#secret === undefined) {
      this.#retry();
      return;
    }
    const ws = new WebSocket(this.#url, devClientProtocols(this.#secret));
    this.#ws = ws;
    // Image transfers in flight on the old socket are lost with it.
    ws.addEventListener("open", () => this.#store.restartMediaTransfers());
    ws.addEventListener("message", (event) => {
      let json: unknown;
      try {
        json = JSON.parse(String(event.data));
      } catch {
        return;
      }
      // The host-agent already backfills the full transcript + state on open, so
      // a fresh connect (and every reconnect) rebuilds the view with no extra ask.
      const parsed = SealedFrame.safeParse(json);
      if (parsed.success) this.#store.applyFrame(LOCAL_MACHINE_ID, parsed.data);
    });
    ws.addEventListener("close", () => {
      if (this.#ws === ws) this.#ws = undefined;
      this.#retry();
    });
  }

  #retry(): void {
    if (this.#stopped) return;
    setTimeout(() => {
      if (!this.#stopped) void this.#connect();
    }, this.#reconnectMs);
  }
}
