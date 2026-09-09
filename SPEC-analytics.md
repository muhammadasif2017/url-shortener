# Spec: analytics module

Module id: `analytics`
Depends on: `links`, `identity`
Status: **specified**
Parent spec: `SPEC.md`

This module is third in the build order. It was deliberately left unspecified
until `links` and `identity` were finished and reviewed, because both of them
decide things this module depends on: `links.id` is the foreign key every click
event points at, and `identity` decides who is allowed to read a link's
statistics.

## Objective

Record every redirect as its own row, so that a link owner can see how often a
link was used, when, and where the traffic came from.

## Scope

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
   write taking down the whole service. A `.catch()` that logs and swallows is
   therefore mandatory, and it is attached inside the module rather than by each
   caller. `recordClick()` returns `void`, not a promise, so there is nothing at
   a call site to forget: the failure mode is removed rather than documented.
   The write tracker also stores the already-caught promise, so a rejection can
   reach neither the process nor the drain.
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
6. **The pending set is capped, and sheds when full.** The redirect route is
   deliberately not rate limited, so it is the one path where unauthenticated
   traffic can grow something without bound. The pool holds ten connections, so
   a burst queues writes faster than they drain. The cap is 10,000 outstanding
   writes, matching the rate limiter's hard cap for the same class of memory
   exhaustion. Above it, a click is dropped rather than queued, and the write is
   never started: accepting the promise and discarding it would still issue the
   insert, which is the load being shed. Dropping is consistent with point 2,
   which already accepts that events are lost. Shedding is logged at warn on the
   first drop and again when the backlog clears, with a count, rather than once
   per dropped click, because a service failing to keep up does not need a log
   line per request as well.

## Decision: statistics are owner-only

**Resolved.** Both statistics endpoints require an authenticated session and
return data only to the link's owner.

A statistics endpoint that answers on the slug alone would hand a link's entire
click history to anyone who can guess or observe a slug. A slug appears in every
browser history, referrer header, and chat log the link passes through, so it is
public by construction and cannot also be a credential.

The authorisation rule is the one `deleteLink` already implements in
`links.service.ts`, and it is reused rather than restated:

- No such slug returns `404` with code `LINK_NOT_FOUND`.
- A slug owned by someone else returns `403` with code `FORBIDDEN`.
- A slug with a null `owner_id` also returns `403`. An anonymous link has no
  owner who can prove they created it, so there is no correct person to allow.
  This follows the same reasoning as anonymous deletion in `SPEC-identity.md`:
  the creator accepted that trade by not signing in.
- A request with no session returns `401` with code `UNAUTHENTICATED`.

The link is therefore read and checked before any aggregate query runs. That
costs one extra query per request and buys the difference between 404 and 403,
which is the same trade the delete route already makes.

Clicks are still recorded for anonymous links. The rows exist and cascade on
delete; nobody can read them through the API. Recording is decided by the
redirect, not by ownership, and making the write conditional on an owner would
mean a link that gains no owner also silently gains no history.

## Resolved: aggregation happens in SQL, in UTC, over a bounded window

**Resolved.** The per-day breakdown is computed by the database with
`date_trunc`, always against UTC, always over a caller-bounded window, and
always dense.

### In SQL, not in application code

Aggregating in application code means selecting every raw row for a link and
counting them in JavaScript. That transfers the whole event history over the
wire to produce a few dozen numbers, and it gets slower exactly as a link gets
more popular. `date_trunc` with a `group by` returns one row per day regardless
of traffic.

### Pinned to UTC

`date_trunc('day', occurred_at)` on a `timestamptz` resolves against the
database server's `TimeZone` setting. That setting is not the same everywhere:
the Compose database and the deployed database can disagree, and the same data
would then split into different days depending on where the query ran. The
query therefore states the zone rather than inheriting it:

```sql
date_trunc('day', occurred_at at time zone 'UTC')
```

This is the same class of mistake as tying database TLS to `NODE_ENV`, recorded
under task C3 in `tasks/todo.md`: an environment-dependent default that makes
two deployments of one artifact behave differently. Days are UTC days, this is
stated in the response, and a caller who wants local days converts them itself.

### Bounded window

The breakdown covers a window ending now, requested with a `days` query
parameter: an integer between 1 and 90, defaulting to 30. An unbounded
breakdown returns one row per day for as long as the link has existed, so the
response grows without limit as the service ages. A bound also gives the index
a range to work with instead of scanning every row for the link.

### Dense series

Days inside the window with no clicks are returned as zeros, generated with
`generate_series` and left-joined against the aggregate. A sparse series forces
every consumer to rebuild the calendar itself, and a missing day reads as
continuity rather than as a gap, which is the one thing a traffic chart must not
get wrong.

### Counts are converted at the repository boundary

`count(*)` returns `bigint`, and `pg` hands `bigint` back as a **string**, on
purpose, because 64-bit integers do not fit in a JavaScript number. A test
asserting `assert.equal(total, 3)` fails against `'3'` under `assert/strict`.

The repository converts every count with `Number()` in the same place it
converts `snake_case` to `camelCase`, as required by Cross-Cutting Requirements
in `SPEC.md`. A count in this system cannot exceed `Number.MAX_SAFE_INTEGER`.
`link_id` is `bigint` and stays a string, because it is an identifier and
arithmetic is never performed on it. No global `setTypeParser` call is made.

### Indexes

One index carries this module:

```sql
create index click_events_link_id_occurred_at_idx
  on click_events (link_id, occurred_at desc);
```

Every query this module issues starts by narrowing to one link and then to a
time window, which is exactly that index's shape: the total, the per-day
breakdown, the unique-visitor count, and the top-referrers query all use it.

Deliberately not indexed:

- **`referrer`.** Top referrers groups within a single link's window, which the
  index above has already narrowed. An index on a high-cardinality,
  attacker-supplied text column would cost a write on every click to serve one
  read.
- **`ip_hash`.** Unique visitors is `count(distinct ip_hash)` inside the same
  narrowed set. There is no query that looks a visitor up across links, and
  there must not be one, because that would turn a counting mechanism into a
  tracking mechanism.
- **`is_bot`.** It is filtered inside a row set the index has already reduced to
  one link and one window. A partial index would be a second index to maintain
  on the write path for no measurable read.

The foreign key on `link_id` is covered by the leading column of the same index,
so cascading a link deletion does not scan the table.

## Resolved: click events are retained until their link is deleted

**Resolved.** There is no scheduled deletion and no retention window. A click
event lives until its link is deleted, at which point the foreign key cascade
removes it.

Scope already rejected a scheduled rollup job, on the grounds that a scheduler
is a whole subsystem to add before it is needed. That reasoning applies to
scheduled deletion without modification: a retention job needs a scheduler, a
lock so two instances do not run it at once, and its own failure alerting, all
to solve a problem this service does not have yet.

The cost, stated plainly: the table grows in proportion to total traffic and
nothing shrinks it. At a few hundred thousand clicks the storage is trivial and
the queries are served by one index. This becomes wrong at a scale this service
is not built for.

The trigger for revisiting is either of these, whichever comes first: the table
passes ten million rows, or storage becomes a visible line on the hosting bill.
Until then, a one-off cleanup needs no code, only a statement:

```sql
delete from click_events where occurred_at < now() - interval '1 year';
```

A privacy-driven retention limit is a different question with a different
answer, and it is not open here: the only visitor-identifying value stored is a
salted hash that exists to be counted, never to be resolved back to a person.

## Resolved: the salt is not rotated on a schedule

**Resolved.** `IP_HASH_SALT` is rotated only when it is believed to have been
disclosed. There is no calendar.

The effect of rotation was already settled: unique-visitor counts reset, because
the same visitor hashes to a new value afterwards. Rotating on a schedule
therefore buys a small, steady reduction in the value of a hash nobody can
reverse without also knowing the salt, and pays for it by corrupting the one
metric the hash exists to produce, at every rotation, forever.

Rotation is recorded without adding a table. On startup the service logs the
salt's **fingerprint**, the first eight hex characters of
`sha256(IP_HASH_SALT)`, alongside the other startup fields. A discontinuity in
unique-visitor numbers is then explainable by comparing the fingerprint in the
logs before and after: the same fingerprint means the salt did not change and
the drop is real traffic.

The salt itself is never logged, never returned by any endpoint, and never
included in an error message. The fingerprint is a one-way digest of it and
discloses nothing that helps an attacker who does not already have it.

## Resolved: obvious bots are flagged, not dropped

**Resolved.** A click whose user agent matches a small list of well-known
automation markers is stored with `is_bot` set to true. It is never discarded.

Dropping the row destroys the evidence. A crawler wave and a collapse in real
traffic then look identical in the data, and there is no way to tell them apart
afterwards. Storing and flagging keeps both answers available.

The check is a case-insensitive substring match of the user agent against:
`bot`, `crawler`, `spider`, `preview`, `curl`, `wget`, `headless`. A missing
user agent is **not** treated as a bot, because plenty of ordinary clients send
none, and guessing here would quietly delete real traffic from the numbers.

This check is knowingly shallow. It catches honest automation, which announces
itself, and catches nothing that does not want to be caught. Scope excludes
anything more, and the numbers are presented as a lower bound in any case.

Statistics exclude bot rows from `total`, `uniqueVisitors`, the per-day series,
and top referrers. The count of excluded rows is returned separately as
`botClicks`, so the exclusion is visible rather than silent.

## Data Model

### Table: `click_events`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `bigint` | primary key, generated always as identity | Internal only, never exposed |
| `link_id` | `bigint` | not null, references `links (id)` on delete cascade | |
| `occurred_at` | `timestamptz` | not null, default `now()` | The redirect time |
| `referrer` | `text` | nullable | The `Referer` header, absent for direct traffic |
| `user_agent` | `text` | nullable | As sent |
| `ip_hash` | `text` | not null | Hex `sha256` of salt then IP |
| `is_bot` | `boolean` | not null, default `false` | |

Constraints and indexes:

- `check (char_length(referrer) <= 2048)`
- `check (char_length(user_agent) <= 512)`
- `check (char_length(ip_hash) = 64)`
- `create index click_events_link_id_occurred_at_idx on click_events (link_id, occurred_at desc)`

`referrer` and `user_agent` are attacker-controlled headers of unbounded length.
The service **truncates** both to the lengths above before inserting, and the
check constraints are a backstop rather than the enforcement point. A constraint
violation on a fire-and-forget insert loses the click silently, so the
application must never let one happen; the constraint exists to catch a future
write path that forgets.

Both columns are nullable, because both headers are routinely absent. Absent is
stored as null, never as an empty string, so "no referrer" is one value rather
than two.

`ip_hash` is `sha256` over the salt followed by the resolved client IP, hex
encoded, giving a fixed 64 characters. Salt first is deliberate: appending a
secret to attacker-controlled input is the length-extension shape, and while it
is harmless for this use, writing it the safe way costs nothing. The hash is
computed with `node:crypto`, which adds no dependency.

`link_id` is `bigint` and arrives from `pg` as a string, like `links.id`. The
cascade is what makes a link deletion irreversible for its history, which is
recorded in `SPEC-links.md` as a reason the unauthenticated delete route must
stay closed.

## Endpoints

Both endpoints sit under `/api/links/:slug/`. They are four segments long, and
the router matches only when the segment count is equal, so neither the
single-segment `/:slug` redirect nor the three-segment `/api/links/:slug` can
answer them, whatever order they are registered in. A literal segment following
a parameter is expressible, and the specificity ordering compares position by
position, so no ambiguity arises. See Route precedence rule in `SPEC.md`.

Both return `401` `UNAUTHENTICATED` without a session, `404` `LINK_NOT_FOUND`
for an unknown slug, and `403` `FORBIDDEN` for a link owned by someone else or
by nobody.

### `GET /api/links/:slug/stats`

Query parameters:

- `days`, optional, an integer between 1 and 90, defaulting to 30. Outside that
  range or unparseable returns `400` with code `VALIDATION_FAILED` and a
  field-level detail, through `AppError.validation`, which is what the existing
  `limit` parameter on `GET /api/links` already uses.

Response `200`:

```json
{
  "slug": "aB3xK9p",
  "windowDays": 30,
  "total": 42,
  "uniqueVisitors": 17,
  "botClicks": 5,
  "byDay": [
    { "date": "2026-08-11", "clicks": 0 },
    { "date": "2026-08-12", "clicks": 3 }
  ]
}
```

- `total`, `uniqueVisitors`, and `byDay` all cover the same window and all
  exclude bot rows.
- `botClicks` is the number of rows excluded from that window.
- `byDay` is dense: every UTC day in the window appears exactly once, in
  ascending order, with `clicks` zero where there were none. `date` is the UTC
  calendar day as `YYYY-MM-DD`.
- Every number is a **lower bound**. Click writes are not awaited, so a crash or
  a restart between the response and the insert drops the event. Any interface
  that displays these figures says so.

### `GET /api/links/:slug/referrers`

Query parameters:

- `days`, as above.
- `limit`, optional, an integer between 1 and 50, defaulting to 10.

Response `200`:

```json
{
  "slug": "aB3xK9p",
  "windowDays": 30,
  "referrers": [
    { "referrer": "https://news.example.com/", "clicks": 12 },
    { "referrer": null, "clicks": 9 }
  ]
}
```

Ordered by `clicks` descending, then by `referrer` ascending so that ties are
stable across calls rather than left to the database. A null `referrer` means
direct traffic and is returned as `null` rather than as a made-up label, because
a site could otherwise name itself "direct" and become indistinguishable from
it. Bot rows are excluded.

The stored referrer is the header as sent, truncated. It is never fetched,
resolved, or rendered as a link by this service. Anything that displays it is
displaying attacker-controlled text and escapes it accordingly.

## Module Shape

`src/modules/analytics/` follows the same four-file shape as the other modules,
per Project Structure in `SPEC.md`:

- `analytics.schema.ts` — the click record and the statistics response types,
  and the `days` and `limit` parsers.
- `analytics.repository.ts` — the insert and the three aggregate queries.
  Converts counts with `Number()` at this boundary.
- `analytics.service.ts` — `recordClick()`, the pending-write set,
  `drainPendingWrites()`, the bot check, and the ownership check before every
  read.
- `analytics.routes.ts` — the two endpoints.

`recordClick()` is called from the redirect handler in `links.routes.ts`,
before the handler returns, so the write is registered before the response is
written. It returns `void` and cannot throw or reject, so the handler has no
promise to mishandle and the redirect cannot fail because of analytics.

`drainPendingWrites()` is exported for two callers and no others: the shutdown
sequence in `src/index.ts`, at step 3, and the integration tests.

## Verification

Unit tests:

- The bot check matches `bot`, `crawler`, `spider`, `preview`, `curl`, `wget`,
  and `headless` case-insensitively, and does not match an ordinary browser
  user agent.
- A missing user agent is not flagged as a bot.
- Referrer and user agent are truncated to 2048 and 512 characters before
  insert, so a longer header cannot violate the check constraint.
- The IP hash is 64 hex characters, and the same IP with two different salts
  produces two different hashes.
- The salt fingerprint is eight hex characters, and two different salts produce
  two different fingerprints. Asserting that the fingerprint is not a prefix of
  the salt would test a property of `sha256` rather than of this code; changing
  when the salt changes is the property the log line exists for.
- `days` parsing accepts 1 and 90, rejects 0, 91, a negative, and a
  non-integer.
- `limit` parsing accepts 1 and 50 and rejects 0 and 51.
- `drainPendingWrites()` resolves once for a set that grows while it is running,
  proving the loop-until-empty property rather than a single `Promise.all`.
- `drainPendingWrites()` resolves rather than rejecting when a tracked write
  rejects, proving the `.catch()` cannot escape.

Integration tests, each against a real server and a real database:

- Three redirects, then `drainPendingWrites()`, then the stats endpoint reports
  `total` of exactly 3. This is Checkpoint E.
- The click row records the destination link id, a non-null `ip_hash`, and the
  referrer sent with the request.
- A redirect with no `Referer` stores null, and the referrers endpoint returns
  that row with `referrer` null.
- Two redirects from one IP and one from another report `uniqueVisitors` of 2.
- A redirect with `User-Agent: curl/8.0` is stored, is excluded from `total`,
  and appears in `botClicks`.
- A redirect whose click insert fails still returns 302, and the failure is
  logged at error level. The redirect is the product and it survives the
  analytics database being unavailable.
- `byDay` over `days=7` returns exactly 7 entries in ascending order, with zeros
  on the days that had no clicks.
- `days=0` and `days=91` both return 400.
- The stats endpoint returns 401 without a session, 403 for another user's link,
  403 for an anonymous link, and 404 for an unknown slug. The same four for the
  referrers endpoint.
- Deleting a link removes its click events, proving the cascade. The stats
  endpoint then returns 404 for that slug.
- Shutdown drains, in order. The sequence lives in `src/shutdown.ts` and is
  called directly by `tests/integration/shutdown.test.ts`: a click write left
  outstanding is in the database after `performShutdown` returns, and a request
  that arrives while step 1 is still waiting also has its click recorded, which
  is the case a drain placed before step 1 would miss. A failing step returns
  exit code 1 rather than reporting a clean shutdown.
- The signal path itself is not reachable from the test suite on Windows, which
  does not deliver a real `SIGTERM`. It was verified in the container instead:
  `docker stop` sends `SIGTERM` to PID 1, the process logs `shutting down` and
  `shutdown complete` and exits 0, and five redirects issued immediately before
  the stop are all present in the database afterwards. Recorded under
  Checkpoint E in `tasks/todo.md`.

## Definition of Done

- Both endpoints are implemented and return the documented status codes.
- Every test listed under Verification passes, except the shutdown drain test,
  which is recorded as Linux-only.
- `npm run typecheck` passes with zero errors.
- Migration `004_create_click_events.sql` applies to an empty database and
  creates every constraint and the index listed in the data model.
- The redirect handler does not `await` the click write, and `recordClick()`
  returns `void` so no call site can leak an unhandled rejection.
- `drainPendingWrites()` is wired into shutdown at step 3, after in-flight
  requests and before the pool closes, with a 5 second deadline.
- No raw IP address is stored anywhere, and the salt is not logged.
- `package.json` still lists `pg` as the only production dependency.

## Risks

- **`TRUST_PROXY_HOPS` is `0` until the service is deployed.** Behind a proxy,
  the resolver then returns the proxy's address for every visitor, so every
  click hashes identically and `uniqueVisitors` reads 1 no matter how many
  people clicked. The number is wrong, not merely imprecise, until task C5 sets
  the correct hop count. Unique-visitor figures from before that point are not
  comparable with figures from after it.
- **Counts are a lower bound by design.** Lost writes are accepted, so these
  numbers must never be used where an exact figure matters, such as billing.
- **A link deletion destroys its history irreversibly**, through the cascade.
  There is no soft delete and no export.
