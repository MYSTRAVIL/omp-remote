<img src="apps/web/public/icon.svg" alt="omp-remote logo" width="96" height="96">

# omp-remote

Control your [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP) coding-agent
sessions from your phone. It shows every session on every machine, grouped by
machine and project. You can read, prompt, interrupt and start sessions.

It runs on your own machine. Your phone reaches it over your home network,
Tailscale or WireGuard. No domain, certificate or VPS is needed. Transcripts and
commands are end-to-end encrypted between the phone and each machine.

## Quick start

You need [Bun](https://bun.sh) 1.4 or later and `omp` 18.2 or later with a model
configured.

1. Install Bun.
2. Clone this repository and install:

   ```bash
   git clone https://github.com/MYSTRAVIL/omp-remote.git
   cd omp-remote
   bun install
   bun run --cwd apps/web build
   ```

3. Put the CLI on your PATH:

   ```bash
   cd apps/cli && bun link && cd ../..
   ```

   If `omp-remote` is still not found, run `bun run omp-remote <command>` from the
   repo root instead.

4. Run `omp-remote init`. Pick **this machine hosts** and set a password.
5. Run `omp-remote run`. It prints the address to open and a QR code.
6. Scan the QR code with your phone and sign in with your password.
7. Check that the verification code on the phone matches the terminal, then
   confirm. Your sessions appear.
8. Stop `run` with Ctrl+C and run `omp-remote install`. omp-remote now starts at
   login, and every new `omp` session shows up on your phone.

The address is plain HTTP, such as `http://192.168.1.20:8788`. On HTTP the browser
turns off install, push notifications and passkeys. See
[Optional HTTPS](docs/SELF-HOSTING.md#optional-https) to turn them on.

## Add another machine

Install the CLI on the other machine, then run:

```bash
omp-remote join http://192.168.1.20:8788
```

Scan the QR code it prints and confirm on your phone. Then run
`omp-remote install` on that machine.

## Commands

| Command | Does |
|---|---|
| `omp-remote init` | Create the config, secrets and password. |
| `omp-remote run` | Start the server and agent in the foreground. |
| `omp-remote join <url>` | Add this machine to an existing server. |
| `omp-remote pair` | Pair another phone with this machine. |
| `omp-remote passwd` | Change the password. |
| `omp-remote doctor` | Check the setup and print a fix for each problem. |
| `omp-remote install` | Start at login and install the OMP bridge. |
| `omp-remote uninstall` | Remove the login entry. |

The config lives in `~/.omp-remote/config.json`.

## How it works

An OMP extension, the **bridge**, loads into every `omp` session. It streams
events to a per-machine **agent** and injects prompts from the phone. Each agent
dials out to the **server**. The server signs you in, serves the phone app and
routes sealed frames. It cannot read them.

```
phone ──(E2E)──► server (content-blind) ◄──(E2E)── agent ◄─IPC─ bridge ⊂ omp session
```

## Docs

| Doc | What |
|---|---|
| [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) | Full setup: local network, config, optional HTTPS, troubleshooting. |
| [`docs/omp-remote/PUBLIC-SERVER.md`](docs/omp-remote/PUBLIC-SERVER.md) | Run the server on a VPS behind a TLS proxy. |
| [`docs/omp-remote/ARCHITECTURE.md`](docs/omp-remote/ARCHITECTURE.md) | Packages, data path and invariants. |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in each release. |

## Threat model

The server never holds session keys. It cannot read transcripts or forge commands.
It does serve the phone app, though. A compromised server could ship a malicious
app that reads the keys on your phone. Run the server on hardware you control, or
trust whoever runs it. On plain HTTP, an active attacker on your network could do
the same. A Tailscale or WireGuard tunnel removes that risk.

## Develop

```bash
bun install            # install workspace deps
bun test               # run the whole suite
bun run typecheck      # tsc --noEmit across the workspace
bun run lint           # biome check
```

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to build, test, and submit changes. See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.
