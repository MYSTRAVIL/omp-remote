# omp-remote — architecture overview

A component map: which package does what, and how the pieces fit. For user setup see
[`../SELF-HOSTING.md`](../SELF-HOSTING.md); to run a public server see
[`PUBLIC-SERVER.md`](./PUBLIC-SERVER.md); to run the development loop see
[`RUNNING.md`](./RUNNING.md).

## The one-sentence design

A plain `omp` session is made reachable with **zero per-session ceremony** (no `/collab`, no
patched core): a globally-installed OMP **bridge** extension streams its live feed to a
per-machine **host-agent**, which dials **out** to a **content-blind server** (on your LAN
or a VPS); the **phone PWA** reaches the server over WS(S) and runs an end-to-end sealed
channel to each machine's host-agent, so the server can never read a transcript or
issue a command.

## Data path

```
bridge ⊂ omp session ──loopback IPC──► host-agent ──outbound WSS(E2E-sealed)──► aggregator (content-blind) ◄──WSS(E2E-sealed)── phone PWA
```

Confidentiality and control integrity live entirely in the **phone ↔ host-agent** channel
(`@omp-remote/crypto` `SealedChannel`). The aggregator relays sealed bytes keyed only by the
clear `route` (= `machineId`); a fully compromised server leaks only routing metadata.

## Packages and apps

Every package is `@omp-remote/*`, Bun + TypeScript (strict), ESM. Libraries live under
`packages/`; deployables under `apps/`.

| Component | Location | Role |
|---|---|---|
| `@omp-remote/protocol` | `packages/protocol` | The **single frame contract**: Zod frame schemas + newline-JSON codec; cross-platform loopback IPC (Windows named pipe / Unix socket) under the `@omp-remote/protocol/ipc` subpath (node-only, kept out of the browser bundle); the sealed `SealedFrame` union (`SessionsFrame`/`Uplink`/`Downlink`, incl. `sync`, `spawn`, `attention`); aggregator control + `AttentionMsg`. **All frame changes happen here — never redefined per package.** |
| `@omp-remote/config` | `packages/config` | The `<stateDir>/config.json` schema (`server` and/or `agent` sections) and the owner-only secret paths beside it. |
| `@omp-remote/bridge` | `packages/bridge` | The **OMP extension** installed once into `~/.omp/agent/extensions/`; auto-loads into every session, captures the normalized live feed (`message_*`, `tool_execution_*`, `state`, needs-attention), and injects remote prompt/interrupt. Fail-safe: a bridge error never crashes the OMP session. Single conduit for adopted **and** spawned sessions. |
| `@omp-remote/agent` | `packages/agent` | The **host-agent** (machine trust anchor): loopback IPC registry with TTL sweep, `spawnSession` (`--approval-mode`), control routing, the opt-in, secret-gated loopback dev client WS (`agent.devClient` in the config), and the **`Uplink`** — one persistent outbound WS(S) to the server that authenticates with the machine's own token (bounded jittered backoff + re-register on drop) and bridges sessions over a server-side `SealedChannel`. |
| `@omp-remote/crypto` | `packages/crypto` | Device identity + owner-only pairing store, X25519 `crypto_kx` per-session keys, XChaCha20-Poly1305 `seal`/`open`, the `SealedChannel` over protocol frames, and the `BlindRelay` proof that the server can neither decrypt nor forge. |
| `@omp-remote/aggregator` | `apps/aggregator` | The **content-blind server**: `BlindRouter` (register/attach/list, directional forward keyed only by the clear `route`, disconnect cleanup); `AggregatorServer` (Bun.serve `/agent`+`/client`, per-machine agent tokens, bounded per-socket buffers, keepalive); sign-in (`/auth/*`: password and passkeys, HMAC session tokens; the server's one plaintext role); pairing (`/pair/*`); and **Web Push** fan-out (`/push/*`). Listens on `0.0.0.0:8788` by default. |
| `@omp-remote/cli` | `apps/cli` | The `omp-remote` command: `init`, `run` (server and/or agent in one process), `join`, `pair`, `passwd`, `doctor`, `install`, `uninstall`. |
| `@omp-remote/web` | `apps/web` | The **installable PWA**: sign-in, one `/client` WS carrying N `SealedChannel`s multiplexed by `route`, the **machine → project → session** tree, the live transcript reducer (pure function over the ordered feed), the control composer + new-session form, Web Push enrolment + service worker. `bun run build` emits `dist/`. |

## How a request flows

- **List sessions.** Each host-agent seals a `SessionsFrame` snapshot; the PWA decodes it per
  machine and assembles the tree (sort: machine label → project → session start). A
  late phone attaching to a steady machine says a sealed hello; the `Uplink` acks it, and
  the ack makes the phone send a sealed `{t:"sync"}` that the `Uplink` answers with the replay.
  Sealed envelopes carry a per-instance epoch and counter in the AAD, so the relay cannot
  replay them (`packages/crypto/src/sealed-channel.ts`).
- **View a transcript.** The bridge feed (`msg`/`tool`/`state`) is sealed out and reduced by
  the PWA's pure transcript reducer into streaming text, tool-call cards, and a footer.
- **Control (prompt / interrupt / spawn).** The signed-in PWA seals a control frame (no
  per-action passkey check since 2026-09-24); the aggregator relays it blind; the `Uplink` opens it and routes
  to the owning session's bridge (`deliverDownlink`), or `spawnSession` for `spawn`.
- **Attention.** The bridge derives "needs input"; the `Uplink` emits a content-free clear
  trigger alongside the sealed `AttentionFrame`; the aggregator sends a **payloadless** Web
  Push. Session identity lives only inside the sealed frame — zero content at the edge.

## Invariants (enforced; do not fight)

- **Content-blind aggregator** — reads only the clear `route`; never parses/logs/persists
  plaintext, never holds session/room keys.
- **Machines dial out** — no inbound ports on host machines; no VPN on the phone path.
- **One frame contract** — `@omp-remote/protocol`; every inbound frame is Zod-parsed, never
  cast.
- **Bridge failures are contained** — never crash the OMP session.
- **Cross-platform** — Windows named pipes and Unix sockets both supported.
- **Vetted crypto only** — libsodium primitives, `@simplewebauthn/*` for WebAuthn; no
  substitutes.
