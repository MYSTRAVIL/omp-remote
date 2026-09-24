# Public server

Run the server on a VPS when your machines and phone should reach it from anywhere
without a tunnel. It is the same `omp-remote` program as the local setup. The
config has only a `server` section and an HTTPS `publicUrl`. A TLS proxy sits in
front of it.

For the default local setup, see [`../SELF-HOSTING.md`](../SELF-HOSTING.md). For
the component map, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

> **The server is content-blind.** It holds no device private keys, no session
> keys and no plaintext. It sees the clear routing header of each sealed frame,
> connection counts, frame sizes and timing. That is why a rented VPS is an
> acceptable place for it.

## Topology

```
phone ──HTTPS/WSS──► TLS proxy :443 ──► omp-remote run (server) 127.0.0.1:8788
                                                ▲
machine agents ──outbound WSS──► TLS proxy :443 ┘
```

- The server listens on loopback only. The proxy is the only public surface.
- Machines take no inbound ports. Both the phone and every agent dial out to 443.
- The server serves the phone app itself. The proxy forwards every path.

## 1. Install

On the server, as the user that will run it:

```bash
git clone <repo-url> omp-remote
cd omp-remote
bun install
bun run --cwd apps/web build
cd apps/cli && bun link && cd ../..
```

## 2. Configure

```bash
omp-remote init --role server --public-url https://omp.example.com
```

`init` asks for the password and writes `~/.omp-remote/config.json` with its
secrets beside it. `publicUrl` must start with `https://`. It turns on passkeys,
tied to the host name `omp.example.com`.

Then make sure the server listens on loopback only:

```json
{
  "version": 1,
  "machineId": "vps",
  "server": {
    "listen": { "host": "127.0.0.1", "port": 8788 },
    "publicUrl": "https://omp.example.com",
    "trustProxy": true
  }
}
```

`trustProxy: true` tells the server that the proxy in front of it sets
`X-Real-IP` to the real client address. Both proxy configs below do that. Leave
it off (the default) behind any proxy that does not: the server then ignores
forwarded headers.

Set `server.collabRelay` to `true` if your machines bridge OMP `/collab` sessions.

## 3. TLS proxy

Get a certificate for `omp.example.com`, for example from Let's Encrypt with
certbot. Then proxy everything to the server. The proxy must pass WebSocket
upgrades and keep idle sockets open.

nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name omp.example.com;

    ssl_certificate     /etc/letsencrypt/live/omp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/omp.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 1d;
        proxy_send_timeout 1d;
        proxy_buffering off;
    }
}
```

Caddy gets the certificate on its own. Caddy passes the client's own
`X-Real-IP` header through unless told otherwise, so set it to the real peer:

```caddy
omp.example.com {
    reverse_proxy 127.0.0.1:8788 {
        header_up X-Real-IP {remote_host}
    }
}
```

The server rate-limits password attempts per client address, and also across
all clients. With `trustProxy: true` it takes the client address from
`X-Real-IP`, or from the last `X-Forwarded-For` hop, and only when the request
comes from a loopback peer. It keys IPv6 clients by their /64 prefix. Without
`trustProxy`, a loopback peer carries no client address, so every attempt
through the proxy counts against one shared limit. A lockout then applies to
everyone, which is safer than an open brute force. Never set `trustProxy`
behind a proxy that forwards the client's own `X-Real-IP`: each request could
then choose its own address and dodge the per-client limit.

## 4. Start at boot

`omp-remote install` registers a systemd user unit. On a headless server, run
`loginctl enable-linger $USER` once so the unit starts without a login.

A system unit with a dedicated user also works:

```ini
[Unit]
Description=omp-remote server
Wants=network-online.target
After=network-online.target

[Service]
User=omp-remote
Environment=OMP_REMOTE_STATE_DIR=/var/lib/omp-remote
WorkingDirectory=/opt/omp-remote
ExecStart=/usr/local/bin/bun run apps/cli/src/main.ts run
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/omp-remote

[Install]
WantedBy=multi-user.target
```

With this unit, run `init` and `passwd` with the same `OMP_REMOTE_STATE_DIR`, as
the `omp-remote` user.

## 5. Sign in and lock down

1. Open `https://omp.example.com` on your phone and sign in with the password.
2. Open Settings and tap "Add a passkey".
3. Sign in again with the passkey. Turn off password sign-in in Settings. A public
   server is then reachable by passkey only. You can turn it back on later from
   any session.

## 6. Join machines

On each machine with OMP sessions:

```bash
omp-remote join https://omp.example.com
omp-remote install
```

Approve each machine from the phone and compare the verification code. Revoke a
machine from Settings.

## 7. Verify

- `omp-remote doctor` on the server prints only `ok` lines.
- `curl https://omp.example.com/auth/methods` returns
  `{"password":true,"passkey":true}`, or `"password":false` after you turn it off.
- `omp-remote doctor` on each machine shows the agent connection as `ok`.

## Rules

- **Content-blindness is load-bearing.** The server may read only the clear
  routing header. It must never parse, log or store frame plaintext, and never
  hold session keys. Any change that lets it read frames is a bug.
- The server binds loopback only. The proxy is the only public surface.
- Secrets stay in the state directory. Never commit them.
- Keep the proxy's read and send timeouts long. The server sends keepalive pings
  on every long-lived socket, but a short proxy timeout still cuts idle sockets.

## Maintainer deployment

This section is for the project maintainer's own instance. Other deployments can
ignore it.

Two scripts deploy from the repo. Both read the target from the gitignored root
`.env` (see [`../../.env.example`](../../.env.example)) and refuse to run when a
value is missing:

| Variable | Meaning |
|---|---|
| `OMP_DEPLOY_HOST` | SSH destination with root access, such as `root@host`. |
| `OMP_DEPLOY_URL` | Public base URL, such as `https://omp.example.com`. |

```bash
bun run deploy:web          # build apps/web and ship dist/ to a new release dir
bun run deploy:aggregator   # ship the server and restart it
```

**Release scheme.** Each deploy lands in a fresh release directory named by the
git short sha. One `rename(2)` flips a symlink to it. The web root
`/var/www/omp-remote` points into `/var/www/omp-remote-releases/<sha>/`, and
`server.webRoot` points at `/var/www/omp-remote`. The server binary link points
into `/usr/local/lib/omp-remote/releases/<sha>/`. If the new server does not come
up listening on 8788, the script flips back and restarts. The last 5 releases are
kept.

**Rollback.** Repoint the symlink to a kept release:

```bash
ssh "$OMP_DEPLOY_HOST" 'ln -sfnT /var/www/omp-remote-releases/<sha> /var/www/omp-remote.next \
  && mv -T /var/www/omp-remote.next /var/www/omp-remote'

ssh "$OMP_DEPLOY_HOST" 'ln -sfnT /usr/local/lib/omp-remote/releases/<sha>/omp-remote-aggregator \
  /usr/local/lib/omp-remote/omp-remote-aggregator.next \
  && mv -T /usr/local/lib/omp-remote/omp-remote-aggregator.next \
        /usr/local/lib/omp-remote/omp-remote-aggregator \
  && systemctl restart omp-remote-aggregator'
```

After a web deploy, close and reopen the phone app once to load the new service
worker. Check upgrades in an existing browser too, not only a fresh profile: the
new cache must hold the deployed bytes.
