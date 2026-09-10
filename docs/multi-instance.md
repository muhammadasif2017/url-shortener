# Running two instances: what broke

[ADR 0005](adr/0005-single-process-no-load-balancer.md) records the decision to
run one process, lists five things a second instance would break, and says what
the follow-up work should produce:

> The deliverable is a written record of what broke and why, not a throughput
> number.

This is that record. Every number below was observed, not reasoned about. The
stack and the scripts that produced them are in the repository, so any claim
here can be re-run.

## The setup

`docker-compose.multi.yml` brings up nginx in front of two application
instances, sharing one PostgreSQL database. Round robin, deliberately not
sticky routing: sticky routing would hide the thing being measured, which is two
instances holding two different answers.

```
docker compose -f docker-compose.multi.yml up -d --build
npm run experiments
docker compose -f docker-compose.multi.yml down -v
```

## Summary

| #   | Question                                          | Predicted                                        | Observed                                          |
| --- | ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| 1   | Is the client address still right behind a proxy? | Wrong hop count collapses every visitor into one | Confirmed, and the correct setting works          |
| 2   | Does the credential limit double?                 | No. The counter is shared in Postgres            | Held at exactly 10 across both instances          |
| 3   | Does a rolling restart drop requests?             | No. Graceful shutdown drains                     | 51 of 51 served, zero dropped                     |
| 4   | What happens when the database goes away?         | Readiness degrades, liveness holds, no restarts  | **Both instances crashed.** Fixed, then confirmed |
| 5   | Does the redirect limit double?                   | Yes, and that is accepted                        | 100 refused by one instance, 0 by two             |

Three of the five confirmed that a fix already in the codebase works. One
confirmed an accepted cost. One found a real bug that had been latent since the
project began.

## The bug: the service died when the database restarted

This is the finding that justified the phase.

Experiment 4 stops PostgreSQL and asks what each probe reports. What actually
happened is that both application containers exited within a second of each
other, with exit code 1 and a stack trace:

```
error: terminating connection due to administrator command
```

`pg` emits an `error` event on the pool when a client that is sitting idle loses
its connection. Nothing listened for it, and an `error` event with no listener
is an uncaught exception in Node, which ends the process.

So every database restart, failover, or `pg_terminate_backend` killed the
service outright rather than degrading it. Nothing in the test suite could catch
this: every test runs against a database that stays up, and the failure needs a
connection to be dropped from the server side while sitting idle.

It also defeated the point of [ADR 0008](adr/0008-split-liveness-from-readiness.md)
entirely. Readiness exists so an instance can say "I cannot serve right now" and
be put back in rotation when the dependency returns. A process that has exited
has no readiness to report, and the split was answering a question that could
never be asked.

The fix is four lines in `src/db/pool.ts`: attach a listener, log, and let the
pool discard the broken client and open a new one on the next request. There is
nothing to repair, and that is the point. What mattered was that the event had a
listener at all.

After the fix, the same experiment produced what ADR 0008 describes:

```
GET /health/live  -> 200   the process is fine
GET /health/ready -> 503   {"status":"degraded","database":"down"}
app1 restart count during outage: 0
GET /health/ready -> 200   after recovery, with no restart and no redeploy
```

## Experiment 1: the client address

The live risk. Analytics hashes the visitor address to count unique visitors and
the rate limiter keys on the same value, so a wrong address corrupts both in the
same direction, and neither reports an error while doing it.

Three configurations, because one proves nothing:

| Configuration                                          | Distinct visitors recorded from 3 clients |
| ------------------------------------------------------ | ----------------------------------------- |
| `TRUST_PROXY_HOPS=0` behind the proxy                  | 1                                         |
| `TRUST_PROXY_HOPS=1`, correct here                     | 3                                         |
| `TRUST_PROXY_HOPS=1`, client forging `X-Forwarded-For` | 1                                         |

The first row is the failure ADR 0005 warns about, and it is silent: three
visitors became one, with no error anywhere. Unique-visitor counts would have
been wrong by whatever factor the traffic mix happened to produce, and the rate
limiter would have treated the entire internet as a single client.

The third row is the one worth having. A client sent three different forged
left-hand entries from one container, and nginx appended the address it actually
saw. Counting one trusted hop from the right ignores everything the client
supplied, so all three clicks recorded one visitor. Forging changes nothing.

**The experiment was wrong before the service was.** The first run reported 1
distinct visitor where 3 was expected. The cause was three throwaway containers
run one after another: Docker frees an address when a container exits and hands
the same one to the next. Running them concurrently gave three addresses and the
expected result. Worth recording because a broken instrument reporting a broken
result is the failure mode of this kind of work.

## Experiment 2: the credential limit held

Twelve sign-in attempts through the proxy, landing on alternating instances:

```
401 401 401 401 401 401 401 401 401 401 429 429
```

Refused on the eleventh, which is exactly the configured limit of 10, even
though neither instance saw more than six attempts. This is
[ADR 0007](adr/0007-shared-rate-limit-counter-in-postgres.md) working: the
counter is a row in `rate_limit_windows`, not a `Map` in one process.

Under the original in-memory limiter this would have refused on the twenty-first
attempt, and with ten instances the two-hundred-and-first. That is the sense in
which a per-instance credential limit is not a limit.

## Experiment 3: nothing was dropped

51 requests sent through the proxy over eight seconds while one instance
received SIGTERM. 51 succeeded. Zero failures, no 502s, no resets.

The instance stopped accepting new connections, finished what it was holding,
drained pending click writes, closed the pool, and exited. nginx moved traffic to
the survivor. This is `src/shutdown.ts` doing what it was written for, observed
rather than assumed.

## Experiment 5: the redirect limit doubles

| Configuration                     | Refused of 700 requests |
| --------------------------------- | ----------------------- |
| One instance, bypassing the proxy | 100                     |
| Two instances, through the proxy  | 0                       |

The cap is 600 per minute per instance. One instance refuses the last hundred.
Two instances refuse nothing, because each saw only about 350.

This is not a defect. ADR 0007 states it as the accepted cost of keeping the hot
path off the database: what the redirect limit protects is the database from
click-write amplification, and paying a synchronous round trip to that same
database in order to protect it would be self-defeating. A per-instance cap
still bounds the damage at instances times the cap.

The value of running it is that the stated downside is now a measured downside.
A decision whose cost has never been observed is a decision nobody has checked.

**Two instrument bugs here too.** In multi-URL mode, curl applies `-o /dev/null`
to the first URL only, so every later response body ran into the status line
after it and the refusal count read zero. And because the counter lives in
process memory, a previous run's requests carried into the next one until the
script began restarting the instances first.

## What this changed in the codebase

- `src/db/pool.ts` gained a pool `error` listener. Without it the service exits
  whenever the database restarts.
- `nginx/nginx.conf` does **not** retry on `http_503`, and that was a bug here
  first. This service uses 503 as a real answer twice: readiness reporting the
  database unreachable, and the rate limiter failing closed. Retrying those
  replaces an honest 503 with a synthesized 502, so a load balancer reading
  readiness learns the wrong thing, and it doubles the load of every failing
  request at the moment the dependency is already struggling.

## What is still true about running one process

Nothing here argues for running two instances in production. The rate limiter,
the client address handling, and the shutdown sequence are all now known to work
across instances, but ADR 0005 stands: the deployment target gives one instance,
and the redirect limit still multiplies by instance count by design.

What changed is that the decision is now informed by observation rather than by
prediction, and one real bug was found on the way.
