# 0008. Answer liveness and readiness separately

**Status:** Accepted

## Context

The service had one health endpoint, `/health`, which queried the database. The
reasoning was sound as far as it went: an instance whose database is unreachable
is not healthy, and reporting otherwise keeps a broken instance in rotation.

But two different consumers read a health check and act on it differently. A
load balancer removes an instance from rotation. An orchestrator restarts the
container. Serving one answer to both forces them to agree.

The way they disagree is expensive. A database outage is not something a restart
repairs, so a single database-backed probe answers a database outage with a
restart loop across every instance, at exactly the moment the database is least
able to absorb reconnections.

## Decision

Serve two endpoints. `/health/live` touches nothing outside the process.
`/health/ready` queries the database. `/health` is kept, unchanged, and reports
readiness.

The container `HEALTHCHECK` points at `/health/live`.

## Consequences

- A database outage now takes instances out of rotation without restarting them,
  which is the correct response to a dependency that is down.
- The only failure liveness can report is one where the event loop is so blocked
  that no response is written at all, which is precisely the failure a restart
  fixes.
- `/health` keeping its old meaning means no existing deployment, monitor, or
  test breaks. The cost is three endpoints where two would do. Quietly changing
  what an endpoint that things already poll means would have been worse.
- Both new paths are two literal segments, so the router's precedence rules keep
  them clear of the `/:slug` redirect with no special case.
