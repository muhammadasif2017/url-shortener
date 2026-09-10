# Task List: URL Shortener API

> **This is a build log, not current behaviour.** Every task below is finished.
> It is kept because the verification notes record what was found wrong along the
> way, which is the most useful part of it. For how the service behaves now, read
> `README.md`, `openapi.json`, and `docs/request-lifecycle.md`. For why it is
> built this way, read `docs/adr/`.

Ordered by dependency, not by importance. Work top to bottom.
Plan: `tasks/plan.md`. Specs: `SPEC.md` and the three module specs.

Rules for every task below:

- No task touches more than about five files.
- A task is done when its Verify step passes, not when the code looks right.
- `npm run typecheck` and `npm test` pass before every commit.

---

## Phase A — Foundation

- [x] **A1. Repository scaffold** — done
  - Acceptance: `package.json` with `"type": "module"` and every npm script from
    `SPEC.md`. `tsconfig.json` exactly as specified. `.nvmrc` pinned to
    `22.15.0`. `.env.example` listing every variable in the environment table.
  - Verify: `npm run typecheck` exits 0, and `node --experimental-strip-types
src/index.ts` runs.
  - Files: `package.json`, `tsconfig.json`, `.nvmrc`, `.env.example`,
    `src/index.ts`
  - Note: the original verify step said "exits 0 on an empty `src/`", which is
    impossible. `tsc` fails with `TS18003: No inputs were found in config file`
    when every `include` path is empty. A placeholder `src/index.ts` was added
    instead, which proves more: type checking, Node's runtime type stripping,
    and the npm scripts all work end to end. Task A11 replaces it.
  - Confirmed on this machine: TypeScript 5.9.3, and `erasableSyntaxOnly` really
    does reject `enum` with `TS1294`, so the constraint in `SPEC.md` is enforced
    rather than merely documented.

- [x] **A2. Slug generation and reserved words** — done
  - Acceptance: `generateSlug()` returns 7 base62 characters from
    `crypto.randomBytes`, rejecting bytes at or above 248.
    `isReservedSlug()` matches case-insensitively.
  - Verify: unit tests for length, alphabet, a roughly uniform distribution
    across many samples, and case-insensitive reserved matching.
  - Files: `src/lib/slug.ts`, `tests/unit/slug.test.ts`
  - Note: pure functions, no database and no HTTP. Build this first.
  - Verified: 8 tests pass. The distribution test uses a 10% tolerance, and a
    naive `byte % 62` was measured at 23.8% drift on this machine, so the test
    discriminates rather than passing vacuously.

- [x] **A3. Validation primitives and link input parsing** — done
  - Acceptance: shared narrowing helpers plus `parseCreateLinkInput`. URL rules
    from `SPEC-links.md`: parses, `http:` or `https:` only, has a host, 2048
    characters or fewer, and host does not match `BASE_URL`.
  - Verify: unit tests accepting http and https and rejecting `javascript:`,
    `data:`, `file:`, a missing host, an over-length URL, a past `expiresAt`, a
    malformed date, and a self-referential URL.
  - Files: `src/lib/validate.ts`, `src/modules/links/links.schema.ts`,
    `tests/unit/validate.test.ts`
  - Verified: 29 tests pass.
  - Design note: parsing returns a `ParseResult` and throws nothing, so one
    response reports every bad field instead of only the first. Converting a
    failed result into an HTTP response belongs to task A8.

- [x] **A4. Config and environment validation** — done
  - Acceptance: `env.ts` reads and validates every variable from the table in
    `SPEC.md`, and throws on startup when one is missing or malformed.
  - Verify: unit test asserting a missing required variable throws, and that
    defaults apply for optional ones.
  - Files: `src/config/env.ts`, `tests/unit/env.test.ts`
  - Verified: 12 tests pass.
  - Added beyond the acceptance criteria: `loadEnv` refuses to start when
    `ENABLE_UNAUTHENTICATED_LINK_ADMIN` is set while `NODE_ENV` is production.
    The flag exposes routes that let anyone enumerate every link and delete any
    of them, and a copied env file is exactly how such a flag reaches
    production. It also rejects the placeholder salt from `.env.example`.

- [x] **A5. Client IP resolver** — done
  - Acceptance: `TRUST_PROXY_HOPS` of 0 uses `socket.remoteAddress`; above 0
    counts from the right-hand end of `X-Forwarded-For`. Strips the
    IPv4-mapped IPv6 prefix, lowercases IPv6, returns `unknown` for undefined.
  - Verify: unit tests including a forged left-hand entry that must be ignored.
  - Files: `src/lib/clientIp.ts`, `tests/unit/clientIp.test.ts`
  - Verified: 16 tests pass, including a 20-entry forged header that must not
    reach past the single trusted entry.
  - Fixed during the task: the first version of the test helper collapsed an
    explicit `undefined` back to a default with `??`, so the destroyed-socket
    case silently tested nothing. The helper now checks key presence with `in`.

- [x] **A6. Router with precedence rules** — done
  - Acceptance: first-wins ordered matching, literal routes before parameter
    routes, segment count must match, `HEAD` matches `GET` entries, and a path
    that exists with a different method returns 405 with `Allow`.
  - Verify: unit tests proving `/health` and `/api/links` never match `/:slug`,
    that `HEAD /:slug` matches, and that 405 carries `Allow`.
  - Files: `src/http/router.ts`, `src/http/context.ts`,
    `tests/unit/router.test.ts`
  - Note: this is the single most likely source of subtle bugs in the project.
  - Verified: 22 tests pass. The test table registers `/:slug` FIRST on purpose,
    so a router that relied on registration order would fail every precedence
    test rather than passing by luck.
  - Added beyond the acceptance criteria: `createRouter` throws on two routes
    that could serve the same request, including two that differ only in
    parameter name such as `/api/links/:slug` and `/api/links/:id`. Without the
    check, the second handler is silently unreachable.

- [x] **A7. Body reader with a hard size limit** — done
  - Acceptance: streams the request body, rejects over 16 KB, rejects an
    oversized `Content-Length` up front, and calls `req.resume()` after
    responding so the response reaches the client cleanly.
  - Verify: unit test asserting the stream is destroyed after at most 16 KB.
  - Files: `src/http/readBody.ts`, `tests/unit/readBody.test.ts`
  - Verified: 16 tests pass. One counts the bytes actually pulled from the
    stream while feeding a megabyte in 64 KB chunks, which proves the limit
    stops reading rather than measuring after buffering.
  - Also covered: a lying `Content-Length` does not slip past, a malformed one
    falls back to streaming, and the limit counts bytes rather than characters,
    so a body of multi-byte characters cannot exceed it four times over.
  - Deviation: `req.resume()` after responding belongs to the server wiring in
    task A11, not here. This module destroys the stream instead, which is the
    correct action while the response has not yet been written.

- [x] **A8. Response helpers, errors, logger, cookies** — done
  - Acceptance: `json()`, `redirect()`, `noContent()`. `AppError` with code,
    message, and status. Error handler producing the one documented error shape.
    JSON logger to stdout. Cookie parse and serialise.
  - Verify: unit tests for the error shape, and for cookie parsing with several
    cookies in one header and a value containing `=`.
  - Files: `src/http/respond.ts`, `src/http/errorHandler.ts`,
    `src/http/cookies.ts`, `src/lib/AppError.ts`, `src/lib/logger.ts`,
    `tests/unit/http.test.ts`
  - Verified: 29 tests pass, 132 in the suite overall.
  - The rule the error handler enforces: an `AppError` was thrown deliberately
    and its message is meant for the caller. Anything else is a bug whose
    message may name an internal path or a connection string, so it is logged in
    full and answered with a generic 500. One test throws an error carrying a
    password in its message and asserts the password never reaches the response.
  - Cookie parsing splits on the FIRST `=` only. Splitting on every `=` would
    truncate base64 padding and JWT-shaped values, and the session would fail to
    authenticate with no error anywhere. A repeated cookie name keeps the first
    occurrence, so an injected duplicate cannot override a real session.
  - `serialiseCookie` percent-encodes the value, which also prevents a value
    containing `; Path=/admin` from inventing its own attributes.

- [x] **A9. Compose, including the test database** — done
  - Acceptance: Postgres 16 on host port 5433, plus an init script mounted at
    `/docker-entrypoint-initdb.d/` that runs `create database urlshortener_test`.
  - Verify: `npm run db:up`, then confirm both databases exist.
  - Files: `docker-compose.yml`, `docker/init/01-create-test-db.sql`
  - Note: without this, `migrate:test` fails with `3D000` and `npm test` cannot
    run at all.
  - Verified: both `urlshortener` and `urlshortener_test` exist after
    `npm run db:up`.
  - Added: a health check on the container. The migration runner and the test
    suite both connect immediately after `db:up`, and without it they race the
    server's startup on a cold machine.

- [x] **A10. Pool, migration runner, first migration** — done
  - Acceptance: runner applies numbered SQL files in order, records each in a
    migrations table, wraps each file in a transaction, and is idempotent.
    `001_create_links.sql` creates the table with every constraint from
    `SPEC-links.md`.
  - Verify: `npm run migrate` twice; the second run applies nothing. Confirm
    every CHECK constraint exists.
  - Files: `src/db/pool.ts`, `src/db/withTransaction.ts`, `scripts/migrate.ts`,
    `migrations/001_create_links.sql`
  - Verified: applied to both databases, second run reports "No pending
    migrations", and all six constraints exist. Each was then exercised
    directly in psql: a two-character slug raises `links_slug_length`, a slug
    containing a dot raises `links_slug_charset`, and a duplicate raises
    `links_slug_unique` with SQLSTATE 23505.
  - Added: an advisory lock around the run, so two deploys starting at once
    cannot both apply the same file. Each file commits together with its own
    bookkeeping row, so the record and the schema cannot disagree.

- [x] **A11. Server, entry point, health check** — done
  - Acceptance: `server.ts` builds the server without listening. `index.ts`
    listens and wires shutdown. `/health` runs `select 1` with a 2 second
    timeout, returning 200 or 503.
  - Verify: integration test asserting 200 with `database: "ok"`.
  - Files: `src/server.ts`, `src/index.ts`, `tests/helpers/server.ts`,
    `tests/integration/health.test.ts`
  - Verified: 11 integration tests pass against the real test database, and the
    real entry point was smoke tested separately, returning
    `{"status":"ok","database":"ok"}` on port 3000.
  - **Real bug found and fixed here.** The body reader destroyed the request
    stream when the size limit was exceeded. That kills the socket while the
    client is still uploading, so the client reports `fetch failed` instead of
    reading the 413. The cause was subtler than it looked: leaving a
    `for await` loop early calls `return()` on the iterator, which destroys the
    stream on its own. The loop now uses an explicit iterator and simply stops
    calling `next()`, leaving the stream paused; the server writes the response
    and then drains the remainder.
  - This is the flake the specification review predicted but could not verify
    without code. It also confirmed the reviewer's warning that a 20 KB test
    passes by accident of size: 20 KB fits in socket buffers. A second test at
    2 MB now guards the regression.

**Checkpoint A — PASSED.** Server starts. `/health` returns 200 with
`database: "ok"`. 144 tests pass, 133 unit and 11 integration.
`npm run typecheck` is clean. `pg` is still the only production dependency.

---

## Phase B — links module

- [x] **B1. `POST /api/links`** — done
  - Acceptance: 201 with slug, `shortUrl`, url, `expiresAt`, `createdAt`.
    Custom slug honoured. Reserved slug returns 400. Duplicate returns 409 via
    SQLSTATE `23505`. Generated-slug collisions retry five times, then 503 with
    `Retry-After`. `links.id` stays a string.
  - Verify: integration tests for 201, custom slug, 400 reserved, 409 duplicate,
    400 for a `javascript:` URL, and 413 for a 20 KB body.
  - Files: `links.routes.ts`, `links.service.ts`, `links.repository.ts`,
    `links.schema.ts`, `tests/integration/links.test.ts`
  - Verified: 14 integration tests. Includes one proving a duplicate surfaces as
    409 rather than 500, one proving a reserved slug is 400 rather than 409, and
    one proving a failed validation stores nothing.
  - `isSlugConflict` checks the constraint name as well as SQLSTATE 23505. Once
    identity adds `unique (email)`, a bare code check would report a duplicate
    email as a slug collision.
  - The internal id is never exposed. A sequential id would tell any caller how
    many links exist and let them walk the whole table.

- [x] **B2. `GET` and `HEAD /:slug`** — done
  - Acceptance: 302 with `Location` and `Cache-Control: no-store`. 404 unknown,
    410 expired, expiry evaluated in SQL against `now()`. `HEAD` returns the
    same status and headers with no body. Not rate limited.
  - Verify: integration tests using `redirect: 'manual'` for 302, 404, 410, and
    a `HEAD` request asserting an empty body.
  - Verified: 9 tests, including case-sensitive slug matching, `Cache-Control:
no-store`, and two proving the catch-all does not swallow `/health` or
    `/api/links`.

- [x] **B3. `GET /api/links/:slug`** — done
  - Acceptance: 200 with metadata, 404 otherwise. An expired link is still
    returned here with its past `expiresAt`.
  - Verify: integration test confirming the same slug gives 410 on the redirect
    route and 200 here.
  - Verified: 3 tests. The expired-link case asserts both routes in one test, so
    the distinction cannot silently collapse.

- [x] **B4. `GET /api/links` with keyset pagination** — done
  - Acceptance: `limit` 1 to 100 defaulting to 20, cursor is base64url of the
    last `id`, `where id < $1 order by id desc`. Malformed cursor returns 400.
    Route gated behind `ENABLE_UNAUTHENTICATED_LINK_ADMIN`.
  - Verify: integration test paging five links with `limit=2`, asserting no
    duplicates and no missing rows, and a null `nextCursor` on the last page.
    Second test: route returns 404 without the flag.
  - Verified: 5 tests. Pagination walks all three pages and asserts the exact
    sequence, so a skipped or repeated row fails rather than passing quietly.
  - The flag-off case was verified by smoke test rather than by an automated
    test: the configuration is read once per process, so toggling it needs a
    separate process. Task C4 adds that test properly.
  - Listing asks for `limit + 1` rows to learn whether another page exists. A
    separate count query would be a second round trip that could disagree with
    the first.

- [x] **B5. `DELETE /api/links/:slug`** — done
  - Acceptance: 204 when deleted, 404 otherwise. Gated behind the same flag.
  - Verify: integration test for 204, then 404 on both routes; and 404 for the
    route itself without the flag.
  - Verified: 2 tests, plus the same smoke test as B4 for the flag-off case.

**Checkpoint B — PASSED, with one item deferred.** 178 tests pass, 133 unit and
45 integration. `pg` is still the only production dependency.

Deferred to Phase C by design: the rate-limiting verification items, since the
limiter does not exist yet. Everything else in `SPEC-links.md` is covered.

Verified during this phase and worth carrying forward:

- Integration tests now run with `--test-concurrency=1`. Node runs test files in
  parallel processes by default, and two files truncating the same table
  interfered with each other, producing failures that looked like routing bugs.
- The production entry point mounts `linkRoutes` explicitly. Until that was
  wired, every endpoint existed and passed its tests while being unreachable in
  the real server.

---

## Phase C — Hardening and deployment

- [x] **C1. Rate limiting** — done
  - Acceptance: fixed window keyed by resolved client IP. Defaults 60 per 60
    seconds. `GET /:slug` exempt. 429 in the standard error shape with
    `Retry-After`. Sweep expired entries on write, hard cap 10,000.
  - Verify: integration test exceeding the limit on `POST /api/links` and
    confirming `GET /:slug` still works. Unit test proving the map is capped.
  - Verified: 13 tests. The eviction test sends 500 distinct keys at a cap of
    50 and asserts the map never exceeds it, which is the memory-exhaustion
    vector the cap exists to close.
  - The limiter is injectable through `createAppServer`. A process-wide limit
    low enough to test made every other integration file trip it, and those
    failures looked like endpoint bugs rather than a shared counter.
  - `/health` is exempt as well as `/:slug`. A platform polls the health check
    far more often than any human uses the API, and a rate-limited health check
    reports the service as unhealthy under its own monitoring.

- [x] **C2. Timeouts and graceful shutdown** — implemented, partly verified
  - Acceptance: `headersTimeout` 10s, `requestTimeout` 20s,
    `keepAliveTimeout` 5s. On `SIGTERM`: stop accepting, await in-flight, drain,
    close pool, exit, every step bounded.
  - Verify: send `SIGTERM` during an in-flight request and confirm it completes
    before exit.
  - Implemented in task A11: `headersTimeout` 10s, `requestTimeout` 20s,
    `keepAliveTimeout` 5s, and a shutdown sequence that stops accepting, waits
    for in-flight requests, then closes the pool, with every step bounded.
  - **Not verified on this machine.** Windows has no real `SIGTERM`:
    `process.kill(pid, "SIGTERM")` terminates the process immediately rather
    than delivering a signal, so the graceful path cannot be exercised here.
    The Dockerfile uses exec form so the process is PID 1 and receives the
    signal directly on Linux. Verify there before relying on it.

- [x] **C3. Dockerfile** — done
  - Acceptance: `node:22.15-alpine`, `npm ci --omit=dev`, non-root `node` user,
    `NODE_ENV=production`, `HEALTHCHECK` hitting `/health`, and a `CMD` using
    `--env-file-if-exists`.
  - Verify: build the image, run it against the Compose database, and confirm
    Docker reports the container healthy.
  - Verified: image builds, runs as the `node` user, `/health` returns 200 with
    `database: "ok"`, a link is created and redirects to the right destination,
    the admin listing returns 404, and Docker reports the container `healthy`.
  - **Real bug found here.** Database TLS was tied to `NODE_ENV=production`, so
    the production image demanded TLS from a local Postgres that offers none and
    the health check reported the database as down. TLS now has its own setting,
    `DATABASE_SSL`, defaulting to on in production. Tying a transport decision
    to an environment name made the production image impossible to test locally.
  - The health check runs `node -e` with `fetch` rather than curl. Neither curl
    nor wget is in the image, and adding one would be a larger attack surface
    than the check is worth.
  - A `.dockerignore` keeps `.env` out of the image. Copying it in would ship
    real credentials wherever the image goes.

- [x] **C4. BLOCKING GATE — close the unauthenticated admin routes** — done
  - Acceptance: `ENABLE_UNAUTHENTICATED_LINK_ADMIN` is unset in every deployed
    environment, so `GET /api/links` and `DELETE /api/links/:slug` both return
    404 there.
  - Verify: against the deployed URL, both routes return 404.
  - Note: this is not a checklist formality. Without it, anyone can enumerate
    every link and delete any of them.
  - Verified by automated test, not by inspection. `tests/integration/process.test.ts`
    starts the real entry point in a child process with the flag absent and
    asserts both routes return 404 while link creation and redirection still
    work. Configuration is cached per process, so this could not be tested
    in-process, which is why B4 left it as a smoke check.
  - Two further startup tests: the service refuses to start in production with
    the flag set, and refuses to start with required variables missing, naming
    every missing variable at once.

- [ ] **C5. Deploy** — NOT DOING, decided 2026-09-09
  - Acceptance: Render service on the Docker runtime, Render PostgreSQL with TLS
    enabled in the pool config, migrations as a pre-deploy command,
    `TRUST_PROXY_HOPS` set correctly, database expiry date recorded.
  - Verify: create a link and follow it on the public URL. Confirm two different
    clients land in two different rate-limit buckets.
  - **Decision: not deploying.** The owner chose local development and testing
    only. Render's free PostgreSQL expires after 90 days and the free web tier
    cold-starts after idling, and neither cost is worth paying for a project
    whose stated goal is learning backend engineering rather than serving
    traffic.
  - What this leaves unmet, so nobody reads the project as finished when it is
    not: success criterion 19 in `SPEC.md`, which is the only one that requires
    a public URL. Criteria 1 to 18 all hold locally.
  - `TRUST_PROXY_HOPS` stays `0`, which is correct with no proxy in front of the
    service. It also means the proxy-related distortion recorded under Risks in
    `SPEC-analytics.md` never arises locally: with no proxy, the socket address
    is the client, so unique-visitor counts are real rather than collapsed.
  - Nothing was built for the deploy that is now wasted. The Dockerfile, the
    `DATABASE_SSL` setting, the pre-deploy migration command, and the container
    `SIGTERM` verification all earn their place in local use.
  - Reversible. Everything the deploy needs is in the repository, so this task
    can be reopened later without rework.

**Checkpoint C — passed except deployment.** 200 tests pass. The image builds,
runs as a non-root user, and reports healthy. Both admin routes are closed and
proven closed by an automated test.

Outstanding, and neither can be done from here:

1. **Deployment needs your Render account.** Creating the service, provisioning
   the database, and setting the environment variables all require credentials
   nobody should paste into a session. Everything the deploy depends on is
   ready: the Dockerfile, the pre-deploy migration command, and `DATABASE_SSL`.
2. **`TRUST_PROXY_HOPS` cannot be set correctly until the service is deployed.**
   The right value depends on how many proxies the platform actually puts in
   front of it, which is only observable from there. Until then it stays `0`,
   and while it is wrong the rate limiter treats every visitor as one client.

---

## Phase D — identity module

- [x] **D1. Complete `SPEC-identity.md`** — done
  - All three open questions resolved, with reasoning recorded in the spec:
    session lifetime is absolute rather than sliding, anonymous link creation
    survives, and email addresses are never verified.
  - A sliding expiry was rejected because it turns every authenticated request
    into a write, and because it keeps a stolen session alive for as long as the
    thief keeps using it.

- [x] **D2. `users` and `sessions` tables** — migration `002`
  - Constraints enforce what the application also checks: the email is unique,
    lowercase, and shaped like an address; a session id has a plausible length;
    and an expiry must follow creation.
  - `sessions_user_id_idx` exists so the delete cascade, and a future "sign out
    everywhere", stay fast.

- [x] **D3. `scrypt` hashing** — done
  - `N=32768, r=8, p=1`, 32-byte key, 16-byte salt, `maxmem` raised to 64 MiB.
  - **Real vulnerability found and fixed here.** `timingSafeEqual` on two
    zero-length buffers returns `true`, so a stored hash of `scrypt$N=...$$`
    would have authenticated any password for that account. The parser now
    rejects an implausibly short salt or digest. There is a test for it.
  - Absurd stored parameters are also rejected, so a poisoned row cannot turn
    one sign-in attempt into a denial of service.
  - Async `scrypt` only, never `scryptSync`, which would block the single event
    loop for about a tenth of a second per attempt.
  - `promisify(scrypt)` needed an explicit type: it resolves to the overload
    without options, so the cost parameters would not type-check.

- [x] **D4. Register, login, logout, current user** — done
  - Verified: 24 integration tests.
  - Sign-in verifies a password even when no user was found, against a dummy
    hash built once at startup. Skipping that work makes the response measurably
    faster for unregistered addresses, which turns the endpoint into an account
    enumeration oracle answering by timing alone.
  - A malformed login body returns 401, not 400. A validation error there would
    confirm an address exists, or reveal the password policy to someone guessing.
  - The cookie name is environment-dependent: `__Host-session` in production,
    `session` locally, because the prefix requires `Secure` and `Secure` cookies
    are not stored over plain HTTP.
  - One test asserts the response body contains neither the password, nor the
    string `scrypt`, nor the word `hash`.

- [x] **D5. Content-type guard** — done
  - 415 on state-changing routes when the media type is not `application/json`.
  - The media type is parsed rather than compared as a string, so
    `application/json; charset=utf-8` is accepted. A missing header is rejected.
  - Both cases have tests.

- [x] **D6. `owner_id` on `links`** — migration `003`
  - Nullable permanently, not transitionally, because anonymous creation
    survives and keeps producing ownerless rows.
  - `links_owner_id_idx` on `(owner_id, id desc)` matches the listing query
    exactly, so the database walks the index backwards instead of scanning every
    link ever stored.

- [x] **D7. Authorisation** — done
  - Listing is scoped to the owner. There is no repository query that returns
    every link regardless of owner, and that absence is the point: an endpoint
    cannot leak other people's links if the query to do so does not exist.
  - Deletion reads the row first, which costs one query and buys the difference
    between 404 and 403. A single delete with an owner filter would make every
    failure look like "no such link".
  - An ownerless link cannot be deleted by anyone. Nobody can prove they created
    it, so there is no correct person to allow.
  - `ENABLE_UNAUTHENTICATED_LINK_ADMIN` is removed entirely, not left switched
    off. A flag that can be switched back on eventually is.
  - Verified: cross-user deletion returns 403 and the link survives; the
    anonymous link is refused; listing shows only the caller's own links, with an
    ownerless link present in the table and absent from the results.

- [x] **D8. Stricter rate limit on sign-in and registration** — done
  - Ten attempts per fifteen minutes, against sixty per minute elsewhere.
  - This is not politeness. Each attempt runs `scrypt`, costing about 33 MiB and
    a tenth of a second of thread-pool work, so the general limit would let one
    address spend six seconds of hashing per minute on a service with a single
    event loop. It also slows credential stuffing from thousands of guesses an
    hour to forty.
  - Sign-out and the current-user route are exempt: neither hashes anything, and
    throttling sign-out would leave someone unable to end their own session.

**Checkpoint D — PASSED.** 237 tests pass, 173 unit and 64 integration. `pg` is
still the only production dependency.

The one item narrowed rather than dropped: sign-out is proven to delete the row
and invalidate the cookie, and the clearing cookie is asserted to carry `Path=/`
and `Max-Age=0`. Issuing the follow-up request from a different path was the
original plan, but `fetch` sends a cookie the test supplies regardless of path,
so asserting the attributes is what actually catches a mis-scoped deletion.

---

## Phase E — analytics module

- [x] **E1. Complete `SPEC-analytics.md`** — done
  - Acceptance: the file is no longer a placeholder. Objective and Scope are
    final rather than provisional, the three open questions are resolved with
    their reasoning recorded, and the data model, endpoints, verification list,
    and definition of done exist for E2 to E6 to build against.
  - Verify: `SPEC-analytics.md` has the same sections as its two siblings, and
    every task from E2 to E6 has something in it to implement.
  - **Aggregation is SQL, pinned to UTC, bounded, and dense.** `date_trunc`
    with a `group by`, because counting raw rows in JavaScript transfers the
    whole history to produce a few numbers and gets slower as a link gets more
    popular. The zone is written into the query as
    `date_trunc('day', occurred_at at time zone 'UTC')` rather than inherited
    from the server's `TimeZone`, which the Compose database and the deployed
    database can set differently — the same mistake as tying database TLS to
    `NODE_ENV` in C3. The window is a `days` parameter, 1 to 90, default 30,
    because an unbounded breakdown grows a row per day forever. Days with no
    clicks come back as zeros, because a sparse series makes every consumer
    rebuild the calendar and makes a gap read as continuity.
  - One index, `(link_id, occurred_at desc)`, serves all four queries. What is
    deliberately not indexed is written down with the reason: `referrer`,
    `ip_hash`, and `is_bot`.
  - **Retention: none, until a link is deleted.** Scope already rejected a
    scheduled rollup job because a scheduler is a whole subsystem to add before
    it is needed, and that reasoning covers scheduled deletion unchanged. The
    cost is recorded, and so is the trigger for revisiting: ten million rows,
    or storage becoming a visible line on the bill.
  - **Salt rotation: no schedule.** Rotate only on suspected disclosure.
    Rotating on a calendar corrupts unique-visitor counts at every rotation to
    reduce the value of a hash nobody can reverse without the salt. Rotations
    are made explainable without a new table: the service logs the salt's
    fingerprint, the first eight hex characters of `sha256(IP_HASH_SALT)`, at
    startup. The salt itself is never logged.
  - **Gap found while writing this, and closed.** The three open questions did
    not mention authorisation, and nothing in the spec said who may read a
    link's statistics. Answering on the slug alone would have handed every
    link's click history to anyone who can guess a slug, which is the same
    disclosure class as the admin routes C4 closed. Statistics are now
    owner-only and reuse the exact rule `deleteLink` implements: 404 for an
    unknown slug, 403 for someone else's link or an ownerless one, 401 with no
    session.
  - Three smaller gaps closed at the same time. The user-agent bot check that
    Scope keeps in scope is now defined, and a bot click is stored and flagged
    rather than dropped, because dropping it makes a crawler wave and a
    collapse in real traffic look identical afterwards. Referrer and user agent
    are nullable with length checks, and the service truncates before insert,
    because a constraint violation on a fire-and-forget insert loses the click
    in silence. The IP hash had no reader — unique visitors are now reported by
    the stats endpoint, so the one reason the hash exists is served.
  - Two claims in the draft were checked against the code rather than assumed.
    The router does express a literal segment after a parameter and matches only
    on an equal segment count, so the four-segment stats paths cannot collide
    with `/:slug` or with `/api/links/:slug`. The error code for a bad `days`
    value is `VALIDATION_FAILED`, through the existing `AppError.validation`,
    not a new code invented for this module.
  - Recorded under Risks: while `TRUST_PROXY_HOPS` is `0`, every visitor hashes
    identically behind a proxy and `uniqueVisitors` reads 1. That number is
    wrong rather than imprecise until C5 deploys and sets the hop count.
- [x] **E2. `click_events` table** — migration `004`, cascade on link delete
  - Acceptance: `004_create_click_events.sql` applies to both databases and
    creates every column, constraint, and the one index listed in the data
    model in `SPEC-analytics.md`.
  - Verify: apply it, then read the constraints back out of `pg_constraint` and
    the index out of `pg_indexes`, and prove each constraint actually rejects
    the value it exists to reject.
  - Verified against the live schema rather than by reading the file back.
    Applied to the development and test databases, `migrate:status` lists all
    four migrations, and `pg_constraint` reports the primary key, the cascading
    foreign key, and the three check constraints. `pg_indexes` reports
    `click_events_link_id_occurred_at_idx` on `(link_id, occurred_at desc)`.
  - Each constraint was exercised, not just inspected. A 3-character `ip_hash`,
    a 2049-character referrer, and a 513-character user agent are each rejected
    with SQLSTATE `23514`; a `link_id` that does not exist is rejected with
    `23503`. Deleting the parent link removed its click row, so the cascade
    works rather than merely being declared.
  - `referrer` and `user_agent` are nullable and default to nothing, so an
    absent header stores as null instead of an empty string. `occurred_at`
    defaults to `now()` and `is_bot` to `false`, both confirmed from
    `information_schema.columns`.
  - The length checks are backstops, not the enforcement point. The service
    truncates before inserting, because the insert is fire-and-forget: a
    constraint violation there loses the click in silence rather than
    surfacing. The comment in the migration says so, so a later reader does not
    mistake the constraint for the whole rule.
  - No new SQLSTATE handling is needed in `links`, and the first reason written
    here was wrong. A foreign-key violation is `23503`, a different code from
    the `23505` the collision check looks at, so it could never have been
    misread as a slug collision. The real reason is narrower: nothing in the
    links repository writes to `click_events`, so `23503` never reaches those
    paths at all. The helper is `isSlugConflict` in
    `src/modules/links/links.repository.ts`, not `isUniqueViolation`, and it
    does check `error.constraint === 'links_slug_unique'` alongside the code,
    which is what keeps a duplicate email from being answered with 409
    `SLUG_TAKEN`.
  - Test cleanup already covers the new table. `truncateLinks` in
    `tests/helpers/db.ts` runs `truncate table links restart identity cascade`,
    and `cascade` extends to every table with a foreign key into `links`, so
    click rows cannot leak between test files once E3 starts writing them.
    Checkpoint E asserts a count, so that mattered enough to check now rather
    than discover as a flaky failure later.
  - 237 tests still pass and `npm run typecheck` is clean. Nothing reads or
    writes this table yet; that is E3.
- [x] **E3. Fire-and-forget writer** — done
  - Acceptance: a redirect writes one click row without the handler awaiting it,
    the write is registered before the response is written, a failed insert
    cannot reach the process as an unhandled rejection, and
    `drainPendingWrites()` is deterministic for tests.
  - Verify: redirect three times, drain, count three rows. Force an insert
    failure and confirm the process survives and the redirect still answers.
  - Verified: 272 tests pass, 35 of them new, and `npm run typecheck` is clean.
  - **`RequestContext` had no client IP, which blocked the whole task.** The
    resolver was called inside the rate-limiting branch in `server.ts`, and a
    route handler cannot reach the socket by design. The address is now resolved
    once per request, above that branch, and passed on the context, with the
    limiter reading the same value. Resolving it twice is how two features that
    must agree on who a caller is start disagreeing, which is the exact failure
    the single-resolver rule exists to prevent.
  - **Deviation from the spec as written, and the spec was updated to match.**
    E1 said the redirect handler attaches the mandatory `.catch()` at the call
    site. `recordClick()` now returns `void` and catches internally instead. A
    rule that every call site must remember is a rule that one call site will
    eventually forget, and forgetting it takes the process down. Returning
    `void` removes the failure mode rather than documenting it.
  - The tracker stores the already-caught promise, not the original. Registering
    the raw promise and catching a separate reference would leave the drain
    awaiting a rejecting promise, so one failed insert would fail the entire
    shutdown. `createWriteTracker()` is exported as a factory so both mandatory
    properties are unit tested without a database: a rejecting write still
    drains cleanly, and a write registered while the drain is already running is
    still waited for, which is what proves the loop is not a snapshot.
  - Hashing lives in `src/lib/ipHash.ts` and takes the salt as an argument
    rather than reading configuration, so the unit tests need no environment.
    Salt first, then the address, because appending a secret to attacker-supplied
    input is the length-extension shape and writing it the safe way costs
    nothing.
  - `UNKNOWN_CLIENT_IP` is hashed like any other value, so every unresolvable
    visitor shares one digest and counts as one visitor. That is the same
    distortion `TRUST_PROXY_HOPS` already causes and it is now stated in the
    code rather than left implicit. `ip_hash` is `not null`, so storing null was
    never an option.
  - Truncation happens before the insert, and the integration test proves it: a
    4000-character referrer produces a stored row of exactly 2048 characters
    instead of a constraint violation that would lose the click silently.
  - The salt fingerprint is logged at startup as `ipHashSalt`, eight hex
    characters of `sha256(IP_HASH_SALT)`. The salt itself is never logged. A
    unit test asserts the fingerprint changes when the salt changes, rather than
    asserting it is not a prefix of the salt, which would have tested a property
    of `sha256` instead of this code.
  - One integration test was written and then deleted rather than left in. It
    claimed to prove the write is registered before the response is answered,
    but the only assertion it could make deterministically was
    `pendingWriteCount() >= 0`, which is true of everything. The ordering
    property is structural, since `recordClick()` is synchronous, and the
    tracker's behaviour is unit tested directly.
  - **The pending set was unbounded, and now is not.** The redirect route is
    exempt from rate limiting on purpose, so it is the one path where
    unauthenticated traffic can grow something without limit, and it now starts
    a database write per hit against a pool of ten connections. The cap is
    10,000 outstanding writes, the same number and the same reasoning as the
    rate limiter's entry cap in C1. Above it a click is dropped rather than
    queued, which point 2 of the fire-and-forget decision already permits.
  - The tracker takes a function rather than a promise, so a refused write is
    never started. Taking a promise and discarding it would still have issued
    the insert, which is exactly the load the cap exists to shed. A unit test
    asserts the third write of a limit-2 tracker neither runs nor is stored.
  - Shedding logs on the edges, not per click: once when it starts, once when
    the backlog clears, with the number dropped. A service already failing to
    keep up with its writes does not need a log line per request on top.
  - `npm run test:unit` was run on its own as well as through `npm test`. It has
    no `--env-file`, so a unit test that reached configuration would fail there
    and pass in the full run. It passes: 184 tests.
  - Not done here: the shutdown wiring is E4, and the comment marking that step
    is left in place in `src/index.ts`. E4 later moved the sequence into
    `src/shutdown.ts`, so that line reference no longer resolves. E4 needs its own 5 second
    constant rather than reusing `DRAIN_TIMEOUT_MS`, which is 10 seconds and
    belongs to the in-flight request wait.
- [x] **E4. Wire the drain into shutdown** in the correct order — done
  - Acceptance: on `SIGTERM` the order is stop accepting, wait for in-flight
    requests, drain click writes, close the pool, exit, with every step bounded.
  - Verify: a click write left outstanding is in the database after the sequence
    returns, and a request that arrives while step 1 is still waiting also has
    its click recorded.
  - Verified: 276 tests pass, 3 of them new, and `npm run typecheck` is clean.
  - **The sequence moved to `src/shutdown.ts` so it could be tested at all.** It
    was inside `src/index.ts`, which calls `main()` on import and would start a
    listener in any test that imported it. `performShutdown` now returns an exit
    code instead of calling `process.exit`, and the entry point exits on what it
    returns. That one change is what makes the ordering assertable.
  - The click drain has its own constant, `CLICK_DRAIN_TIMEOUT_MS` at 5 seconds,
    rather than reusing the 10 second request wait. The two are not the same
    kind of wait: a request still running has a caller waiting for an answer, a
    click write has nobody, and losing one is already accepted.
  - The second test proves a narrower property than its first name claimed, and
    it was renamed to match. It issues a redirect after the sequence has begun,
    so the click write is registered late and is still drained, which is the
    loop-until-empty property at shutdown scope. It does **not** prove step 1
    waits for that request: the stand-in server and the listener serving the
    request are separate objects, so the sequencing comes from the test body
    rather than from the code. Only the container on Linux can show that.
  - Two defects found in review after the first commit and fixed. The shedding
    recovery log used a second drain over the same tracker, which resolves at
    the same moment the shutdown drain does, so a shedding service would have
    logged "recovered" while its pool was closing. Recovery is now reported on
    the first write accepted after an episode, which is the event it actually
    describes. And `process.once` per signal does not prevent a concurrent
    shutdown, because `SIGTERM` and `SIGINT` are separate registrations: one
    flag now guards both, so a second signal cannot start a second sequence
    racing the pool close.
  - A failing step returns exit code 1. Without that a broken shutdown exits 0
    and looks exactly like a clean one.
  - **What is still not verified here.** The signal handler itself. Windows does
    not deliver a real `SIGTERM`, so a test can reach the sequence but not the
    path from the signal to it. That wiring is two lines in `src/index.ts` and
    the container runs the process as PID 1 with exec form, so it receives the
    signal directly on Linux. Verify there, alongside the C2 note.
- [x] **E5. Stats endpoint** — done
  - Acceptance: `GET /api/links/:slug/stats` returns a total, unique visitors,
    bot clicks, and a dense per-day series, owner-only, over a `days` window of
    1 to 90 defaulting to 30, with every count a number.
  - Verify: three redirects then drain then the endpoint reports a total of 3.
    401 with no session, 403 for another user's link and for an ownerless one,
    404 for an unknown slug.
  - Verified: 291 tests pass, 15 of them new, and `npm run typecheck` is clean.
  - **Checkpoint E is met through the endpoint, not only through the database.**
    The count-equals-redirects assertion now runs against the HTTP response.
  - Authorisation reuses `linkService.getLink` and then compares `ownerId`,
    which is `deleteLink`'s rule rather than a second one. A slug appears in
    browser history, referrer headers, and every chat log the link passes
    through, so it is public by construction and cannot also be the credential
    that guards click history.
  - The window is computed by the database from `now()`, never passed in as an
    instant from the application, so one clock decides what today means and it
    is the clock the rows were written with.
  - `WINDOW_START` converts the day boundary back to `timestamptz` so that
    `occurred_at` itself is never wrapped in a function. Comparing
    `occurred_at at time zone 'UTC'` would have been correct and unusable by
    `click_events_link_id_occurred_at_idx`, scanning every row for the link.
  - The three totals are one statement using `filter`, not three round trips,
    because they read the same rows. Bot clicks are reported separately rather
    than silently dropped from the total.
  - A test asserts `typeof` on every count. `count(*)` is `bigint` and arrives
    from `pg` as a string, so an unconverted total would fail
    `assert.equal(total, 3)` against `'3'` under `assert/strict`. The conversion
    happens in the repository, at the same boundary that renames columns.
  - The window test backdates a row by ten days rather than deleting it, so it
    proves the window filters rather than proving the row was absent.
  - **The range predicate in the per-day query is not redundant, and that was
    measured rather than assumed.** It sits beside a `date_trunc` day equality
    that already restricts the result, so it reads as duplication. The equality
    cannot use an index. With 5,000 rows for one link, `explain (analyze)`
    reports a bitmap index scan touching 162 rows and 5 buffers with the
    predicate, and a sequential scan of all 5,000 rows and 77 buffers without
    it, sorting every row. The measurement is recorded in the query's docstring
    so nobody deletes the line as tidying.
  - The service docstring overclaimed and was corrected. The two queries do not
    run in one transaction, so a click landing between them can make the total
    and the series disagree by one. That is consistent with a module whose
    figures are already a lower bound, and a snapshot would buy agreement
    between two approximate numbers.
- [x] **E6. Top referrers** — done
  - Acceptance: `GET /api/links/:slug/referrers` ranks sources over the same
    window rules, owner-only, with a `limit` of 1 to 50 defaulting to 10, bot
    rows excluded and direct traffic reported as null.
  - Verify: two visits from one site and one from another rank in that order;
    a visit with no `Referer` reports `null`; the same four authorisation
    answers as the statistics endpoint.
  - Verified: 302 tests pass, 11 of them new, and `npm run typecheck` is clean.
  - Ties break on the referrer ascending, so two equal counts come back in the
    same order on every call rather than in whatever order the database
    produced. Postgres sorts nulls last under `asc`, so direct traffic loses a
    tie by a stated rule rather than by accident. A test reads the endpoint
    twice and compares.
  - Direct traffic stays `null` rather than becoming a label such as "direct",
    because a site could name itself that and be indistinguishable from visitors
    who arrived with no referrer at all.
  - The query reuses `WINDOW_START`, so the same range predicate keeps the
    grouping inside a row set the index has already narrowed. That is the whole
    justification for `referrer` carrying no index of its own, and it holds only
    because the predicate is sargable, which E5 measured.
  - Authorisation is `requireOwnedLink`, shared with the statistics endpoint, so
    there is one ownership rule in the module rather than two that can drift.
  - A test sends a 4000-character referrer and asserts the stored value is 2048
    characters, proving truncation still protects the fire-and-forget insert on
    this path.

**Checkpoint E — passed.** After `drainPendingWrites()`, the click count equals
the number of redirects performed in the test. Asserted through the HTTP
response rather than only against the database, by "reports a total equal to the
number of redirects performed" in `tests/integration/stats.test.ts`: three
redirects, a drain, and `total` of exactly 3.

302 tests pass and `npm run typecheck` is clean. Every item in the definition of
done in `SPEC-analytics.md` holds, including that `pg` is still the only
production dependency.

**The signal path is now verified, in the container.** Windows cannot deliver a
real `SIGTERM`, so this was run where it can be: `docker build`, then the image
against the Compose database, then `docker stop`, which sends `SIGTERM` to PID 1.

- The process logged `shutting down` with `signal: "SIGTERM"` and then
  `shutdown complete`, so the handler ran rather than the process being killed.
- Container exit code 0, so the sequence finished and exited itself rather than
  being force-killed at the end of Docker's grace period.
- Five redirects issued with no pause and immediately followed by `docker stop`
  all reached the database: the link reports exactly 5 click rows afterwards.
  That is the drain doing its job on writes still in flight when the signal
  arrived, which is what could not be shown on Windows.
- The startup line carries `ipHashSalt` as an eight-character fingerprint, and
  two runs with different salts logged different fingerprints, so salt rotation
  is traceable in production logs as designed.

This also closes the verification C2 left open since Phase C.

Phase E is complete. What remains for the project is C5, the deploy, which needs
your Render account, and success criterion 19 with it.

---

## Review follow-ups

- [x] **R1. Split the pending-write tracker out of the analytics service** —
      done
  - Acceptance: `analytics.service.ts` holds what a click is; the mechanism for
    running a write nobody waits for lives on its own.
  - Verify: 311 tests pass, 1 of them new, and `npm run typecheck` is clean.
  - The service was 400 lines against 208 for the next largest module file. Only
    about 155 of those were code, so the file was never near a size limit; what
    made it worth splitting is that it held two unrelated subjects, and the
    tracker is the one with nothing to do with clicks.
  - `src/modules/analytics/analytics.writes.ts` now owns registration, the
    drain, the 10,000 cap, and the shedding episode. The service is 267 lines
    and reads as click recording plus the two owner-checked reads.
  - **The shedding state stopped being module globals.** `shedding` and
    `droppedClicks` were mutable at module scope, written by one function and
    reset by another, with no way to observe or reset them from a test. They are
    closure state inside the tracker now, so a test can build one, fill it, and
    assert the episode ends, which a new unit test does.
  - This makes the module five files rather than the four-file shape in
    `SPEC.md`. Recorded in `SPEC-analytics.md` with the reason: the shape exists
    to separate routes, services, repositories, and schemas, and a mechanism
    that is none of those is clearer beside them than inside one.

- [x] **R2. Apply the remaining review findings** — done
  - Acceptance: the window expression states which placeholder it needs, the
    authentication check exists once, and no fallback covers a case the database
    cannot produce.
  - Verify: 311 tests pass, `npm run test:unit` passes on its own with 185, and
    `npm run typecheck` is clean.
  - **`WINDOW_START` became `windowStart(n)`.** As a constant it read as
    self-contained SQL while silently requiring every caller to bind the day
    count as `$2`. All three callers did, so nothing was broken; a fourth
    binding its parameters in another order would have compared against whatever
    landed in `$2`, which is a wrong answer rather than an error. The
    `generate_series` calendar moved into `windowCalendar(n)` beside it, so the
    series and the range filter cannot disagree about which parameter they read.
  - **`requireUserId` exists once, in `identity.service.ts`.** It was duplicated
    in the links and analytics route files, which is two copies of the check
    that decides whether a request is authenticated at all. It takes a session
    id rather than a request, so the identity module gains no dependency on the
    HTTP layer, and `src/http/auth.ts` still owns cookie handling.
  - **`readClickTotals` no longer falls back to zero.** An aggregate with no
    `group by` returns exactly one row, even over no data, so `?? 0` covered a
    case the database cannot produce. It now throws if the row is missing, which
    would mean the query had stopped being an aggregate.
  - Left alone deliberately: `optionalUserId` in `links.routes.ts`. Link
    creation treats a bad cookie as absence rather than as a failure, which is a
    different rule from the one just centralised, and merging them would hide
    that difference behind a flag.

## Security review

Not a phase. `SPEC.md` defers one phase after analytics and it is the
multi-instance one with Nginx, not a security phase; hardening was Phase C. This
is a single review task, recorded here because two things came out of it that
change the code or the specs.

- [x] **S1. Security review of the finished service** — done
  - Acceptance: every claim checked against the source rather than the specs,
    since a spec that disagrees with the code is what the `VALIDATION_ERROR` and
    `isUniqueViolation` slips were both made of.
  - Verify: 310 tests pass, 8 of them new, and `npm run typecheck` is clean.

  **Changed: `X-Content-Type-Options: nosniff` on every response.** It was on
  none. Added in `send`, so it covers JSON, redirects, and errors alike, and a
  handler's own headers merge over the default rather than replacing it. Nothing
  else was added: a Content Security Policy guards markup this API never
  returns, and HSTS is a promise about a domain that is not deployed, so both
  would be decoration.

  **Accepted, and now written down: registration discloses that an address is
  taken.** Sign-in goes to real lengths to prevent that disclosure, with one
  answer for an unknown address and a wrong password and a dummy hash verified
  so the timing matches. `POST /api/auth/register` then answers `409`
  `EMAIL_TAKEN`, so an attacker enumerates there instead. It stays because
  hiding it requires telling the real account holder by email and this service
  has no email provider by design. The credential rate limit of ten attempts per
  fifteen minutes makes it slow. Recorded as a resolved decision in
  `SPEC-identity.md`, with the one change that would let it be revisited.

  **Considered and declined: `Referrer-Policy`.** It would control what the
  destination learns about which slug sent a visitor, not what this service
  receives. Setting `no-referrer` would remove attribution that link owners'
  own destinations legitimately use, and would improve nothing here.

  Checked and found sound, with no change needed:

  - Every query is parameterised. The only interpolation in any SQL string is
    `WINDOW_START`, a module constant containing no caller input.
  - Sessions are 32 random bytes, looked up with `expires_at > now()` in the
    same statement, so an expired session is indistinguishable from an unknown
    one. Sign-out deletes the row, and expired rows are purged opportunistically
    on the next sign-in rather than by a scheduler.
  - Passwords are `scrypt` with parameters stored in the hash, compared with
    `timingSafeEqual`, bounded to 12 to 128 characters so a long password cannot
    be a hashing denial of service.
  - Nothing logs a password, hash, session id, or `Cookie` header. Error
    responses carry an `AppError`'s message only; anything else is logged in
    full and answered with a generic 500.
  - `GET /api/links/:slug` is unauthenticated by design and exposes neither
    `ownerId` nor the internal `id`, so it says no more than following the link
    already does. Now asserted by a test.
  - `npm audit --omit=dev` reports zero vulnerabilities against the single
    production dependency.
  - Response splitting through the `Location` header is not possible: the WHATWG
    URL parser strips CR and LF while parsing, so a destination containing them
    is stored without them. That protection is incidental to the parser rather
    than written anywhere, which is why it now has a regression test.
