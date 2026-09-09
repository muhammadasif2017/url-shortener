# Task List: URL Shortener API

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

- [ ] **A2. Slug generation and reserved words**
  - Acceptance: `generateSlug()` returns 7 base62 characters from
    `crypto.randomBytes`, rejecting bytes at or above 248.
    `isReservedSlug()` matches case-insensitively.
  - Verify: unit tests for length, alphabet, a roughly uniform distribution
    across many samples, and case-insensitive reserved matching.
  - Files: `src/lib/slug.ts`, `tests/unit/slug.test.ts`
  - Note: pure functions, no database and no HTTP. Build this first.

- [ ] **A3. Validation primitives and link input parsing**
  - Acceptance: shared narrowing helpers plus `parseCreateLinkInput`. URL rules
    from `SPEC-links.md`: parses, `http:` or `https:` only, has a host, 2048
    characters or fewer, and host does not match `BASE_URL`.
  - Verify: unit tests accepting http and https and rejecting `javascript:`,
    `data:`, `file:`, a missing host, an over-length URL, a past `expiresAt`, a
    malformed date, and a self-referential URL.
  - Files: `src/lib/validate.ts`, `src/modules/links/links.schema.ts`,
    `tests/unit/validate.test.ts`

- [ ] **A4. Config and environment validation**
  - Acceptance: `env.ts` reads and validates every variable from the table in
    `SPEC.md`, and throws on startup when one is missing or malformed.
  - Verify: unit test asserting a missing required variable throws, and that
    defaults apply for optional ones.
  - Files: `src/config/env.ts`, `tests/unit/env.test.ts`

- [ ] **A5. Client IP resolver**
  - Acceptance: `TRUST_PROXY_HOPS` of 0 uses `socket.remoteAddress`; above 0
    counts from the right-hand end of `X-Forwarded-For`. Strips the
    IPv4-mapped IPv6 prefix, lowercases IPv6, returns `unknown` for undefined.
  - Verify: unit tests including a forged left-hand entry that must be ignored.
  - Files: `src/lib/clientIp.ts`, `tests/unit/clientIp.test.ts`

- [ ] **A6. Router with precedence rules**
  - Acceptance: first-wins ordered matching, literal routes before parameter
    routes, segment count must match, `HEAD` matches `GET` entries, and a path
    that exists with a different method returns 405 with `Allow`.
  - Verify: unit tests proving `/health` and `/api/links` never match `/:slug`,
    that `HEAD /:slug` matches, and that 405 carries `Allow`.
  - Files: `src/http/router.ts`, `src/http/context.ts`,
    `tests/unit/router.test.ts`
  - Note: this is the single most likely source of subtle bugs in the project.

- [ ] **A7. Body reader with a hard size limit**
  - Acceptance: streams the request body, rejects over 16 KB, rejects an
    oversized `Content-Length` up front, and calls `req.resume()` after
    responding so the response reaches the client cleanly.
  - Verify: unit test asserting the stream is destroyed after at most 16 KB.
  - Files: `src/http/readBody.ts`, `tests/unit/readBody.test.ts`

- [ ] **A8. Response helpers, errors, logger, cookies**
  - Acceptance: `json()`, `redirect()`, `noContent()`. `AppError` with code,
    message, and status. Error handler producing the one documented error shape.
    JSON logger to stdout. Cookie parse and serialise.
  - Verify: unit tests for the error shape, and for cookie parsing with several
    cookies in one header and a value containing `=`.
  - Files: `src/http/respond.ts`, `src/http/errorHandler.ts`,
    `src/http/cookies.ts`, `src/lib/AppError.ts`, `src/lib/logger.ts`

- [ ] **A9. Compose, including the test database**
  - Acceptance: Postgres 16 on host port 5433, plus an init script mounted at
    `/docker-entrypoint-initdb.d/` that runs `create database urlshortener_test`.
  - Verify: `npm run db:up`, then confirm both databases exist.
  - Files: `docker-compose.yml`, `docker/init/01-create-test-db.sql`
  - Note: without this, `migrate:test` fails with `3D000` and `npm test` cannot
    run at all.

- [ ] **A10. Pool, migration runner, first migration**
  - Acceptance: runner applies numbered SQL files in order, records each in a
    migrations table, wraps each file in a transaction, and is idempotent.
    `001_create_links.sql` creates the table with every constraint from
    `SPEC-links.md`.
  - Verify: `npm run migrate` twice; the second run applies nothing. Confirm
    every CHECK constraint exists.
  - Files: `src/db/pool.ts`, `scripts/migrate.ts`,
    `migrations/001_create_links.sql`

- [ ] **A11. Server, entry point, health check**
  - Acceptance: `server.ts` builds the server without listening. `index.ts`
    listens and wires shutdown. `/health` runs `select 1` with a 2 second
    timeout, returning 200 or 503.
  - Verify: integration test asserting 200 with `database: "ok"`.
  - Files: `src/server.ts`, `src/index.ts`, `tests/helpers/server.ts`,
    `tests/integration/health.test.ts`

**Checkpoint A.** Server starts. `/health` returns 200 with `database: "ok"`.
All unit tests above pass. `npm run typecheck` is clean. Do not start Phase B
until every box above is ticked.

---

## Phase B — links module

- [ ] **B1. `POST /api/links`**
  - Acceptance: 201 with slug, `shortUrl`, url, `expiresAt`, `createdAt`.
    Custom slug honoured. Reserved slug returns 400. Duplicate returns 409 via
    SQLSTATE `23505`. Generated-slug collisions retry five times, then 503 with
    `Retry-After`. `links.id` stays a string.
  - Verify: integration tests for 201, custom slug, 400 reserved, 409 duplicate,
    400 for a `javascript:` URL, and 413 for a 20 KB body.
  - Files: `links.routes.ts`, `links.service.ts`, `links.repository.ts`,
    `tests/integration/links.test.ts`

- [ ] **B2. `GET` and `HEAD /:slug`**
  - Acceptance: 302 with `Location` and `Cache-Control: no-store`. 404 unknown,
    410 expired, expiry evaluated in SQL against `now()`. `HEAD` returns the
    same status and headers with no body. Not rate limited.
  - Verify: integration tests using `redirect: 'manual'` for 302, 404, 410, and
    a `HEAD` request asserting an empty body.

- [ ] **B3. `GET /api/links/:slug`**
  - Acceptance: 200 with metadata, 404 otherwise. An expired link is still
    returned here with its past `expiresAt`.
  - Verify: integration test confirming the same slug gives 410 on the redirect
    route and 200 here.

- [ ] **B4. `GET /api/links` with keyset pagination**
  - Acceptance: `limit` 1 to 100 defaulting to 20, cursor is base64url of the
    last `id`, `where id < $1 order by id desc`. Malformed cursor returns 400.
    Route gated behind `ENABLE_UNAUTHENTICATED_LINK_ADMIN`.
  - Verify: integration test paging five links with `limit=2`, asserting no
    duplicates and no missing rows, and a null `nextCursor` on the last page.
    Second test: route returns 404 without the flag.

- [ ] **B5. `DELETE /api/links/:slug`**
  - Acceptance: 204 when deleted, 404 otherwise. Gated behind the same flag.
  - Verify: integration test for 204, then 404 on both routes; and 404 for the
    route itself without the flag.

**Checkpoint B.** Every `SPEC-links.md` verification item passes. `pg` is still
the only production dependency.

---

## Phase C — Hardening and deployment

- [ ] **C1. Rate limiting**
  - Acceptance: fixed window keyed by resolved client IP. Defaults 60 per 60
    seconds. `GET /:slug` exempt. 429 in the standard error shape with
    `Retry-After`. Sweep expired entries on write, hard cap 10,000.
  - Verify: integration test exceeding the limit on `POST /api/links` and
    confirming `GET /:slug` still works. Unit test proving the map is capped.

- [ ] **C2. Timeouts and graceful shutdown**
  - Acceptance: `headersTimeout` 10s, `requestTimeout` 20s,
    `keepAliveTimeout` 5s. On `SIGTERM`: stop accepting, await in-flight, drain,
    close pool, exit, every step bounded.
  - Verify: send `SIGTERM` during an in-flight request and confirm it completes
    before exit.

- [ ] **C3. Dockerfile**
  - Acceptance: `node:22.15-alpine`, `npm ci --omit=dev`, non-root `node` user,
    `NODE_ENV=production`, `HEALTHCHECK` hitting `/health`, and a `CMD` using
    `--env-file-if-exists`.
  - Verify: build the image, run it against the Compose database, and confirm
    Docker reports the container healthy.

- [ ] **C4. BLOCKING GATE — close the unauthenticated admin routes**
  - Acceptance: `ENABLE_UNAUTHENTICATED_LINK_ADMIN` is unset in every deployed
    environment, so `GET /api/links` and `DELETE /api/links/:slug` both return
    404 there.
  - Verify: against the deployed URL, both routes return 404.
  - Note: this is not a checklist formality. Without it, anyone can enumerate
    every link and delete any of them.

- [ ] **C5. Deploy**
  - Acceptance: Render service on the Docker runtime, Render PostgreSQL with TLS
    enabled in the pool config, migrations as a pre-deploy command,
    `TRUST_PROXY_HOPS` set correctly, database expiry date recorded.
  - Verify: create a link and follow it on the public URL. Confirm two different
    clients land in two different rate-limit buckets.

**Checkpoint C.** Image healthy, public URL responds, proxy hops verified, both
admin routes closed.

---

## Phase D — identity module

- [ ] **D1. Complete `SPEC-identity.md`**
  - Acceptance: the three open questions resolved, every endpoint contract
    written.
  - Verify: reviewed before any identity code is written.

- [ ] **D2. `users` and `sessions` tables** — migration `002`
- [ ] **D3. `scrypt` hashing** with the specified parameters, `maxmem`, stored
      format, async form only, and a length check before `timingSafeEqual`
- [ ] **D4. Register, login, logout, current user**, with the cookie attributes
      from the spec including the environment-dependent `__Host-` prefix
- [ ] **D5. Content-type guard** returning 415 on state-changing routes
- [ ] **D6. `owner_id` on `links`** — migration `003`, nullable, with the
      `(owner_id, id desc)` index
- [ ] **D7. Authorisation**: scope listing to the owner, 403 on cross-user
      delete, then remove `ENABLE_UNAUTHENTICATED_LINK_ADMIN` entirely
- [ ] **D8. Stricter rate limit on sign-in and registration**, 10 per 15 minutes

**Checkpoint D.** Cookie is `HttpOnly` and `Secure`. Unknown and expired
sessions return 401. Sign-out deletes the row and the old cookie fails, proven
from a path other than `/`. Cross-user delete returns 403.

---

## Phase E — analytics module

- [ ] **E1. Complete `SPEC-analytics.md`** — resolve the three open questions
- [ ] **E2. `click_events` table** — migration `004`, cascade on link delete
- [ ] **E3. Fire-and-forget writer** — synchronous registration into the pending
      set before the response flushes, mandatory `.catch()`, loop-until-empty
      `drainPendingWrites()`
- [ ] **E4. Wire the drain into shutdown** in the correct order
- [ ] **E5. Stats endpoint** — total and per-day breakdown, counts converted
      with `Number()` at the repository boundary
- [ ] **E6. Top referrers**

**Checkpoint E.** After `drainPendingWrites()`, the click count equals the
number of redirects performed in the test.
