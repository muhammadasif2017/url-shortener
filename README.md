# URL Shortener API

A URL shortener built on the Node.js standard library, with `pg` as the only
production dependency.

This is a learning project. Every choice is made to expose a backend concept
rather than to reach a result quickly, which is why there is no web framework,
no test framework, no validation library, and no migration tool.

Full requirements are in [`SPEC.md`](SPEC.md). The plan and the ordered task
list are in [`tasks/`](tasks/).

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
  http/                Router, body reader, response helpers, errors, cookies
  lib/                 Slug generation, validation, client IP, logging, AppError
  modules/<name>/      One module per capability: routes, service, repository, schema
migrations/            Numbered SQL, applied in order, never edited once applied
scripts/migrate.ts     The migration runner
tests/unit/            Pure functions; no database
tests/integration/     Real HTTP against a real database
```

Requests flow one way: route handler, then service, then repository, then the
database. A handler that writes SQL, or a service that reads request headers,
is a design bug rather than a shortcut.

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

**`ENABLE_UNAUTHENTICATED_LINK_ADMIN` must never be set in production.** While
it is on, anyone can list every link and delete any of them. The service refuses
to start if it is set while `NODE_ENV` is production.

## Status

Phase A of five is complete: the foundation, HTTP core, database, and health
check. Phase B, the link endpoints, is next. Progress is tracked in
[`tasks/todo.md`](tasks/todo.md).
