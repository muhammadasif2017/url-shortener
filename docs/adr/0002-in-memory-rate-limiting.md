# 0002. Rate limiting in process memory

**Status:** Superseded by [0007](0007-shared-rate-limit-counter-in-postgres.md)
for the API paths. Still in force for the redirect path.

## Context

The service needed a rate limiter and had a hard constraint against adding
dependencies. It also ran, and still runs, as a single process, which was
recorded separately in [0005](0005-single-process-no-load-balancer.md).

One process means one counter. A `Map` keyed by client address, with a window
timestamp, needs no external store and no new dependency.

## Decision

Count every request in a `Map` held in process memory. Accept that the counter
resets on deploy, on the reasoning that this limiter was not a security control.

## Consequences

- No Redis, and the single-dependency rule held.
- Counters reset on every deploy, so a caller near the limit is forgiven by a
  restart.
- The limiter is per instance. With one instance that is the same as global.

## Why it was superseded

The reasoning above contains the flaw that eventually broke it: "not a security
control" stopped being true once the credential endpoints existed. A limit on
sign-in attempts is exactly a security control, and a per-instance counter
multiplies by the number of instances, which means it is not a limit at all the
moment a second instance appears.

Record 0007 moved the API paths, including the credential endpoints, to a
counter in Postgres. The redirect path deliberately stayed here, and 0007
explains why that split is a decision rather than an unfinished migration.
