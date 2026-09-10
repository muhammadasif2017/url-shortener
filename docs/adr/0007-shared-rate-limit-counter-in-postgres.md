# 0007. Count API rate limits in Postgres, redirects in memory

**Status:** Accepted. Supersedes
[0002](0002-in-memory-rate-limiting.md) for the API paths.

## Context

The in-memory limiter from 0002 rested on the claim that rate limiting was not a
security control. Once sign-in existed, that claim was false. A limit on
credential attempts is a security control, and a per-instance counter multiplies
by instance count, so it is not a limit at all as soon as a second instance
runs.

Each credential attempt also runs scrypt, which costs roughly 33 MiB and a
tenth of a second of thread-pool work on a service with a single event loop.

## Decision

Count the `/api/` paths, including the credential endpoints, in a
`rate_limit_windows` table in the same PostgreSQL database the service already
depends on. Keep the redirect path counting in process memory.

Credential paths get their own far stricter limit: ten attempts per fifteen
minutes, against sixty per minute for the rest.

## Consequences

- The credential limit is now global across instances, which is the property
  that makes it a control rather than a suggestion. It also slows credential
  stuffing from thousands of guesses an hour to forty.
- No new dependency. Redis would have been the conventional answer and would
  have broken the single-dependency rule for a counter the database can hold.
- Every API request pays a database round trip to be decided. The API paths are
  low volume and each already talks to the database, so the round trip is noise
  there.
- **The redirect path stays in memory, and that is a decision.** It is the hot
  path, and what its limit protects is the database itself from click-write
  amplification. Paying a synchronous round trip to a database in order to
  protect that database from writes would be self-defeating. A per-instance cap
  still bounds the damage at instances times the cap, which is the property that
  matters there.
- The limiter fails closed. If the counter cannot be read, the request is
  refused with `503`. The counter lives in the same database every route behind
  that point needs, so an unreadable counter means a database that could not
  have served the request anyway; allowing the request through would remove the
  limit exactly when the service is least able to absorb load.
