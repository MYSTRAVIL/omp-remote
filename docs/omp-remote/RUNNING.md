# Running the development loop (single machine)

Prerequisites: `bun` on PATH, an `omp` with a model configured, deps installed
(`bun install`), and a machine set up and paired as in the README quick start.

1. **Turn on the host-agent's loopback dev client.** Add `devClient` to the
   `agent` section of `~/.omp-remote/config.json`, then restart `omp-remote run`:

   ```json
   "agent": { "serverUrl": "…", "devClient": {} }
   ```

   It listens on `127.0.0.1:4319` (`devClient.port`) and admits browser origins from
   `devClient.origins` (default `http://localhost:4318`). The agent and its bridges
   share a per-install IPC token (`ipc-token` in the state dir), proven both ways in
   an HMAC challenge-response on connect (it never crosses the pipe); the smoke
   client and the localhost web build (`apps/web/serve-dev.ts`) present the
   dev-client secret (`dev-client-secret`). Both are created on first use,
   owner-only (0600 on Unix, a current-user-only ACL on Windows);
   `OMP_REMOTE_STATE_DIR` relocates them. On Unix the IPC socket is
   `$XDG_RUNTIME_DIR/omp-remote/agent.sock`, else `agent.sock` in the state dir.

2. **Start a session with the bridge loaded.** Globally, copy the built bridge
   into `~/.omp/agent/extensions/`; for a quick test, load it explicitly:

   ```bash
   omp --mode rpc -e packages/bridge/src/index.ts
   ```

   (A plain interactive `omp -e packages/bridge/src/index.ts` works too.)

3. **List sessions from the client:**

   ```bash
   bun run scripts/smoke-client.ts
   ```

   Confirm the SESSIONS line contains your session.

4. **Drive it remotely and assert the round-trip:**

   ```bash
   SEND_PROMPT="Reply with exactly: SMOKEOK" EXPECT_MARKER=SMOKEOK \
     bun run scripts/smoke-client.ts
   ```

   The client sends the prompt to the session; the bridge injects it; `omp`
   runs the turn; assistant `msg` frames relay back and the client prints
   `SMOKE OK: saw marker SMOKEOK` and exits 0.

## Operational diagnostics

The installed service writes the host's timestamped operational JSON lines to
`~/.omp-remote/omp-remote.log` on Windows. At each launch it checks the current file
once: at 10 MiB or larger, the log becomes `.1`, the old `.1` becomes `.2`, and the
old `.2` is removed. A long-running process can exceed 10 MiB because there is no
watcher. On Linux, read the logs with `journalctl --user -u omp-remote`.

Bridge diagnostics use OMP's standard rotating files under
`~/.omp/logs/omp.<date>.<pid>.log*`; run `/debug` inside that OMP session to open the
standard log viewer. There is no separate omp-remote debug or verbosity switch.

Diagnostics contain allowlisted lifecycle metadata and stable error codes only. Control
events include the session ID, prompt mode, selected route, and `forwarded` or `rejected`
outcome. They exclude prompt, answer, transcript, credential, room-link, URL, provider,
and raw-error data. `forwarded` records host handoff, and `prompt_dispatch_accepted`
records a successful bridge API call. Only `model_execution_started` records OMP's
`agent_start`; matching timestamps do not prove that a specific prompt caused the turn.

For a host rollout, update the source checkout and run `omp-remote install`. It
rewrites the launcher, reinstalls the bridge into `~/.omp/agent/extensions/`, and
restarts the service. Verify the host log (a fresh `agent_listening`, plus
`uplink_connected` once the machine is paired) and one fresh session's OMP bridge log.
