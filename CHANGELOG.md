# Changelog

All notable changes to omp-remote are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-09-26

### Fixed

- Prompts sent from the phone settle into the transcript instead of staying
  "steering in…" or "queued…" forever on a session the bridge feeds directly
  (no Collab room). The bridge now sends each user message once omp takes it
  in, so prompts typed at the desk show on the phone too (#2).
- A reasoning model no longer floods the phone with an empty message frame per
  thinking step on a bridge-fed session, and each reply keeps its own
  transcript row instead of overwriting the previous one (#3).
- omp subagents (the sessions the `task` tool spawns) no longer show up on the
  phone as extra "Unreachable" sessions. The bridge still loads into them but
  does not announce them; they stay part of their parent's run.
- `omp-remote init` no longer fails with `EFAULT` on Windows when the username
  equals the computer name. Secret files are granted to `DOMAIN\user`, not the
  bare name, which `icacls` read as the machine and turned into an empty
  `CHEF\` principal that locked the owner out. `doctor` and `install` check and
  name the same account (#1).
- `omp-remote run` no longer exits when nobody enters the pairing code in time.
  It shows a fresh code and QR and keeps the server running. `omp-remote pair`
  still exits non-zero on a timeout (#5).
- Reopening the app no longer shows a machine as "0 sessions" while its list
  is on the way. Until the machine's list arrives, and while the app checks the
  link after coming back to the foreground, the machine shows "Syncing
  sessions…". A connection attempt left over from before the app went to the
  background is retried at once (#4).
- A machine with no live sessions explains that only omp sessions started
  after the bridge was installed show there, and points to New session › Past
  sessions (#4).
- `omp-remote install` lists the same labelled URLs as `run` instead of a
  `localhost` URL, which the app opens in local dev mode and cannot sign in
  on. Both list a loopback URL only when nothing else reaches the server, and
  label it as opening in dev mode.

### Security

- The `omp-remote` CLI refuses to start when Bun has loaded a `.env` file from
  the working directory, so a checkout's `.env` cannot move the state dir or
  change proxy or TLS settings. The root `omp-remote` script runs Bun with
  `--no-env-file`, and the compiled server binary no longer autoloads `.env`
  or `bunfig.toml`.
- `pairing.json`, which holds the host's long-term secret key, is written
  atomically and owner-only on Windows too, like the other secrets. `doctor`
  checks its permissions. A `pairing.json` that exists but cannot be read or
  parsed now stops the agent instead of being replaced with a new identity.
- The server sends a Content-Security-Policy with the phone app: scripts,
  styles and fonts only from the app's own files (no inline script or `eval`;
  libsodium may compile its wasm), images also from `data:` and `blob:`,
  connections to the server and WebSockets, and `frame-ancestors 'none'`.
  Every app response also carries `X-Content-Type-Options: nosniff`. The app
  turns off Zod's `eval` probe so it runs cleanly under that policy.
- Open phone sockets end when their sign-in does. The aggregator rechecks every
  open `/client` socket every 30 seconds and closes it (4401, so the phone
  signs out) once its token has expired, or once the password was changed with
  `omp-remote passwd` for a password session. Before, such a socket stayed
  attached until it dropped.
- One client can no longer lock password sign-in and password step-ups for
  everyone. The failure budget shared by all clients used to grow until a
  correct password reset it, so about 21 wrong passwords, then one each time
  the lock lifted, kept everyone out. It now drains one failure every 30
  seconds, so its lock lasts seconds and clears once guessing stops. Long
  lockouts apply only to the guessing client's own address. Tries with no
  client address (behind a proxy that is not trusted) spend only the shared
  budget.
- A flood of login options or pairing registrations can no longer lock others
  out of passkey sign-in, passkey step-ups, enrolment or pairing. When every
  pending slot is held, a new request now displaces the oldest pending login
  or unclaimed pairing of whichever client holds the most, instead of being
  refused. Requests with no client address (behind a proxy that is not
  trusted) count as one client. Enrolments, step-ups, claimed pairings and
  renewals by a host holding its machine token never give way.
- A re-pair no longer replaces a machine's token when the phone claims it. The
  new token works beside the old one, and replaces it (closing the old token's
  `/agent` sockets) only when the host, having verified the phone, first dials
  with it. A claim the host rejects, or one made by someone who learned the
  rendezvous id, no longer knocks the machine offline.
- A pairing link (`#pair=`) quoted in a transcript renders as plain text, so one
  tap on model or tool output can no longer open the pairing prompt. `SECURITY.md`
  now lists the pairing and session-token limits that remain, with mitigations.

## [0.1.0] - 2026-09-25

### Added

- Local-network hosting. One home machine runs the server and its agent in one
  process on plain HTTP port 8788. The phone reaches it over the LAN, Tailscale
  or WireGuard. No domain, certificate or VPS is needed.
- The `omp-remote` CLI: `init`, `run`, `join <url>`, `pair`, `passwd`, `doctor`,
  `install` and `uninstall`. Install it with `bun link` in `apps/cli`.
- One config file, `~/.omp-remote/config.json`, with `server` and `agent`
  sections. Secrets live beside it, owner-only.
- Password sign-in (argon2id, at least 12 characters, with a growing delay after
  repeated failures). It works beside passkeys. Passkeys need HTTPS and are added
  from Settings after a password sign-in. A passkey session can turn password
  sign-in off.
- Per-machine agent tokens, issued when the phone approves a pairing. Settings
  lists machines and can revoke one.
- Pairing links: `run`, `join` and `pair` print a QR code of `<url>/#pair=<code>`
  that opens the app with the code filled in.
- The server serves the phone app itself from `server.webRoot`.
- The phone app runs on plain HTTP. Settings says which features HTTP turns off.
- Docs: a local-network quickstart, optional HTTPS (Tailscale, Caddy, mkcert)
  and a public server guide (`docs/omp-remote/PUBLIC-SERVER.md`, formerly
  `DEPLOY.md`).
- Passkey management in Settings: list registered passkeys (created, last used)
  and revoke one. The last remaining passkey cannot be revoked.
- "Sign out everywhere": a server-side token epoch bump that invalidates every
  issued session token. Revoking and signing out everywhere need a fresh passkey
  check.
- "Keep me signed in" preference.
- Settings sections: Account, Machines (rename, forget on this device, last
  seen), Projects (hide/unhide, default project per machine), New sessions
  (default machine, model, effort, approval and send mode), Chat (auto-scroll,
  text size, timestamps, thinking and tool output expansion), Notifications,
  Appearance (theme, density) and About (build, update history, data
  protection, connection diagnostics).
- Inline new-session dialog with app-styled machine and project lists, project
  remove/hide, and a model picker fed by a per-machine model catalog cache.
- Connection banner for reconnecting and offline states; expired sign-ins go
  straight to the passkey login screen; sends to an offline machine keep the
  draft.
- "Jump to latest" button; chat stops auto-scrolling while you read history.
- Update notice after a service-worker update, with a reload prompt instead of
  an automatic reload when a draft is unsent.
- Cached session list painted on load, so rows keep their titles from the first
  frame.
- System notices (background job results, reminders) show as collapsed cards
  labelled by their kind, with a one-line preview; the body opens on tap.

### Changed

- All sealed downlink control frames (model, effort, compact, service tier,
  resource uploads) go through one router on both the hosted and loopback
  paths.
- An overflowing phone connection is closed with code 1013 so the phone
  resyncs, instead of frames being dropped silently. Sync replays pending
  interactions and announces media without sending it; the phone fetches media
  on demand.
- The bridge follows OMP session switches (`/new`, `/fork`, `/resume`).
- Overlays (image viewer, dialogs, pickers) close on back navigation.
- Deploy scripts read the target host and URL from the environment; no
  deployment-specific defaults are tracked.
- The server and agent read `config.json`. Only `OMP_REMOTE_STATE_DIR` and
  `OMP_REMOTE_IPC_PATH` remain as environment variables.
- `omp-remote install` replaces the install scripts. It registers
  `omp-remote run` to start at login and installs the bridge.
- Existing machines must re-join once with `omp-remote join <url>`.
- Opening a chat, or returning to one, always lands on its newest message and
  stays there while the transcript and images load, whatever the auto-scroll
  setting, until you scroll or touch the chat.

### Removed

- Environment-variable configuration for the server and agent,
  `packages/agent/.env` and `apps/aggregator/run-vps.sh`.
- The shared `OMP_REMOTE_AGENT_TOKEN`, the passkey enrollment secret
  (`OMP_REMOTE_ENROLL_SECRET`) and the migration flags
  `OMP_REMOTE_ACCEPT_INFRAME_AGENT_TOKEN`, `OMP_REMOTE_ACCEPT_LEGACY_IPC_TOKEN`
  and `OMP_REMOTE_TOKEN`.
- The `install:host`, `deploy:bridge` and `deploy:host` scripts.

### Fixed

- A failed spawn, an early collab send, or a rejected compaction no longer
  crashes the host-agent or the OMP session.
- Model, effort and compact controls and image uploads work over the hosted
  path.

### Security

- Adding a passkey requires a signed-in session and a fresh check, and is
  capped at 20 credentials. Login uses discoverable credentials, so login
  options no longer disclose credential IDs.
- The aggregator enforces endpoint roles: only authenticated `/client` sockets
  can list and attach; only `/agent` can register. Each machine's token is
  checked at upgrade and can register only that machine.
- Turning off password sign-in needs a passkey session, a fresh check and at
  least one passkey. Changing the password signs out every password session.
- The host-agent loopback control socket is off by default. When enabled it
  requires a per-install secret and an allowlisted `Origin`. Local IPC uses a
  per-install token and owner-only socket permissions.
- Windows spawns launch without `cmd.exe` parsing and validate the model and
  working directory.
- New push subscriptions must use https and an allowlisted push service host.
- Pending WebAuthn ceremonies and attach routes are bounded.
- The sealed channel rejects replayed frames. Each channel instance has a
  random epoch and a send counter, both authenticated with every frame. The
  phone binds its commands to the agent epoch it verified in a handshake, and
  each side refuses counters it has already seen. The phone PWA and the
  host-agent must be updated together: neither accepts the old envelope.

[Unreleased]: https://github.com/MYSTRAVIL/omp-remote/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MYSTRAVIL/omp-remote/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MYSTRAVIL/omp-remote/releases/tag/v0.1.0
