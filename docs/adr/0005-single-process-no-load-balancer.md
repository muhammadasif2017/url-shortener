# 0005. One process, no load balancer of our own

**Status:** Accepted

## Context

Adding a load balancer in front of two application containers was raised. It
would have made the service horizontally scalable and would have exercised a
real production topology.

Several later choices depend on the answer, so leaving it implicit would have
made those choices quietly wrong.

## Decision

Run one process. Do not add a load balancer of our own, and do not use
`node:cluster`.

## Consequences

What this permits:

- A rate limiter may live in process memory, because one process means one
  counter. See [0002](0002-in-memory-rate-limiting.md), and
  [0007](0007-shared-rate-limit-counter-in-postgres.md) for where that stopped
  being enough.
- Any future cache may live in process memory for the same reason.

What it does **not** permit, and this was the original wording's mistake:
reading the client address from `socket.remoteAddress`. The decision removes
load balancers _of our own_. It does nothing about the platform's. The
deployment target fronts every service with its own load balancers and with
Cloudflare, so in production the socket address belongs to an edge node. Client
IP resolution is specified under Cross-Cutting Requirements in `SPEC.md` and
applies regardless of this decision.

## What must change first if this is reversed

Each of these fails silently, which is why they are written down rather than
left to be discovered.

1. **Rate limiting stops working as specified.** Two instances keep two
   independent counters, so the effective limit doubles. This is the failure
   that 0007 already fixed for the API paths and deliberately did not fix for
   the redirect path.
2. **The client address becomes wrong.** Behind a proxy, `socket.remoteAddress`
   is the proxy. The real client sits in `X-Forwarded-For`, which is
   caller-supplied and trivially spoofed unless the number of trusted proxy hops
   is fixed and enforced. Analytics hashes the visitor address, so a wrong or
   spoofable value corrupts unique-visitor counts and the rate limiter together.
3. **Rolling restarts drop in-flight requests.** Graceful shutdown becomes
   mandatory: stop accepting connections, drain what is open, close the pool,
   then exit. This is already implemented.
4. **Health checks gain real consequences.** They start deciding whether an
   instance receives traffic and whether it is restarted. See
   [0008](0008-split-liveness-from-readiness.md).
5. **The deployment target changes.** A free tier gives one instance and no
   control over balancing. Multi-instance means a VPS running Compose, or a paid
   plan.

## If revisited, the goal is

Learning the failure modes above by causing them deliberately: killing an
instance mid-request, watching the rate limit double, observing the wrong
address reach analytics, then fixing each one. The deliverable is a written
record of what broke and why, not a throughput number.
