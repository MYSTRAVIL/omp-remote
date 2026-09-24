# Self-hosting guide

omp-remote runs on a machine you own. By default one home machine runs everything,
and your phone reaches it over your LAN, Tailscale or WireGuard on plain HTTP. You
need no domain, no certificate and no VPS. HTTPS and a public server are optional.

## How it fits together

- **Server.** It signs you in, serves the phone app and routes sealed frames
  between the phone and your machines. It cannot read them: the encryption keys
  live on the phone and on each machine.
- **Agent.** One runs on every machine with OMP sessions. It dials out to the
  server. The bridge extension loads into every `omp` session and talks to the
  agent over a local pipe or socket.
- **Phone.** The phone app runs in your browser. It holds your end-to-end keys.

One program, `omp-remote`, runs the server, the agent or both. One file,
`~/.omp-remote/config.json`, says which.

## Requirements

- [Bun](https://bun.sh) 1.4 or later.
- [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`) 18.2 or later, with a
  model configured.
- A phone that can reach the host machine: the same Wi-Fi, or a Tailscale or
  WireGuard tunnel.

## Local network setup

This is the default. It uses plain HTTP on port 8788.

1. Install the CLI. Replace `<repo-url>` with this repository's clone URL:

   ```bash
   git clone <repo-url> omp-remote
   cd omp-remote
   bun install
   bun run --cwd apps/web build
   cd apps/cli && bun link && cd ../..
   ```

   The web build is the phone app the server hands out. `bun link` puts
   `omp-remote` on your PATH. If it does not, run `bun run omp-remote <command>`
   from the repo root instead.

2. Run `omp-remote init`. Give the machine a name and pick **this machine hosts**.
   Choose a password of at least 12 characters.

3. Run `omp-remote run`. It prints the addresses your phone can use, such as
   `http://192.168.1.20:8788` or a Tailscale `http://100.x.y.z:8788`. It also
   prints a pairing code and a QR code.

4. On your phone, scan the QR code. It opens the app with the pairing code filled
   in. Sign in with your password. Check that the verification code on the phone
   matches the one in the terminal, then confirm. The machine and its sessions
   appear.

5. Stop `run` with Ctrl+C. Run `omp-remote install`. It starts `omp-remote run`
   at login and installs the bridge into `~/.omp/agent/extensions/`. New `omp`
   sessions now show up on your phone.

On Windows, allow Bun through the firewall for private networks when Windows asks.
Otherwise the phone cannot connect.

### What plain HTTP turns off

Browsers keep some features for secure (HTTPS) pages. On plain HTTP you lose:

- the service worker, so no offline shell and no real "Add to Home Screen" install;
- push notifications;
- passkeys.

Everything else works: the session list, live transcripts, prompts, interrupts,
new sessions and image uploads. Settings shows a notice while you are on HTTP.

### Is plain HTTP safe?

Mostly, and a tunnel closes the gap.

Your transcripts and commands are end-to-end encrypted between the phone and each
machine. The keys never leave those devices. Someone who sniffs your password or
session token can sign in to the server, but the server only sees metadata. They
cannot read sessions or send commands.

The remaining risk is an active attacker on your LAN. They could rewrite the app's
JavaScript as it loads and steal keys from the phone. Tailscale and WireGuard
encrypt the whole connection, which removes that risk. On a shared or untrusted
network, use a tunnel or HTTPS.

## Add another machine

On the new machine, install the CLI as in step 1. It does not need the web build.
Then run:

```bash
omp-remote join http://192.168.1.20:8788
```

Use the address of your host machine. `join` asks for a machine name. It prints a
pairing code, a QR code and a verification code. Scan the QR code with your phone.
Or open Settings, tap "Pair a machine" and type the pairing code. Confirm when the
verification codes match. Then run `omp-remote install` on the new machine.

Each machine gets its own token. To remove a machine, open Settings, find it under
Account and tap Revoke. Its token stops working at once.

## Pair another phone

Run `omp-remote pair` on each machine the new phone should reach. It prints a code
and a QR code, like `join`.

## Change the password

Run `omp-remote passwd` on the host machine. Every password session signs out.

## Configuration

`omp-remote init` writes `~/.omp-remote/config.json`. Set `OMP_REMOTE_STATE_DIR`
to use another directory. A host machine's file looks like this:

```json
{
  "version": 1,
  "machineId": "desk",
  "server": {
    "listen": { "host": "0.0.0.0", "port": 8788 },
    "sessionTtlSec": 3600,
    "rememberTtlSec": 2592000,
    "collabRelay": false,
    "pushSubject": "mailto:omp-remote@localhost"
  },
  "agent": {
    "serverUrl": "http://127.0.0.1:8788",
    "collab": false,
    "ompBin": "omp"
  }
}
```

A `server` section runs the server. An `agent` section runs the agent. A machine
added with `join` has only an `agent` section.

| Field | Default | Meaning |
|---|---|---|
| `machineId` | host name | The machine's name on your phone. |
| `server.listen.host` | `0.0.0.0` | Address the server listens on. Use `127.0.0.1` behind a proxy. |
| `server.listen.port` | `8788` | Port the server listens on. |
| `server.publicUrl` | unset | Your HTTPS address. Setting it turns on passkeys. It must start with `https://`. |
| `server.webRoot` | `apps/web/dist` | Directory with the built phone app. |
| `server.sessionTtlSec` | `3600` | Sign-in lifetime in seconds. |
| `server.rememberTtlSec` | `2592000` | Sign-in lifetime with "Keep me signed in" (30 days). |
| `server.collabRelay` | `false` | Serve the OMP `/collab` relay. |
| `server.pushSubject` | `mailto:omp-remote@localhost` | Contact address sent with push notifications. |
| `agent.serverUrl` | none | Server address the agent dials. `http`, `https`, `ws` and `wss` all work. |
| `agent.phoneId` | first paired phone | Which paired phone the agent talks to. |
| `agent.collab` | `false` | Bridge OMP `/collab` sessions. Needs `server.collabRelay` on the server. |
| `agent.ompBin` | `omp` | Path to the `omp` executable. |
| `agent.devClient` | off | Local development client socket. Leave it unset. |

Secrets live beside `config.json`, readable only by you: `session-secret`,
`password.json`, `credentials.json` (passkeys), `machines.json` (machine tokens,
hashed), `agent-token`, `vapid.json`, the push subscriptions and `pairing.json`.
Do not copy them between machines.

Restart omp-remote after you edit `config.json`. If it runs in a terminal, stop it
with Ctrl+C and start it again. If you installed it, run `omp-remote install`
again. That stops the running copy and starts a fresh one. On Linux,
`systemctl --user restart omp-remote` also works.

## Optional HTTPS

HTTPS turns on install, push notifications and passkeys. The server itself always
speaks plain HTTP. Put something in front of it that handles TLS, then tell the
server its HTTPS address:

1. Set `server.publicUrl` in `config.json` to the HTTPS address, for example
   `"https://desk.example.com"`.
2. Restart omp-remote.
3. Open the HTTPS address on your phone and sign in with your password.
4. Open Settings and tap "Add a passkey".

Passkeys are tied to the host name in `publicUrl`. If you change the host name,
add your passkeys again.

### Tailscale

This is the simplest option. Turn on MagicDNS and HTTPS certificates in the
Tailscale admin console. Then run this on the host machine:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8788
```

Set `server.publicUrl` to the machine's tailnet address, such as
`https://desk.tail1234.ts.net`, and restart omp-remote. Your phone needs Tailscale
too. Leave `server.trustProxy` off: `tailscale serve` passes along an
`X-Real-IP` header that the server must not trust.

### Caddy with a DNS challenge

Use this if you own a domain. Point a DNS record such as `desk.example.com` at the
host's LAN or tailnet address. Caddy gets a certificate through your DNS
provider's API, so no port needs to be open to the internet. Build Caddy with your
provider's module (for example `xcaddy build --with github.com/caddy-dns/cloudflare`)
and use:

```caddy
desk.example.com {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
    reverse_proxy 127.0.0.1:8788 {
        header_up X-Real-IP {remote_host}
    }
}
```

Set `server.listen.host` to `127.0.0.1` so only Caddy reaches the server. The
`header_up` line makes Caddy send the real client address instead of passing on
whatever the client sent. With it in place, set `server.trustProxy` to `true` so
the password rate limit tracks each client separately. Without `trustProxy`,
all sign-in attempts through the proxy share one limit.

### mkcert

[mkcert](https://github.com/FiloSottile/mkcert) makes a local certificate
authority. It needs the most manual work:

1. Run `mkcert -install`, then `mkcert desk.lan` for a name your phone can
   resolve, such as a DNS entry on your router.
2. Install the mkcert root certificate on your phone and mark it as trusted.
   `mkcert -CAROOT` shows where it is.
3. Serve the certificate with a proxy, such as Caddy with
   `tls desk.lan.pem desk.lan-key.pem` and `reverse_proxy 127.0.0.1:8788`. Add
   `header_up X-Real-IP {remote_host}` and set `server.trustProxy`, as above.

Passkeys do not work with a bare IP address. Use a host name.

### Password and passkeys

Password and passkeys work side by side. Password sign-in stays on until you turn
it off. To turn it off, sign in with a passkey and use the toggle in Settings. You
need at least one passkey, and you confirm with it. You can turn password sign-in
back on from any session.

## Public server

You can also run the server on a VPS, so your machines and phone reach it from
anywhere without a tunnel. It is the same program with only the `server` section
and an HTTPS `publicUrl`, behind a TLS proxy:

```bash
omp-remote init --role server --public-url https://omp.example.com
```

Each machine then runs `omp-remote join https://omp.example.com`. See
[`docs/omp-remote/PUBLIC-SERVER.md`](omp-remote/PUBLIC-SERVER.md) for the proxy
setup and the service unit.

## Troubleshooting

Run `omp-remote doctor`. It checks each part in order and prints one line per
check: `ok`, or `FAIL` with the reason and a fix. It exits with code 1 if any
check fails.

It checks the config, the secret file permissions, the server port, the sign-in
endpoint, this machine's token, the agent connection, the bridge install, the
bridge's local socket, the paired phone and the built phone app.

Logs from the installed service go to `~/.omp-remote/omp-remote.log` on Windows.
On Linux, read them with `journalctl --user -u omp-remote`.

Common problems:

- **The phone cannot load the page.** Check the firewall on the host machine for
  port 8788. Check that the phone is on the same network or tunnel.
- **No passkey button.** The page is on plain HTTP, or `server.publicUrl` is unset.
  See [Optional HTTPS](#optional-https).
- **"Too many attempts."** Wrong passwords slow down sign-in for your address.
  Wait the time shown.
- **A machine stays offline after you revoked it.** Run `omp-remote join` on it
  again.

## Threat model

The server routes sealed frames and never holds session keys. It cannot read
transcripts or forge commands. But the server also serves the phone app. A
compromised server could ship a malicious app that reads the keys on your phone.
Run the server on hardware you control, or trust whoever runs it.
