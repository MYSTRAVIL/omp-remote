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
