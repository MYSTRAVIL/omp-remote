# Changelog

All notable changes to omp-remote are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- A session's notification now simply disappears once the session is answered at the desk, as a native app's would. Chrome shows its own "This site has been updated in the background" notification after too many pushes that leave nothing showing, so after five such removals in 24 hours the phone falls back to leaving one that says the session no longer waits. Removals while another notification is showing or the app is open don't count toward the five.

### Fixed

- Replies no longer show twice (#19, from #20 by @Errnolink). omp sends one more update after a reply ends, repeating its text, and the phone opened a second row for it. The host now drops that repeat, in the IPC bridge feed and in Collab mode alike; a new reply that shares the millisecond still gets its own row.
- The `ask` tool works on providers that validate tool schemas strictly (from #21 by @Errnolink). Its `options` array declared no item type, so such providers refused the whole tool list. It now declares options as omp's own `ask` does: objects with a `label` and an optional `description` and `preview`.
- A notification reading only "omp-remote / A session needs your attention" no longer appears after you swiped a session's notification away and the session was answered at the desk. A push that should show nothing still has to show a notification for a moment, and on Android that one could stay. It now says the session no longer waits, and a push that arrives while the app is open shows that session's own notification. Swiping a session's notification away now tells its machine (the next time the app is open and connected), so the machine sends no clear for it.
- A machine whose config names a paired phone serves that phone again, even when another phone was paired after it (#14). Since 0.3.0 the machine always served the newest paired phone, so a phone that kept an earlier pairing got "no longer paired" and its commands failed. The newest paired phone is served only when `agent.phoneId` is unset or names a phone that is no longer paired, which the agent logs and `omp-remote doctor` warns about. For a named phone paired before the newest, `doctor` shows a note and no longer tells you to switch to the newest. If your phone says it is no longer paired after updating, pair it again with `omp-remote pair`.
- A session resumed from the phone ("Continue") no longer disappears from the phone's list when the old omp process shuts down after the resumed one has started (#13). The old process's goodbye removed the session the new one had just registered, so its transcript was gone from the phone and interrupts and model changes failed until the session restarted. Only the session's current bridge can now end it, and a question the old process asked is no longer shown again.
- The model picker stays filled after the phone reconnects to a long session (#14). The host keeps the last 1000 messages and tool cards of a session to send a reconnecting phone, and past that it could drop the session's model catalog, footer and job list instead of an old message. Those are now always kept, and the limit counts only messages and tool cards.
- A steer, Stop or other command sent from the phone just after it comes back from the background is no longer lost without a trace (#17). While the app slept, the relay could close its connection without the phone noticing, and the command went into that dead connection. The phone now sends a command at once only over a connection it knows is live. Otherwise it holds the command, checks the connection (reconnecting at once if it is dead), and sends it, once, when the machine answers again, even if the machine restarted meanwhile. A command still held after a minute is dropped, and a prompt dropped this way shows "not delivered". A Stop is dropped after 10 seconds, so it cannot stop a turn that began since; the composer then says the interrupt was not sent. An answer to a question stays on "Sending…" until it has actually gone.
- Tool cards on the phone open to something (#15). Every card is titled by what the call does (its stated intent, else its command, path, pattern or query), and opens to that argument in full and, once the call returns, the first 30 lines of its output. An error ends as "error". This holds live, after a reconnect and after a host-agent restart, whether the session runs over the bridge feed or Collab.
- Photos show in the transcript (#18). A photo you send shows in your message at once and stays one picture when the machine confirms it. Images a tool returns (a screenshot, an image it read) show under its card. Both work over the bridge feed and Collab. Collab cuts anything over 1 MiB on its way to the host, so there a larger photo shows "[image unavailable]" on other devices and after a reload, rather than a broken image that never loaded; the phone that sent it keeps its own copy.
- A session started from the phone with "Always ask" or "Write mode" asks you for tool approvals on the phone, not only in the terminal on the host (#16). Before, it waited on a prompt in that terminal and the phone never saw it, unless the host runs Collab (`OMP_REMOTE_MODE=collab`), whose prompt already reached the phone and is unchanged. The bridge now asks the phone and the terminal at once and takes the first answer; the other prompt closes. A prompt answered at neither waits instead of failing after 30 seconds. The modes mean what omp's `--approval-mode` means: "Always ask" asks before anything that edits files or runs code, "Write mode" only before code runs, and the spawn form now says so. Reinstall with `omp-remote install` so the bridge and the host-agent update together: an omp whose bridge is older refuses the new `--omp-remote-approval` flag and the spawned session does not start, rather than running without approvals.

## [0.3.0] - 2026-09-27

### Added

- **App badge.** The installed app's icon shows how many sessions wait on you.
- **Notification detail.** Settings > Notifications chooses per device what a notification shows: Private (only that something needs you), Session (which session and why), or Preview (also the question or last reply, the default).
- **Take photo / Choose existing.** The composer's attach button offers the camera and the photo library separately.

### Changed

- Attached photos are prepared on the phone before upload. JPEGs are re-encoded, which drops EXIF and GPS data. Images over 2576 px on the long edge (the current Claude input limit) are scaled down. Smaller PNG and WebP images, such as screenshots, are sent unchanged.
- Tapping a notification for a session that has ended stays on the home view and says so, and a tap waits for the session list to sync before it opens anything.
- The host now remembers when a session started waiting for your turn and replays it, so a phone that opens cold or reloads still colors that session as waiting. Sessions fed by the IPC bridge now forward "your turn" to the phone at all.
- The session list shows only machines and projects with a session. A machine with none is left out (New session still lists every online machine), and when nothing is running the list says so once.
- A headless omp run (`omp -p`, rpc) its host cannot reach is no longer listed as "Unreachable". The bridge now marks such sessions headless. An interactive session its host cannot reach is still listed as "Unreachable".
- Images attached in the composer show above the text input.

### Fixed

- Restarting the host service no longer leaves live sessions half-empty on the phone (#11). Whenever an omp session's bridge reconnects to the host, it re-sends what the host lost: the model catalog (the picker showed "No models available" until the model changed) and the job list, and for a session the IPC bridge feeds also the footer, any question still waiting for an answer and the recent transcript (up to 200 messages and tool cards), so a phone opened after the restart shows the earlier messages. A Collab session gets its transcript, footer and questions back from its room, as before. omp sessions pick this up once they load the updated bridge (restart them once).
- Notifications without content ("This site has been updated in the background") no longer appear after a session is answered at the desk. Chrome shows its own notification when a push leaves none of the app's notifications showing, so clearing the last one now replaces it, silently, with one saying the session no longer waits. The phone also tells the machine when you have a session on screen, so the machine sends no clear for a notification already gone.
- Tapping a notification opens its session even when the app reloads into a new deploy right after, which the tap's own navigation often triggers. The open session also stays open across that reload. A tap that brings a backgrounded app forward checks the connection first, so a session started while the app was in the background no longer reads as ended.
- Steering a running session from the phone is reliable (#8). A steer or queued prompt waits at the bottom of the transcript until omp takes it in, then sits where omp took it in, so each answer appears under the prompt it answers, the same after a reload. A reply that keeps streaming after a steer moves below it. Each prompt carries an id the host names on the message omp makes of it, so a prompt that was taken in no longer stays "steering in…", and one that never reached the host (lost with a dropped link, refused, or still waiting when the session ended) shows "not delivered". Replies on a session the IPC bridge feeds now finish streaming, and two replies can no longer share a row; on a Collab session a reconnect no longer doubles or overwrites replies. The bridge part needs omp sessions to load the updated bridge (restart them once).
- A pairing interrupted at the wrong moment no longer leaves phone commands failing silently for good (#6). Pairing now saves the phone as the one the machine serves right after it trusts it, before it reports success. An install that already diverged heals at start: the agent serves the newest paired phone, logs `uplink_phone_diverged`, and `omp-remote doctor` warns when `agent.phoneId` names another phone.
- A phone the machine no longer serves (another phone was paired since) is told so instead of hearing nothing (#7). The machine answers the lines it cannot open with a clear notice to that phone, which names no key, session or content and is sent once per phone connection. The session list then shows "This phone is no longer paired with <machine>" with a Re-pair button until a sealed exchange with that machine succeeds again.

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

[Unreleased]: https://github.com/MYSTRAVIL/omp-remote/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/MYSTRAVIL/omp-remote/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MYSTRAVIL/omp-remote/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MYSTRAVIL/omp-remote/releases/tag/v0.1.0
