# URL Shortener API

A URL shortener built on the Node.js standard library, with `pg` as the only
production dependency.

This is a learning project. Every choice is made to expose a backend concept
rather than to reach a result quickly, which is why there is no web framework,
no test framework, no validation library, and no migration tool.

Full requirements are in [`SPEC.md`](SPEC.md), with one spec per module in
[`SPEC-links.md`](SPEC-links.md), [`SPEC-identity.md`](SPEC-identity.md), and
[`SPEC-analytics.md`](SPEC-analytics.md). The plan and the ordered task list are
in [`tasks/`](tasks/), and every task there records what was verified and what
was found wrong along the way.

## Requirements

- Node.js 22.15 (see `.nvmrc`; the version matters, because runtime type
  stripping is version-sensitive)
- Docker, for PostgreSQL

## First-time setup

```bash
cp .env.example .env
cp .env.example .env.test   # then change the database name to urlshortener_test
npm install
npm run db:up
npm run migrate
npm run migrate:test
npm run dev
```

Both `.env` and `.env.test` must exist before any script runs. `node --env-file`
exits immediately when the file is missing, with `node: .env: not found`.

Set `IP_HASH_SALT` to something real before starting. The service refuses to
boot while it still holds the placeholder:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Then check it is alive:

```bash
curl http://localhost:3000/health
# {"status":"ok","database":"ok"}
```

## API

Errors share one shape: `{"error":{"code":"...","message":"...","details":[...]}}`,
where `details` carries field-level problems for a validation failure.

### Links

| Method | Path | Auth | What it does |
|---|---|---|---|
| `POST` | `/api/links` | optional | Creates a link. `201` with the slug and short URL |
| `GET` | `/:slug` | none | `302` to the destination. `404` unknown, `410` expired |
| `HEAD` | `/:slug` | none | Same status and headers, no body |
| `GET` | `/api/links/:slug` | none | The link's metadata, including an expiry in the past |
| `GET` | `/api/links` | required | The caller's own links, newest first, cursor paginated |
| `DELETE` | `/api/links/:slug` | required | `204`. `403` for someone else's link or an ownerless one |

```bash
curl -X POST http://localhost:3000/api/links \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/a/very/long/path"}'
```

```json
{
  "slug": "aB3xK9p",
  "shortUrl": "http://localhost:3000/aB3xK9p",
  "url": "https://example.com/a/very/long/path",
  "expiresAt": null,
  "createdAt": "2026-09-09T10:00:00.000Z"
}
```

`customSlug` and `expiresAt` are optional. A slug is 7 base62 characters and is
case-sensitive. Omitting `expiresAt` means the link never expires.

Creating a link works without an account, and that link keeps a null owner
forever: nobody can list, delete, or read statistics for it, because nobody can
prove they created it.

### Accounts

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/auth/register` | Creates an account and signs it in. `409` `EMAIL_TAKEN` |
| `POST` | `/api/auth/login` | Signs in. `401` on bad credentials |
| `POST` | `/api/auth/logout` | Deletes the session row and clears the cookie |
| `GET` | `/api/auth/me` | The current user, or `401` |

Sessions are opaque random ids stored in a table, not JWTs, so they are
revocable server-side and there is no signature verification to get wrong. The
id travels in an `HttpOnly` cookie, named `__Host-session` in production.

### Statistics

Both routes require a session and answer only to the link's owner: `401` with no
session, `403` for another user's link or an ownerless one, `404` for an unknown
slug. A slug appears in browser history and referrer headers, so it is public by
construction and cannot also be the credential guarding click history.

| Method | Path | Query | What it does |
|---|---|---|---|
| `GET` | `/api/links/:slug/stats` | `days` 1–90, default 30 | Total, unique visitors, bot clicks, per-day series |
| `GET` | `/api/links/:slug/referrers` | `days`, `limit` 1–50, default 10 | Ranked traffic sources |

```json
{
  "slug": "aB3xK9p",
  "windowDays": 7,
  "total": 42,
  "uniqueVisitors": 17,
  "botClicks": 5,
  "byDay": [{ "date": "2026-09-03", "clicks": 0 }, { "date": "2026-09-04", "clicks": 3 }]
}
```

The per-day series is dense: every UTC day in the window appears once, including
zeros, so nothing downstream has to rebuild the calendar and a gap cannot read
as continuity. In the referrers response, direct traffic is `null` rather than a
label, because a site could otherwise name itself "direct".

**Every count is a lower bound.** The click write is deliberately not awaited, so
a crash between the response and the insert drops the event. Anything that
displays these numbers should say so.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server, restarting on change |
| `npm start` | Production server |
| `npm run typecheck` | Type check only; this project never emits JavaScript |
| `npm test` | Everything, after migrating the test database |
| `npm run test:unit` | Unit tests only; needs no database |
| `npm run test:watch` | Tests, re-running on change |
| `npm run test:coverage` | Tests with coverage |
| `npm run db:up` / `db:down` | Start and stop PostgreSQL |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:test` | Apply them to the test database |
| `npm run migrate:status` | Show applied and pending migrations |
| `npm run migrate:new -- <name>` | Create an empty migration |

Set `LOG_IN_TESTS=1` to see log output during tests, which is suppressed by
default so that deliberate failure-path tests do not bury the runner's output.

## Layout

```
src/
  config/env.ts        Reads and validates the environment once, at startup
  db/                  Connection pool and transaction helper
  http/                Router, body reader, response helpers, errors, cookies, auth
  lib/                 Slug generation, validation, client IP, IP hashing, logging
  modules/links/       Slug generation, redirect, link CRUD, expiry
  modules/identity/    Accounts, password hashing, cookie sessions, ownership
  modules/analytics/   Click capture and per-link statistics
  shutdown.ts          The graceful shutdown sequence, separate so it is testable
migrations/            Numbered SQL, applied in order, never edited once applied
scripts/migrate.ts     The migration runner
tests/unit/            Pure functions; no database
tests/integration/     Real HTTP against a real database
```

Requests flow one way: route handler, then service, then repository, then the
database. A handler that writes SQL, or a service that reads request headers, is
a design bug rather than a shortcut.

## Notes that are easy to get wrong

**PostgreSQL is on host port 5433**, not 5432, because another project on the
development machine already binds 5432.

**The test database is created by an init script** in `docker/init/`, which
Docker runs only when the data volume is first created. If `urlshortener_test`
is missing, either recreate the volume with `docker compose down -v`, which
destroys local data, or create it by hand:

```bash
docker compose exec postgres createdb -U postgres urlshortener_test
```

**`links.id` is a string, not a number.** It is a PostgreSQL `bigint`, which
`pg` returns as a string because 64-bit integers do not fit in a JavaScript
number. A `count(*)` arrives as a string for the same reason, and repositories
convert those with `Number()` at their own boundary.

**Deleting a link destroys its click history**, through `on delete cascade`.
There is no soft delete and no export.

**Raw IP addresses are never stored.** Analytics keeps a salted SHA-256 digest,
only to count distinct visitors. Rotating `IP_HASH_SALT` resets those counts,
which is why the startup log carries an eight-character fingerprint of the salt:
a drop in unique visitors is then explainable by comparing fingerprints. The
salt itself is never logged.

**`TRUST_PROXY_HOPS` is `0` and correct while nothing proxies this service.**
Behind a proxy it must name the real hop count, or every visitor resolves to the
proxy: the rate limiter becomes one global bucket and unique visitors collapse
to one.

**`ENABLE_UNAUTHENTICATED_LINK_ADMIN` no longer exists.** It gated listing and
deletion while those routes were unauthenticated. Identity closed that gate for
good by requiring a session and scoping both to the owner, so the flag was
removed rather than left as a switch that could be turned back on.

## Status

All five phases are complete: foundation, links, hardening, identity, and
analytics. 327 tests pass and `npm run typecheck` is clean.

A threat model of the running service is in
[`THREAT-MODEL.md`](THREAT-MODEL.md). Ten of its twelve findings are fixed; the
two left open are recorded there with the reason.

Two of those fixes change behaviour a deployment has to know about. Creating a
link now requires a session, so an anonymous `POST /api/links` is a 401. And the
migration that hashes session identifiers deletes every existing session, so the
deploy that applies it signs every user out once.

The service is **not deployed**, deliberately. Criterion 19 in `SPEC.md` is the
only one that requires a public URL, and running locally is enough for what this
project is for. Everything a deployment needs is in the repository: the
Dockerfile, a separate `DATABASE_SSL` setting with a `DATABASE_CA_CERT` bundle
to verify the database certificate against, and migrations as a pre-deploy step. The graceful `SIGTERM` path is verified in the container, since Windows
cannot deliver that signal.

Progress and the reasoning behind each decision are in
[`tasks/todo.md`](tasks/todo.md).
