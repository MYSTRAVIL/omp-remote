# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting. Open the repository on GitHub, go
to the **Security** tab, and click **Report a vulnerability**. This opens a
private advisory visible only to maintainers. Do not open a public issue for
security findings.

## Scope

In scope: the aggregator, host-agent, bridge extension, phone PWA, and the
crypto/pairing code. Out of scope: the Bun runtime, the OMP core, third-party
dependencies (file those with the upstream project), and infrastructure outside
this repository.

## Threat model summary

The aggregator routes sealed frames and never holds session keys. It cannot read
transcripts or forge commands through the relay. However, the same server that
runs the aggregator also serves the PWA to your phone. If the server is
compromised, it can ship malicious client code to the phone, which then has
access to the encryption keys. The relay is content-blind for routing, not a
defense against a hostile server operator. Trust the server you point your phone
at. See `docs/SELF-HOSTING.md` for mitigation options.

## Known limitations

These are accepted for now. Each has a mitigation you can apply.

- **A signed-in phone can enrol a machine without a second check.** The server
  issues a new machine's `/agent` token when the phone claims the pairing code,
  before anyone compares the verification codes. The phone asks before it
  claims, and it trusts the machine's key only after you tap **Codes match**.
  Rejecting the codes still leaves the machine on the server. Anyone holding a
  valid session token can also claim a pairing themselves. A machine token does
  not end when you sign out everywhere or change the password. A machine
  enrolled this way sees no transcripts and cannot send commands, but it can
  send "needs your attention" pushes. Mitigation: after rejecting a pairing,
  signing out everywhere or changing the password, open **Settings › Machines**
  and revoke any machine you do not recognise. Links in transcripts never open
  the pairing prompt. Closing this fully needs the phone to confirm the codes to
  the server before the token works, which changes the pairing protocol.
- **The phone's session token is in the `/client` WebSocket URL.** Reverse
  proxies log request URLs by default, so the access log holds tokens (up to 30
  days with "Keep me signed in"). On plain HTTP the token also crosses the
  network in clear. The server closes a `/client` socket when its token expires
  or the password changes, and signing out everywhere ends every token.
  Mitigation: keep the access log private, or log `$uri` instead of
  `$request` for `/client`. Use HTTPS when the phone leaves your own network.
- **Behind a proxy that hides client addresses, a sustained flood can still
  slow sign-in for everyone.** Without `trustProxy` (or behind an SNI
  passthrough without PROXY protocol) every request looks alike. Password
  tries then share one budget: 20 at once, then one every 30 seconds. Someone
  guessing at that rate keeps password sign-in busy while they keep it up; it
  clears 30 seconds after they stop. Pending passkey logins and pairings are
  displaced oldest first when their 256-slot table is full, so a fast enough
  flood can cancel one before it completes (about 25 requests a second cancel
  a login within 10 seconds; about 4 a second cancel a pairing within a
  minute), though it can no longer refuse one outright. Mitigation: use
  passkeys, and give the server real client addresses (`trustProxy: true`
  behind a proxy that sets `X-Real-IP` itself) so each client gets its own
  limit.
