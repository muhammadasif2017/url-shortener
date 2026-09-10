# Security

## Reporting a vulnerability

Report privately, not as a public issue. Use GitHub's
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository.

Include what you did, what happened, and what you expected. A request that
reproduces it is worth more than a description of it. If a response carried an
`X-Request-Id`, quote it: every log line written while serving that request
carries the same value.

Expect an acknowledgement within a week. This is a personal project with no
on-call rotation and no bounty.

## Scope

This is a learning project. It is **not deployed**, so there is no production
instance to attack and no user data at risk. What is worth reporting is a flaw
in the code as written, reproducible against a local instance.

In scope:

- Anything that lets one account read, modify, or delete another account's links
  or statistics.
- Anything that authenticates as another user, or that survives a sign-out.
- Injection of any kind, including into SQL, a response header, or a log line.
- A way to make the service store or return a raw client address, which it goes
  to some trouble never to keep. See
  [ADR 0004](docs/adr/0004-hash-the-client-ip.md).
- A way past the rate limiters, particularly on the credential endpoints.
- An open redirect beyond the intended one, or a way to make a link point at
  this service's own host.

Out of scope:

- Anything requiring a modified local build, a different configuration, or
  database access. If you can already run SQL, you have already won.
- Missing hardening that the threat model records as a deliberate trade. Read
  `THREAT-MODEL.md` first.
- Denial of service by volume. The service runs as one process and does not
  claim otherwise. See
  [ADR 0005](docs/adr/0005-single-process-no-load-balancer.md).
- The absence of a deployment, TLS termination, or a WAF.

## What is already known

`THREAT-MODEL.md` documents the threat model of the running service and its
twelve findings, all of which are fixed. Read it before reporting: a finding it
already names, with the reasoning for why it was accepted or how it was closed,
is not a new report.

Notable properties that are deliberate rather than oversights:

- A slug is public by construction. It appears in browser history and referrer
  headers, so it can never also be the credential guarding a link. Every route
  that reads a link's metadata or statistics resolves an owner instead.
- Registration answers identically whether or not an address was already taken,
  and never issues a session, so it cannot be used to enumerate accounts.
- Session identifiers are stored hashed. The log never records one, and neither
  does the audit log.
- The rate limiter fails closed. If its counter cannot be read, the request is
  refused.
