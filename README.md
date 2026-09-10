# URL Shortener API

A URL shortener built on the Node.js standard library, with `pg` as the only
production dependency.

This is a learning project. Every choice is made to expose a backend concept
rather than to reach a result quickly, which is why there is no web framework,
no test framework, no validation library, and no migration tool.

## Where to read next

There is a lot of writing in this repository. This table is the index.

| If you want to know                    | Read                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| How a request travels through the code | [`docs/request-lifecycle.md`](docs/request-lifecycle.md)                                                        |
| What each endpoint accepts and returns | [`openapi.json`](openapi.json), or the API tables below                                                         |
| Why something is built this way        | [`docs/adr/`](docs/adr/README.md)                                                                               |
| The full requirements                  | [`SPEC.md`](SPEC.md), plus [links](SPEC-links.md), [identity](SPEC-identity.md), [analytics](SPEC-analytics.md) |
| What an attacker could do              | [`THREAT-MODEL.md`](THREAT-MODEL.md)                                                                            |
| How to work on it                      | [`CONTRIBUTING.md`](CONTRIBUTING.md)                                                                            |
| How it was built, step by step         | [`tasks/`](tasks/) — a build log, not current behaviour                                                         |

Start with the request lifecycle. It names the file that owns each step, and the
rest of the codebase stops being a maze after it.

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

| Method   | Path               | Auth     | What it does                                                           |
| -------- | ------------------ | -------- | ---------------------------------------------------------------------- |
| `POST`   | `/api/links`       | required | Creates a link. `201` with the slug and short URL                      |
| `GET`    | `/:slug`           | none     | `302` to the destination. `404` unknown, `410` expired                 |
| `HEAD`   | `/:slug`           | none     | Same status and headers, no body                                       |
| `GET`    | `/api/links/:slug` | required | The link's metadata, including a past expiry. `403` for someone else's |
| `GET`    | `/api/links`       | required | The caller's own links, newest first, cursor paginated                 |
| `DELETE` | `/api/links/:slug` | required | `204`. `403` for someone else's link or an ownerless one               |

```bash
curl -X POST http://localhost:3000/api/links \
  -H 'Content-Type: application/json' \
  -b 'session=YOUR_SESSION_COOKIE' \
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

Creating a link requires an account, so every link has an owner and abuse is
attributable. Following one never requires an account: a redirect that asked for
a session would be useless to everyone the link was sent to.

Links made before that rule existed keep a null owner forever. Nobody can list,
delete, or read statistics for one, because nobody can prove they made it.

### Accounts

| Method | Path                 | What it does                                                    |
| ------ | -------------------- | --------------------------------------------------------------- |
| `POST` | `/api/auth/register` | Creates an account. Always `202`, never a session. Sign in next |
| `POST` | `/api/auth/login`    | Signs in. `401` on bad credentials                              |
| `POST` | `/api/auth/logout`   | Deletes the session row and clears the cookie                   |
| `GET`  | `/api/auth/me`       | The current user, or `401`                                      |

Sessions are opaque random ids stored in a table, not JWTs, so they are
revocable server-side and there is no signature verification to get wrong. The
id travels in an `HttpOnly` cookie, named `__Host-session` in production.

### Statistics

Both routes require a session and answer only to the link's owner: `401` with no
session, `403` for another user's link or an ownerless one, `404` for an unknown
slug. A slug appears in browser history and referrer headers, so it is public by
construction and cannot also be the credential guarding click history.

| Method | Path                         | Query                            | What it does                                       |
| ------ | ---------------------------- | -------------------------------- | -------------------------------------------------- |
| `GET`  | `/api/links/:slug/stats`     | `days` 1–90, default 30          | Total, unique visitors, bot clicks, per-day series |
| `GET`  | `/api/links/:slug/referrers` | `days`, `limit` 1–50, default 10 | Ranked traffic sources                             |

```json
{
  "slug": "aB3xK9p",
  "windowDays": 7,
  "total": 42,
  "uniqueVisitors": 17,
  "botClicks": 5,
  "byDay": [
    { "date": "2026-09-03", "clicks": 0 },
    { "date": "2026-09-04", "clicks": 3 }
  ]
}
```

The per-day series is dense: every UTC day in the window appears once, including
zeros, so nothing downstream has to rebuild the calendar and a gap cannot read
as continuity. In the referrers response, direct traffic is `null` rather than a
label, because a site could otherwise name itself "direct".

**Every count is a lower bound.** The click write is deliberately not awaited, so
a crash between the response and the insert drops the event. Anything that
displays these numbers should say so.

## Operations

### Health

| Method | Path            | What it does                                                       |
| ------ | --------------- | ------------------------------------------------------------------ |
| `GET`  | `/health/live`  | Liveness. Touches nothing outside the process                      |
| `GET`  | `/health/ready` | Readiness. `200` when the database answers, `503` when it does not |
| `GET`  | `/health`       | The same answer as `/health/ready`, kept for existing probes       |

The split exists because an orchestrator acts on the two answers differently. A
failed liveness probe restarts the container; a failed readiness probe only
takes it out of rotation. A restart does not repair an unreachable database, so
pointing a restart-triggering probe at the database turns a database outage into
a restart loop across every instance, at the moment the database is least able
to absorb reconnections. Point container health checks and Kubernetes
`livenessProbe` at `/health/live`, and load balancers and `readinessProbe` at
`/health/ready`.

### Request correlation

Every response carries an `X-Request-Id` header, and every log and audit line
written while serving that request carries the same value under `requestId`.
That is what makes a report reconstructable: one id gathers the audit line, the
error, and the rate-limit refusal into a single story.

An inbound `X-Request-Id` is adopted when it is at most 128 characters and
contains only unreserved URL characters, so a trace started at a proxy continues
here. Anything else is replaced with a fresh UUID rather than rejected, because
a header nothing depends on must not be able to fail a request. The value is
echoed and logged, so the character restriction is what keeps a caller from
splitting a response header.

### API contract

`openapi.json` describes every route, and `tests/unit/openapi.test.ts` fails if
it drifts from the routes the server actually serves. Prose lives in
`SPEC.md`; the JSON is the machine-readable form of the same contract, not a
second one.

## Commands

| Command                           | What it does                                         |
| --------------------------------- | ---------------------------------------------------- |
| `npm run dev`                     | Development server, restarting on change             |
| `npm start`                       | Production server                                    |
| `npm run typecheck`               | Type check only; this project never emits JavaScript |
| `npm run verify`                  | Every gate CI runs, in the same order                |
| `npm run lint` / `lint:fix`       | ESLint, with type information                        |
| `npm run format` / `format:check` | Prettier                                             |
| `npm test`                        | Everything, after migrating the test database        |
| `npm run test:unit`               | Unit tests only; needs no database                   |
| `npm run test:watch`              | Tests, re-running on change                          |
| `npm run test:coverage`           | Tests with coverage                                  |
| `npm run db:up` / `db:down`       | Start and stop PostgreSQL                            |
| `npm run migrate`                 | Apply pending migrations                             |
| `npm run migrate:test`            | Apply them to the test database                      |
| `npm run migrate:status`          | Show applied and pending migrations                  |
| `npm run migrate:new -- <name>`   | Create an empty migration                            |

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
openapi.json           The API contract, checked against the routes by a test
.github/workflows/     CI: type check, lint, format, tests, image build
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
analytics. 355 tests pass, and the type check, the linter, and the formatter
are all clean.

A threat model of the running service is in
[`THREAT-MODEL.md`](THREAT-MODEL.md). All twelve of its findings are fixed.

Four of those fixes change behaviour a client or a deployment has to know about:

- Creating a link requires a session, so an anonymous `POST /api/links` is a `401`.
- Reading a link's metadata requires the owner's session.
- Registration always answers `202` and never issues a session, so a new account
  signs in as a second call. It answers the same whether or not the address was
  already taken, which is what stops it confirming who holds an account.
- The migration that hashes session identifiers deletes every existing session,
  so the deploy that applies it signs every user out once.

The service is **not deployed**, deliberately. Criterion 19 in `SPEC.md` is the
only one that requires a public URL, and running locally is enough for what this
project is for. Everything a deployment needs is in the repository: the
Dockerfile, a separate `DATABASE_SSL` setting with a `DATABASE_CA_CERT` bundle
to verify the database certificate against, and migrations as a pre-deploy step. The graceful `SIGTERM` path is verified in the container, since Windows
cannot deliver that signal.

The reasoning behind each decision is in [`docs/adr/`](docs/adr/README.md).

[`tasks/todo.md`](tasks/todo.md) is the build log: 38 tasks, each recording what
was verified and what was found wrong along the way. It is history, and it is
kept because the mistakes in it are the most useful part. It is not a
description of how the service behaves now.
