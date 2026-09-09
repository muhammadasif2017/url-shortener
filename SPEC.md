# Spec: URL Shortener API

Status: reviewed and corrected; ready to implement
Owner: single developer
Last updated: 2026-09-09

## Objective

Build a JSON REST API that turns long URLs into short slugs, redirects visitors
to the original destination, and reports how often each link is used.

The real goal is educational. This project is the vehicle for learning backend
engineering after working as a frontend developer. Every feature is chosen
because it forces a specific backend lesson, not because a commercial URL
shortener would need it.

### Users

- **Anonymous visitor** — follows a short link and lands on the destination.
- **Link creator** — creates links, optionally with a custom slug and an expiry.
  Anonymous at first; becomes an authenticated account once the identity module
  lands.
- **Link owner** — an authenticated user who lists, inspects, and deletes their
  own links and reads their click statistics.

### What success looks like

A deployed service with a public URL. Sending a long URL to it returns a short
link. Opening that short link in a browser redirects correctly. The creator can
sign in and see how many times the link was opened, and when.

### Non-goals

Listed so that scope creep is a visible decision rather than an accident.

- No web frontend. This repository is the API only.
- No custom domains per user.
- No team accounts, organisations, or link sharing between users.
- No paid plans, quotas, or billing.
- No horizontal scaling, multi-region deployment, or high-availability design.
  This was raised explicitly and declined. The service runs as exactly one
  process, on one instance, behind no load balancer of our own.
- No link preview scraping, malware scanning, or content moderation.

## Guiding Constraint: Node.js First

This project prefers the Node.js standard library over npm packages wherever a
built-in can do the job. The point is to learn what the platform provides before
reaching for a framework, and to understand what a framework would have hidden.

A dependency is only justified when Node has no equivalent primitive at all.

### What the standard library replaces

| Common package | Built-in used instead |
|---|---|
| express | `node:http` plus a hand-written router |
| body-parser | Async iteration over the request stream |
| dotenv | `node --env-file` locally, `--env-file-if-exists` in production |
| tsx, ts-node | `node --experimental-strip-types` |
| vitest, jest | `node:test` and `node:assert/strict` |
| supertest | Global `fetch` against a real listening server |
| nyc, c8 | `node --experimental-test-coverage` |
| nanoid, uuid | `node:crypto` (`randomBytes`, `randomUUID`) |
| bcrypt, argon2 | `node:crypto` (`scrypt`, `timingSafeEqual`) |
| jsonwebtoken | `node:crypto` `randomBytes` plus a `sessions` table |
| cookie-parser | Hand-written parse and serialise in `src/http/cookies.ts` |
| zod, joi | Hand-written parse functions returning narrowed types |
| winston, pino | JSON written to stdout by a small logger module |
| node-pg-migrate | Numbered SQL files plus a small migration runner |
| nodemon | `node --watch` |

### The one unavoidable dependency

`pg` is required. PostgreSQL speaks a binary wire protocol over TCP, and Node
has no client for it. Implementing that protocol is a different project.

Production dependencies are therefore: **`pg`, and nothing else.**

Development dependencies are `typescript` (for type checking only, never for
emitting), `@types/node`, and `@types/pg`.

### Where the constraint is deliberately relaxed

Being Node-first is not an excuse to reimplement security primitives badly.

- Cryptographic algorithms come from `node:crypto`. No hand-rolled hashing,
  no hand-rolled random number generation.
- **JWT was considered and rejected.** A hand-written verifier has to get
  several independent things right, each with its own history of real
  vulnerabilities: pinning the algorithm, rejecting `none`, rejecting algorithm
  confusion between HMAC and RSA, verifying `exp` and `nbf`, rejecting
  non-canonical base64url, and rejecting duplicate JSON keys. An opaque random
  session id stored in a table has no signature at all, so none of those
  failures exist. It also gives server-side revocation for free, which a JWT
  makes hard. See `SPEC-identity.md`.
- If a hand-written component turns out to be a genuine liability, replacing it
  with a reviewed library is a correct decision, not a failure. Record the swap
  in this spec when it happens.

## Capability Map

| Module id | Responsibility | Depends on |
|---|---|---|
| links | Slug generation, redirect resolution, link CRUD, expiry | — |
| identity | Accounts, password hashing, cookie sessions, link ownership | links |
| analytics | Click event capture, per-link statistics | links |

Build order: `links` → `identity` → `analytics`

Dependencies point one way and there are no cycles. `identity` depends on
`links` because ownership is an attribute added to an existing links table, not
the other way round.

All three modules ship inside one deployable service. The module boundary is a
code boundary: each module owns its own routes, service, repository, and schema
files, and modules talk to each other through service functions rather than by
reaching into each other's tables.

Module specs: `SPEC-links.md`, `SPEC-identity.md`, `SPEC-analytics.md`.

## Tech Stack

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node.js 22.15 LTS | Already installed; ships every primitive below |
| Language | TypeScript 5.8 or newer, types stripped at runtime | Type safety with no build step; 5.8 is the first version with `erasableSyntaxOnly` |
| HTTP server | `node:http` | The request lifecycle stays visible |
| Routing | Hand-written matcher over `URLPattern`-style segments | Teaches what Express does |
| Database | PostgreSQL 16 | Teaches constraints, transactions, and indexes |
| DB driver | `pg` with a connection pool | Raw SQL keeps the query layer visible |
| Migrations | Numbered SQL files plus a runner script | Reversible, no dependency |
| Validation | Hand-written parse functions | Type narrowing done explicitly |
| Password hashing | `node:crypto` async `scrypt`, tuned parameters | Memory-hard, built in, no native module to compile |
| Sessions | Opaque random session id in a `sessions` table | No signature to verify, so no signature to get wrong |
| Tests | `node:test` and `node:assert/strict` | Built in, no test framework to configure |
| Rate limiting | In-memory `Map` with sweep-on-write eviction | Correct for a single process; no dependency needed |
| Local infrastructure | Docker Compose | Postgres without polluting Windows |
| Deployment | Render, free tier, Docker runtime | Free, gives a public URL |
| Production database | Render PostgreSQL, free tier | Same platform, private network |

Postgres binds to host port **5433**, because port 5432 is already taken by the
`job-tracker` containers on this machine. Redis, if it is ever added, binds to
**6380** for the same reason.

### TypeScript configuration constraints

Native type stripping erases types without rewriting code, so any TypeScript
syntax that produces runtime output is forbidden. `erasableSyntaxOnly` catches
most of it at type-check time; Node throws
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at runtime for the rest.

Forbidden syntax, each verified to fail on Node 22.15:

- `enum` **and** `const enum`. Use a `const` object plus a union type. `const
  enum` is not an exception, despite looking erasable.
- Constructor parameter properties. Assign fields explicitly.
- `namespace` and `module` declarations containing runtime code.
- `import x = require(...)` aliases.
- Decorators. V8 rejects these before the stripper sees them, so the error is a
  plain `SyntaxError` rather than a helpful one.

Required, and not optional:

- `package.json` must contain `"type": "module"`. Without it Node falls back to
  module-syntax detection and prints `[MODULE_TYPELESS_PACKAGE_JSON]` on every
  run, making the module system of every file accidental rather than declared.
- Relative imports include the `.ts` extension, because Node resolves the real
  file on disk.
- `import type` for type-only imports. This is enforced by
  `verbatimModuleSyntax`, not by `erasableSyntaxOnly`. Without it the rule is
  unenforced convention.

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],

    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"]
}
```

`allowImportingTsExtensions` requires `noEmit` or `emitDeclarationOnly`. This
project never emits, so `noEmit` satisfies it. TypeScript is a type checker
here and nothing else.

## Commands

First-time setup, in this order:

```
cp .env.example .env
cp .env.example .env.test        then change the database name to urlshortener_test
npm install
npm run db:up
npm run migrate
npm run migrate:test
```

Both `.env` and `.env.test` must exist before any script runs, because
`node --env-file` fails when the file is missing. Verified: a missing file exits
immediately with `node: .env: not found`. They are gitignored, and
`.env.example` is the committed template listing every variable.

### The test database must be created by Compose

The official `postgres` image creates exactly one database, the one named by
`POSTGRES_DB`. Pointing `.env.test` at `urlshortener_test` does not create it,
and `npm run migrate:test` would fail with
`3D000 database "urlshortener_test" does not exist`. Because `pretest` runs
`migrate:test`, that failure also blocks `npm test` entirely.

The Compose service therefore mounts an init script:

```
docker/init/01-create-test-db.sql   ->   /docker-entrypoint-initdb.d/01-create-test-db.sql
```

```sql
create database urlshortener_test;
```

That directory runs **only on first initialisation of the volume**. If the
volume already exists, the script is skipped silently. Recovering from that
requires either `docker compose down -v`, which destroys local data, or creating
the database by hand:

```
docker compose exec postgres createdb -U postgres urlshortener_test
```

Everyday commands:

```
Install:          npm install
Dev server:       npm run dev
Start (prod):     npm start
Typecheck:        npm run typecheck
Test:             npm test
Test (watch):     npm run test:watch
Coverage:         npm run test:coverage
Infra up:         npm run db:up
Infra down:       npm run db:down
Migrate dev DB:   npm run migrate
Migrate test DB:  npm run migrate:test
Migration status: npm run migrate:status
New migration:    npm run migrate:new -- <name>
```

Underlying commands, so that nothing is hidden behind an alias:

```
dev             node --watch --env-file=.env --experimental-strip-types src/index.ts
start           node --env-file-if-exists=.env --experimental-strip-types src/index.ts
typecheck       tsc --noEmit
pretest         npm run migrate:test
test            node --test --env-file=.env.test --experimental-strip-types "tests/**/*.test.ts"
test:coverage   node --test --experimental-test-coverage --env-file=.env.test --experimental-strip-types "tests/**/*.test.ts"
migrate         node --env-file-if-exists=.env --experimental-strip-types scripts/migrate.ts up
migrate:test    node --env-file=.env.test --experimental-strip-types scripts/migrate.ts up
migrate:status  node --env-file=.env --experimental-strip-types scripts/migrate.ts status
migrate:new     node --experimental-strip-types scripts/migrate.ts new
test:watch      node --test --watch --env-file=.env.test --experimental-strip-types "tests/**/*.test.ts"
db:up           docker compose up -d
db:down         docker compose down
```

`pretest` runs automatically before `test`, so the test database is always at
the latest migration. It is idempotent: already-applied migrations are skipped.

`start` and `migrate` use `--env-file-if-exists`, not `--env-file`. The
difference is not cosmetic. In production there is no `.env` file: Render and
every comparable platform inject variables into the process environment, and
`.env` is gitignored so it will never be in the image. `--env-file` on a missing
file is a hard crash before any user code runs, verified as
`node: .env: not found`. `--env-file-if-exists` prints
`.env not found. Continuing without it.` and proceeds on the real environment.
One script then works in both places.

`dev` and `migrate:test` keep the strict `--env-file`, because locally a missing
file is a setup mistake and should fail loudly rather than run against whatever
happens to be in the shell.

The glob is quoted deliberately. npm runs scripts through `cmd.exe` on Windows,
which does not expand globs, so Node expands it itself. The quotes also keep the
script correct on a POSIX shell, which would otherwise expand `**` first.

### Environment variables

`.env.example` lists every variable below. The service refuses to start if any
required variable is missing or fails validation, rather than starting in a
broken state and failing at the first request.

| Variable | Required | Example | Notes |
|---|---|---|---|
| `NODE_ENV` | yes | `development` | One of `development`, `test`, `production` |
| `PORT` | yes | `3000` | Integer, 1 to 65535 |
| `BASE_URL` | yes | `http://localhost:3000` | Used to build `shortUrl`; no trailing slash |
| `DATABASE_URL` | yes | `postgres://postgres:postgres@localhost:5433/urlshortener` | |
| `TRUST_PROXY_HOPS` | yes | `0` | `0` locally, correct hop count when deployed behind a proxy |
| `IP_HASH_SALT` | yes | 32 random bytes, hex | Analytics only; rotating it resets unique-visitor counts |
| `RATE_LIMIT_MAX` | no | `60` | Requests per window, default 60 |
| `RATE_LIMIT_WINDOW_MS` | no | `60000` | Window length, default 60000 |
| `SESSION_TTL_SECONDS` | no | `604800` | Session lifetime, default 7 days |

## Project Structure

```
url-shortener/
├── src/
│   ├── index.ts                     Process entry: config, server start, shutdown
│   ├── server.ts                    Builds the node:http server; never listens
│   ├── config/
│   │   └── env.ts                   Reads and validates process.env once
│   ├── http/
│   │   ├── router.ts                Method plus path matching, params extraction
│   │   ├── context.ts               Request context: params, query, parsed body
│   │   ├── readBody.ts              Streams and size-limits the request body
│   │   ├── respond.ts               json(), redirect(), noContent() helpers
│   │   └── errorHandler.ts          Maps thrown errors to HTTP responses
│   ├── db/
│   │   ├── pool.ts                  Shared pg connection pool
│   │   └── withTransaction.ts       BEGIN, COMMIT, ROLLBACK helper
│   ├── lib/
│   │   ├── AppError.ts              Typed errors carrying a code and a status
│   │   ├── slug.ts                  Base62 generation and the reserved list
│   │   ├── validate.ts              Shared parsing and narrowing primitives
│   │   └── logger.ts                Structured JSON logging to stdout
│   └── modules/
│       ├── links/
│       │   ├── links.routes.ts      Route table for this module
│       │   ├── links.service.ts     Business rules
│       │   ├── links.repository.ts  SQL only
│       │   └── links.schema.ts      Types and parse functions
│       ├── identity/                Same four-file shape
│       └── analytics/               Same four-file shape
├── migrations/
│   ├── 001_create_links.sql
│   └── ...                          Numbered, applied in order, never edited
├── scripts/
│   └── migrate.ts                   Applies pending migrations, records them
├── tests/
│   ├── helpers/
│   │   ├── server.ts                Starts the app on an ephemeral port
│   │   └── db.ts                    Truncation and fixtures
│   ├── unit/                        Pure functions only
│   └── integration/                 One file per module, real HTTP, real database
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── tsconfig.json
├── SPEC.md                          This file
├── SPEC-links.md
├── SPEC-identity.md
├── SPEC-analytics.md
└── tasks/
    ├── plan.md
    └── todo.md
```

### Layering rule

Requests flow in one direction only:

```
route handler → service → repository → database
```

- **Route handler** parses and validates input, then calls a service. It holds
  no business rules and never writes SQL.
- **Service** holds business rules and owns transactions. It never touches the
  `IncomingMessage` or `ServerResponse` objects.
- **Repository** contains SQL and nothing else. It returns plain objects with
  `camelCase` keys.

A route handler that writes SQL, or a service that reads request headers, is a
design bug and should be rejected in review.

### Route precedence rule

The route table is ordered, and matching is first-wins. Every literal route is
registered before the catch-all `GET /:slug`.

This is not a detail. `/:slug` matches a single segment, so without an ordering
rule it swallows `/health`, and a two-segment route such as `/api/links` is only
safe by accident. The reserved-slug list prevents someone from *creating* a link
named `health`; it does nothing about which route matches an incoming request.

The router therefore guarantees two things, and both are unit tested before any
module uses it:

1. A route whose segments are all literal is matched before any route with a
   parameter segment, regardless of registration order.
2. Segment count must match. `/:slug` never matches `/api/links`.

## Code Style

```typescript
// src/modules/links/links.routes.ts
import type { RouteTable } from '../../http/router.ts';
import { json, redirect } from '../../http/respond.ts';
import { parseCreateLinkInput } from './links.schema.ts';
import * as linkService from './links.service.ts';

export const linkRoutes: RouteTable = [
  {
    method: 'POST',
    path: '/api/links',
    async handle(ctx) {
      const input = parseCreateLinkInput(ctx.body);
      const link = await linkService.createLink(input);
      return json(201, toLinkResponse(link));
    },
  },
  {
    method: 'GET',
    path: '/:slug',
    async handle(ctx) {
      const link = await linkService.resolveSlug(ctx.params.slug);
      return redirect(302, link.url);
    },
  },
];
```

```typescript
// src/modules/links/links.service.ts
import { AppError } from '../../lib/AppError.ts';
import { generateSlug, isReservedSlug } from '../../lib/slug.ts';
import * as linkRepository from './links.repository.ts';
import type { CreateLinkInput, Link } from './links.schema.ts';

const MAX_SLUG_ATTEMPTS = 5;

export async function createLink(input: CreateLinkInput): Promise<Link> {
  if (input.customSlug) {
    if (isReservedSlug(input.customSlug)) {
      throw new AppError('SLUG_RESERVED', 'That slug is reserved.', 409);
    }
    return insertOrConflict({ ...input, slug: input.customSlug });
  }

  // The unique index on slug is the real guard. This loop exists only so that a
  // rare collision is retried instead of surfacing to the caller as a 500.
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    try {
      return await linkRepository.insert({ ...input, slug: generateSlug() });
    } catch (error) {
      if (!linkRepository.isUniqueViolation(error)) throw error;
    }
  }

  throw new AppError('SLUG_EXHAUSTED', 'Could not allocate a slug.', 503);
}
```

### Conventions

- Files are named `<module>.<layer>.ts`. Directories are kebab-case.
- Functions and variables are `camelCase`. Types are `PascalCase`. Module-level
  constants are `SCREAMING_SNAKE_CASE`.
- Database columns are `snake_case`. Repositories map them to `camelCase`
  objects at the boundary, so no `snake_case` key leaks above the repository.
- Every exported function has an explicit return type. Inference is fine
  internally.
- No `any`. Accept `unknown` at boundaries and narrow it deliberately.
- `async`/`await` only. No raw `.then()` chains.
- Named exports only.
- Comments explain why, never what. Delete a comment that restates the code.
- Services throw `AppError` with a machine-readable code, a human-readable
  message, and an HTTP status. Only `errorHandler` turns those into responses.

### API conventions

- All JSON endpoints live under `/api`. The redirect route at `/:slug` is the
  single exception, because short links must be short.
- Request and response bodies use `camelCase`.
- Errors always have the shape:
  ```json
  { "error": { "code": "SLUG_TAKEN", "message": "That slug is already in use." } }
  ```
- Validation failures return 400 with a `details` array naming each bad field.
- Lists are paginated with `limit` and `cursor` query parameters and return
  `{ "data": [...], "nextCursor": "..." }`.
- Request bodies larger than 16 KB are rejected with 413 before being parsed.
- Every JSON response sets `Content-Type: application/json; charset=utf-8`.
  The 302 redirect sends a zero-length body.
- `HEAD` is served by the matching `GET` route. `node:http` suppresses the body
  automatically, so the router simply matches `HEAD` against `GET` entries.
- A request whose path matches a route but whose method does not returns `405`
  with an `Allow` header listing the methods that path accepts.

### Status code inventory

Every status this API can return. A code not on this list is a bug.

| Code | When |
|---|---|
| 200 | Successful read |
| 201 | Link created |
| 204 | Link deleted, logout succeeded |
| 302 | Slug resolved, destination in `Location` |
| 400 | Validation failure, including a reserved slug and a malformed cursor |
| 401 | Missing, unknown, or expired session cookie |
| 403 | Authenticated, but the resource belongs to another user |
| 404 | No such slug, or no such path |
| 405 | Path exists, method does not; includes an `Allow` header |
| 409 | Custom slug already exists |
| 410 | Slug exists but has expired |
| 413 | Request body exceeds 16 KB |
| 415 | State-changing request without `Content-Type: application/json` |
| 429 | Rate limit exceeded; includes `Retry-After` |
| 500 | Unexpected error; details logged, never returned |
| 503 | Health check failed, or slug allocation exhausted; includes `Retry-After` |

## Cross-Cutting Requirements

These apply to every module. They are written here because putting them in one
module's spec is how they get forgotten in the others.

### Client IP resolution

The client IP is needed by rate limiting and by analytics. Getting it wrong
breaks both silently, in the same direction: every visitor collapses into one
identity.

`socket.remoteAddress` is correct only when nothing sits in front of the
service. The chosen deployment target, Render, routes traffic through its own
load balancers and through Cloudflare, so in production `socket.remoteAddress`
is an edge address, not a visitor.

Resolution rule:

1. Read `TRUST_PROXY_HOPS` from config. It is `0` locally and set to the real
   number of trusted proxies in production.
2. When it is `0`, use `socket.remoteAddress`.
3. Otherwise split `X-Forwarded-For` on commas and take the entry that is
   `TRUST_PROXY_HOPS` positions from the **right-hand end**.

Taking from the right is the whole point. The left-hand entries are supplied by
the caller and can say anything. Only the rightmost entries were appended by
proxies we trust. Reading the leftmost entry, which is the common mistake, lets
any caller choose their own identity and defeat both the rate limiter and
unique-visitor counting.

Normalisation, because the same client must not occupy two keys:

- Strip the IPv4-mapped IPv6 prefix, so `::ffff:127.0.0.1` becomes `127.0.0.1`.
- Lowercase IPv6 addresses.
- `socket.remoteAddress` can be `undefined` on a destroyed socket. Treat that as
  the literal string `unknown` rather than crashing or skipping the limit.

### Rate limiting

Fixed window, in process memory, keyed by resolved client IP.

- Default limit is `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS`,
  defaulting to 60 per 60 seconds.
- `POST /api/auth/login` and `POST /api/auth/register` get a much lower limit,
  10 per 15 minutes, because each one runs `scrypt`. Without this, login is a
  CPU amplification attack against a single-threaded service.
- `GET /:slug` is **not** rate limited. It is the product, and a shared office
  behind one address must not be able to exhaust it for everybody.
- Exceeding the limit returns `429` in the standard error shape with code
  `RATE_LIMITED`, and a `Retry-After` header in seconds.

Eviction is mandatory, not a refinement. A `Map` keyed by client IP with no
eviction grows without bound, and any distributed scan against a public URL
fills it. That is a memory-exhaustion vector reachable without authentication,
which is worse than the abuse the limiter exists to stop.

- On every write, sweep entries whose window has expired.
- Cap the map at 10,000 entries. When full, drop the oldest.

### Database value types

`pg` returns `bigint` (OID 20) and `numeric` as **JavaScript strings**, on
purpose, because 64-bit integers do not fit in a JavaScript number. This is not
a bug to work around blindly.

- `links.id` is `bigint`, so it arrives as a string.
- `count(*)` in analytics returns `bigint`, so totals arrive as strings. A test
  asserting `assert.equal(total, 3)` fails against `'3'` under `assert/strict`.

Rule: repositories convert at the boundary, in the same place they convert
`snake_case` to `camelCase`. A count is converted with `Number()` because a
count in this system cannot exceed `Number.MAX_SAFE_INTEGER`. An id stays a
string, because it is an identifier and arithmetic is never performed on it.
No global `setTypeParser` call is made, because a global parser hides the
conversion from the place that needs to understand it.

### Server timeouts

A size limit without a time limit stops nothing. A single-process service is
trivially stalled by a client that opens a connection and sends headers one byte
at a time.

- `server.headersTimeout` is 10 seconds.
- `server.requestTimeout` is 20 seconds.
- `server.keepAliveTimeout` is 5 seconds.

### Production environment

The specification is not finished at `docker compose up`. These are the parts
that only exist once the service leaves this machine, and each one is a way the
project fails on the day it is deployed rather than during development.

**Database.** Production Postgres is a Render PostgreSQL instance, not the
Compose container. Two facts about the free tier drive real decisions: it
expires 90 days after creation, which will take the service down with no code
change, and connections require TLS. `pg` does not enable TLS implicitly, so
the pool reads an `ssl` setting from config, on in production and off locally.
The expiry date is recorded in the deployment notes rather than discovered.

**Migrations run as a pre-deploy step, never at container start.** A
hand-written runner executing DDL every time a container boots is a different
and much worse risk than a deliberate step, because a crash-looping container
would retry schema changes indefinitely. Render runs `npm run migrate` as its
pre-deploy command, once per deploy, before any new instance serves traffic.

**Dockerfile requirements.** The image is specified, not left to improvisation:

- Base image `node:22.15-alpine`, pinned to the same minor version as `.nvmrc`,
  because the type-stripping flag is version-sensitive.
- `npm ci --omit=dev`, so `typescript` and the type packages stay out of the
  image. Type checking happens in CI, never at runtime.
- Runs as the image's non-root `node` user.
- `NODE_ENV=production`.
- `CMD ["node", "--env-file-if-exists=.env", "--experimental-strip-types", "src/index.ts"]`.
  The source is copied in and stripped at runtime; there is no build output,
  because this project never emits.
- A `HEALTHCHECK` that calls `/health`, which is the entire reason that endpoint
  checks the database rather than just returning `ok`.

**Free-tier behaviour that changes how the service behaves.** Render free
instances spin down when idle. The first request after a spin-down pays a cold
start, and the redirect route is the hot path, so that cold start is visible to
whoever clicked the link. The in-memory rate limiter also resets on every wake,
not only on deploy. Both are accepted, and both are recorded here so they are
not later mistaken for bugs.

### Graceful shutdown

On `SIGTERM` or `SIGINT`, in this exact order:

1. Stop accepting new connections with `server.close()`. This does **not** wait
   for in-flight requests, which is why the next step exists.
2. Wait for in-flight requests to finish, with a 10 second deadline.
3. Drain pending analytics writes, with a 5 second deadline. See
   `SPEC-analytics.md`.
4. Close the database pool.
5. Exit.

Draining before in-flight requests finish is wrong, because those requests are
still adding new writes after the drain has returned. Every deadline is bounded,
because an unbounded wait against a hung database means the platform sends
`SIGKILL` and discards everything anyway.

## Testing Strategy

- **Framework:** `node:test` with `node:assert/strict`. No test framework is
  installed.
- **HTTP driver:** each integration test starts the real server on port 0, reads
  the assigned port, and calls it with global `fetch`. Redirects are tested with
  `redirect: 'manual'` so the status code itself can be asserted.
- **Database:** tests run against a real Postgres database named
  `urlshortener_test` in the same Compose container. Migrations run once before
  the suite. Each test file truncates the tables it touches in `beforeEach`.
  The database is never mocked, because a mocked query proves nothing about SQL.
- **Location:** `tests/unit/` for pure functions, `tests/integration/` for one
  file per module.
- **Levels:**
  - Unit tests for pure logic: slug generation and alphabet, reserved-word
    matching, expiry comparison, every parse function, cookie parsing and
  serialising, and client IP resolution.
  - Integration tests for every endpoint, exercising the full route, service,
    repository, and database path.
  - No browser or end-to-end tests. There is no frontend.
- **Coverage bar:** every endpoint has at least one test for the success path
  and one for its primary failure path. A percentage target is deliberately not
  set, because a percentage can be met without testing behaviour.
- **Must be tested even though it is tempting to skip:** the redirect status
  code, expiry returning 410, slug conflict returning 409, an oversized body
  returning 413, an unknown or expired session returning 401, a forged
  left-hand `X-Forwarded-For` entry being ignored, and one user touching
  another user's link returning 403.

## Boundaries

### Always

- Validate every request body, query parameter, and path parameter before it
  reaches a service.
- Enforce data integrity in the database as well as in code: `NOT NULL`, unique
  indexes, foreign keys, and check constraints.
- Write a new numbered migration for every schema change. Never edit a migration
  that has already been applied.
- Return the correct HTTP status code. `200` is not an acceptable default for a
  created resource or for a failure.
- Run `npm run typecheck && npm test` before every commit.
- Read secrets from the environment only, through `config/env.ts`, and refuse to
  start when one is missing or invalid.
- Set a size limit and a timeout on anything read from the network.
- Convert `bigint` and `numeric` values at the repository boundary, never above
  it.
- Resolve the client IP through the single shared helper, never by reading
  `socket.remoteAddress` or `X-Forwarded-For` at a call site.

### Ask first

- Adding any npm dependency at all. The default answer is no, and the
  justification must name the Node built-in that was tried first.
- Changing the database schema in a way that drops or renames a column.
- Changing an existing endpoint's request or response shape.
- Introducing a new architectural layer, or a queue, worker, or scheduler.
- Changing the deployment target or the CI configuration.

### Never

- Commit a `.env` file, a real secret, or a production connection string.
- Log a password, a password hash, a session id, or a `Cookie` header.
- Store a password in any form other than a salted `scrypt` hash.
- Concatenate user input into SQL. Parameterised queries only.
- Compare a secret, a hash, or a signature with `===`. Use `timingSafeEqual`,
  after checking that both buffers are the same length, because
  `timingSafeEqual` throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` when they are
  not.
- Use `scryptSync`. It blocks the single event loop for roughly 100 milliseconds
  per call, so a burst of sign-in attempts stalls every redirect. The async form
  runs on the libuv thread pool and is the only acceptable one.
- Trust the leftmost entry of `X-Forwarded-For`. It is supplied by the caller.
- Invent a cryptographic construction. Use `node:crypto` primitives as intended.
- Delete or skip a failing test to make the suite green.
- Write business logic inside a route handler or a migration.
- Follow a user-supplied URL from the server, for previewing or any other
  reason. That is server-side request forgery waiting to happen.

## Success Criteria

The project is complete when all of the following are demonstrably true.

1. From a clean checkout, the documented first-time setup sequence, ending in
   `npm run dev`, produces a running API on `http://localhost:3000`.
2. `GET /health` returns `200` with `{"status":"ok","database":"ok"}`.
3. `POST /api/links` with a valid URL returns `201` and a slug of 7 base62
   characters.
4. `GET /:slug` returns `302` with the original URL in the `Location` header.
5. An unknown slug returns `404`; an expired slug returns `410`.
6. A duplicate custom slug returns `409`; a reserved slug returns `400`.
7. An invalid or non-HTTP URL returns `400` with a field-level error.
8. A request body over 16 KB returns `413`, and a unit test on `readBody`
   asserts that the stream was destroyed after at most 16 KB was read.
9. `HEAD /:slug` returns the same status and headers as `GET /:slug`, with no
   body.
10. Exceeding the rate limit returns `429` with a `Retry-After` header.
11. A registered user can sign in, receive a session cookie, and list only their
    own links.
12. A request carrying an unknown or expired session id returns `401`.
13. Deleting a link owned by another user returns `403`.
14. After `drainPendingWrites()`, `GET /api/links/:slug/stats` returns a total
    and a per-day breakdown equal to the number of redirects performed in the
    test. In production the count is a lower bound, because the write is not
    awaited.
15. `npm test` passes, with every endpoint covered for success and primary
    failure.
16. `npm run typecheck` passes with zero errors.
17. `package.json` lists exactly one production dependency, `pg`.
18. The service runs in a container built from the repository `Dockerfile`,
    as a non-root user, with `HEALTHCHECK` reporting healthy.
19. The service is deployed and reachable at a public URL, with
    `TRUST_PROXY_HOPS` set correctly for that platform, verified by confirming
    that two different clients produce two different rate-limit buckets.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `--experimental-strip-types` is experimental in 22.15 | Warning on every run; behaviour could change | Pin the Node version in `.nvmrc` and in the Dockerfile. `tsc --noEmit` still guards types. Falling back to a `tsc` build is a contained change to two npm scripts. |
| Hand-written router misses an edge case | Subtle routing or parsing bugs | Route matching and body reading each get direct unit tests before any module uses them. |
| Session id guessable or leaked | Account takeover | 32 bytes from `randomBytes`, looked up in a table, revocable server-side. No signature verification exists to get wrong, which is why JWT was rejected |
| Client IP resolved incorrectly behind a proxy | Rate limiter becomes one global bucket; unique visitors collapse to one | Single shared resolver, `TRUST_PROXY_HOPS` from config, counted from the right-hand end. A deployment success criterion verifies two clients produce two buckets |
| Rate-limit map grows without bound | Memory exhaustion from unauthenticated traffic | Sweep expired entries on write, hard cap of 10,000 entries |
| `scrypt` parameters raised past the default `maxmem` | `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` at runtime | Cost parameters and `maxmem` specified together, and stored inside the hash string so they can change later |
| Deploy overlaps two instances briefly | Rate limit doubles during a rollout | Accepted. The window is short and the limit is not a security control. Recorded so it is not mistaken for a bug |
| `--env-file` on a platform with no `.env` file | Service crashes on boot before any code runs | `start` and `migrate` use `--env-file-if-exists`. Local scripts keep the strict form so setup mistakes still fail loudly |
| Render free PostgreSQL expires after 90 days | Deployed service goes down with no code change | Expiry date recorded in the deployment notes, not discovered |
| Migrations run at container start | A crash-looping container retries DDL indefinitely | Migrations run as a pre-deploy command, once per deploy |
| Hand-written validation drifts per module | Inconsistent error responses | All parse functions build on shared primitives in `lib/validate.ts` and produce one error shape. |
| No dependency means more code to own | Slower delivery | Accepted deliberately. Learning the primitives is the objective. |

## Resolved Decisions

Every question that was previously open has been answered. They are kept here,
with their reasoning, because the module specs cite them as settled and a
document that lists a decision as both open and already-made cannot be used to
settle an argument.

1. **Redirect status code is `302`.** `301` is cached permanently by browsers,
   which makes a mistyped destination unfixable and hides every subsequent click
   from the server. `307` would behave identically here, since the method is
   `GET` either way, so there is no reason to prefer it.
2. **Rate limiting uses an in-memory `Map`.** Correct because the service runs
   as one process. It resets on deploy, which is acceptable for a limiter that
   is not a security control. Eviction and limits are specified under
   Cross-Cutting Requirements. Redis is not added.
3. **Anonymous links stay ownerless.** When `identity` lands, existing links
   keep a null `owner_id` forever. There is no claim flow, because a claim flow
   needs a proof of ownership that was never issued.
4. **Analytics stores a salted hash of the client IP, never the raw value.**
   The salt is `IP_HASH_SALT`. It exists only to count unique visitors. Rotating
   it resets those counts, which is recorded in `SPEC-analytics.md`.
5. **Deployment target is Render.** This is what forces `TRUST_PROXY_HOPS` to be
   non-zero in production, because Render fronts every service with its own load
   balancers and with Cloudflare. Fly.io and Railway are equivalent and have the
   same proxy consideration.

## Decision Record: Single Process, No Load Balancer

Adding a load balancer was raised and declined. The decision is recorded here
because several later choices depend on it, and reversing it silently would
leave those choices quietly wrong.

### What this decision permits

- Rate limiting lives in process memory. One process means one counter.
- Any future cache may live in process memory for the same reason.
- `node:cluster` is not used. The process is single-threaded and single-process.

It does **not** permit reading the client IP from `socket.remoteAddress`. That
was the original wording and it was wrong. The decision removes load balancers
*of our own*; it does nothing about the platform's. Render routes every request
through its own load balancers and through Cloudflare, so the socket address in
production belongs to an edge node. Client IP resolution is specified under
Cross-Cutting Requirements and applies regardless of this decision.

### What must change first if this is ever reversed

These are the failure modes that a second instance introduces. Each one is
silent, which is why they are written down rather than left to be discovered.

1. **Rate limiting stops working as specified.** Two instances keep two
   independent counters, so the effective limit doubles. A shared store, most
   likely Redis, becomes mandatory, and that breaks the single-dependency rule.
2. **The client IP becomes wrong.** Behind a proxy, `socket.remoteAddress` is
   the proxy. The real client sits in `X-Forwarded-For`, which is
   caller-supplied and trivially spoofed unless the number of trusted proxy hops
   is fixed and enforced. Analytics hashes the visitor IP, so a wrong or
   spoofable value corrupts unique-visitor counts and the rate limiter together.
3. **Rolling restarts drop in-flight requests.** Graceful shutdown becomes
   mandatory: stop accepting connections, drain what is open, close the pool,
   then exit.
4. **`/health` gains real consequences.** It stops being informational and
   starts deciding whether an instance receives traffic.
5. **The deployment target changes.** The Render free tier gives one instance
   and no control over balancing. Multi-instance means a VPS running Compose, or
   a paid plan.

### If revisited, the goal is

Learning the failure modes above by causing them deliberately: killing an
instance mid-request, watching the rate limit double, observing the wrong IP
reach analytics, and then fixing each one. The deliverable is a written record
of what broke and why, not a throughput number.

The natural place for that work is a separate phase after `analytics` is
complete, using Nginx in front of two application containers. It is not part of
this spec.
