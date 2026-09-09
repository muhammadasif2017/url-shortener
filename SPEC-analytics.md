# Spec: analytics module

Module id: `analytics`
Depends on: `links`
Status: **placeholder — not yet specified**
Parent spec: `SPEC.md`

This module is third in the build order and is deliberately left unspecified
until `links` and `identity` are finished and reviewed.

Writing this spec is itself a task in `tasks/todo.md`, gated behind the
completion of `identity`.

## Objective (provisional)

Record every redirect as its own row, so that a link owner can see how often a
link was used, when, and where the traffic came from.

## Scope (provisional)

In scope:

- A `click_events` table, one row per redirect, referencing `links.id` with
  `on delete cascade`. This means deleting a link destroys its click history
  irreversibly, which is a second reason the unauthenticated delete route in
  `SPEC-links.md` must be closed before deployment.
- Captured per click: timestamp, referrer, user agent, and a salted hash of the
  visitor IP address.
- A statistics endpoint returning a total and a per-day breakdown.
- A top-referrers query.

Out of scope:

- Real-time dashboards and streaming updates.
- Geolocation, which needs a third-party database.
- Bot filtering beyond an obvious user-agent check.
- A scheduled rollup job. Raw event queries are fast enough at this scale, and a
  scheduler is a whole subsystem to add before it is needed.

## Decisions already made in `SPEC.md`

- One row per click. A counter column was rejected because it supports no
  question beyond a total.
- A raw IP address is never stored. Only a salted hash, and only for counting
  unique visitors.
- The IP address comes from the single shared client-IP resolver specified under
  Cross-Cutting Requirements in `SPEC.md`, never from `socket.remoteAddress` or
  `X-Forwarded-For` read at this call site. An earlier draft said to read the
  socket address directly. That was wrong: the deployment target routes traffic
  through its own proxies, so the socket address is an edge node and every
  stored hash would be identical, collapsing unique visitors to one.
- The salt is `IP_HASH_SALT`. Rotating it resets unique-visitor counts, because
  the same visitor hashes to a different value afterwards.
- Writing the click event must not be able to break the redirect. How that is
  guaranteed is the central design question of this module.

## Decision: the click insert is not awaited

**Resolved.** The redirect response is sent first. The click event is written
afterwards, without the handler waiting for it.

### Why

A redirect is the product. Making it wait on an analytics write means every
visitor pays that latency, and a slow or unavailable database turns a working
redirect into a failure. Analytics is the less important of the two, so
analytics is the thing allowed to be lossy.

### What this decision forces

Fire-and-forget is only safe when it is written deliberately. Each of these is
mandatory.

1. **The promise must never reject unhandled.** An unhandled rejection
   terminates a modern Node process by default, which would mean an analytics
   write taking down the whole service. Every fire-and-forget call attaches a
   `.catch()` that logs and swallows. That `.catch()` is not optional and is not
   a style preference.
2. **Events can be lost, and that is accepted.** A crash or a restart between
   the response and the insert drops the event. Click counts are therefore a
   lower bound, not an exact figure. This must be stated wherever the numbers
   are presented, so nobody later treats them as authoritative.
3. **Tests need a deterministic drain.** An unawaited write is a race. A test
   that redirects and then immediately asserts a click count will pass or fail
   depending on timing. The module tracks in-flight writes in a set and exports
   `drainPendingWrites()`, which awaits them. Integration tests call it before
   asserting. Polling with a timeout is not acceptable, because it trades a
   flaky failure for a slow one.

   Two properties make that mechanism sound, and neither is optional:

   - **The promise is added to the pending set synchronously, before the
     response is flushed.** If registration happens after an `await`, or from a
     `finish` handler on the response, the test's own `await fetch(...)` can
     resolve before anything is in the set. `drainPendingWrites()` then returns
     immediately over an empty set, and the assertion fails. That reintroduces
     exactly the race the mechanism exists to remove, so the ordering is a
     requirement rather than an implementation detail.
   - **The drain loops until the set is empty.** A single `Promise.all` over a
     live set misses writes added while that `Promise.all` was pending. It must
     repeat until a full pass finds nothing.
4. **Shutdown must drain, in the right order.** `server.close()` stops new
   connections; it does **not** wait for in-flight requests, and those requests
   keep adding writes. Draining immediately after `close()` therefore returns
   before the last events exist. The correct order is: stop accepting, wait for
   in-flight requests, then drain, then close the pool. The full sequence lives
   under Graceful Shutdown in `SPEC.md`.

   Every wait is bounded. An unbounded drain against a hung database means the
   platform sends `SIGKILL` and discards everything anyway, so a 5 second
   deadline with a logged timeout is strictly better than waiting forever.
5. **Failures must stay visible.** A swallowed error is invisible by
   definition. Every failed click insert logs at error level with the link id
   and the database error code, so a systematic failure does not look like an
   absence of traffic.

## Open questions to resolve before writing this spec

1. What indexes does the per-day breakdown need, and does the aggregation happen
   in SQL with `date_trunc` or in application code? Whichever is chosen,
   `count(*)` returns `bigint`, which `pg` hands back as a **string**. A test
   asserting `assert.equal(total, 3)` fails against `'3'` under `assert/strict`.
   The repository converts counts with `Number()` at its boundary, as required
   by Cross-Cutting Requirements in `SPEC.md`.
2. How long are click events retained, and is there a deletion policy?
3. On what schedule, if any, is `IP_HASH_SALT` rotated? The effect is already
   settled: rotation resets unique-visitor counts, because the same visitor
   hashes to a new value. What is open is the policy, and whether a rotation
   should be recorded so that a discontinuity in the numbers is explainable
   later.
