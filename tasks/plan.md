# Implementation Plan: URL Shortener API

> **Historical.** This plan was followed and completed. It is kept as a record of
> how the work was sequenced, not as a description of the service. See
> `docs/request-lifecycle.md` and `docs/adr/` for the current picture.

Derived from `SPEC.md`, `SPEC-links.md`, `SPEC-identity.md`, `SPEC-analytics.md`.
Task list: `tasks/todo.md`.

## Strategy

Build in thin vertical slices. Each slice ends with something runnable and a
test that proves it. No slice leaves the repository in a state where the server
does not start.

The build order follows the capability map: `links`, then `identity`, then
`analytics`. Within `links`, the pure primitives come first, then the HTTP
foundation, then the endpoints.

Three rules govern ordering:

1. **Nothing is built before the thing it depends on.** The dependency graph
   below is the authority, not perceived importance.
2. **Every risky hand-written primitive gets a direct test before anything uses
   it.** The slug generator, the validators, the router, the body reader, the
   cookie parser, and the client-IP resolver are all hand-written and all
   testable in isolation.
3. **Pure logic is never blocked behind infrastructure.** A function with no
   database and no HTTP dependency can be built and tested on day one, before
   Docker is even running.

## Dependency Graph

```
scaffold (package.json, tsconfig, .nvmrc, .env.example)
   │
   ├──> lib: slug, validate, client-ip        [pure; no DB, no HTTP]
   │
   ├──> http core (router, readBody, respond, cookies, errorHandler)
   │        │
   │        └──> /health (static)
   │
   └──> docker-compose + test DB init
            │
            └──> db pool + migration runner + 001_create_links
                     │
                     └──> /health (database-backed)
                              │
   lib ───────────────────────┤
   http core ─────────────────┤
                              ├──> POST /api/links
                              │        │
                              │        ├──> GET and HEAD /:slug   (redirect, expiry)
                              │        ├──> GET /api/links/:slug
                              │        ├──> GET /api/links        (gated)
                              │        └──> DELETE /api/links/:slug (gated)
                              │
                              └──> rate limiting, timeouts, graceful shutdown
                                       │
                                       └──> Dockerfile, deploy    [MODULE 1 DONE]
                                                │
                                                └──> SPEC-identity.md completed
                                                         │
                                                         └──> identity module
                                                                  │
                                                                  └──> SPEC-analytics.md completed
                                                                           │
                                                                           └──> analytics module
```

`lib` hangs directly off scaffold, not off the database. Slug generation and
validation are pure functions. An earlier version of this graph sequenced them
behind the database-backed health check, which contradicted rule 2 above: the
slug generator is the single most testable risky primitive in the project and
should be proven before anything depends on it.

## Phases

### Phase A — Foundation

Scaffold, pure libraries, HTTP core, database, health check.

Ends when: `npm run dev` starts a server, `GET /health` returns 200 with
`database: "ok"`, and `npm test` passes with unit tests green for the slug
generator, the validators, the client-IP resolver, the router precedence rule,
and the body size limit.

No feature code exists yet. This is deliberate. Every later slice sits on this,
and debugging a routing bug while simultaneously debugging a SQL bug is what
makes people abandon projects.

Migration `001_create_links.sql` belongs to this phase, not to Phase B, because
the database-backed health check needs a schema to connect to. `SPEC-links.md`
lists it under that module's definition of done; both statements are true, and
this plan owns the sequencing.

### Phase B — links module

Slug and validation are already done in Phase A. This phase is the five
endpoints, in dependency order: create, then redirect, then read one, then list,
then delete.

Ends when: every item in the `SPEC-links.md` verification list passes.

### Phase C — Hardening and deployment

Rate limiting with eviction, server timeouts, graceful shutdown, Dockerfile,
production database, deployment.

**Blocking gate, and it covers two routes, not one.** `GET /api/links` and
`DELETE /api/links/:slug` are both unauthenticated until Phase D. The delete
route lets anyone destroy any link. The list route discloses every link and
every destination URL to anyone who asks. Both ship behind
`ENABLE_UNAUTHENTICATED_LINK_ADMIN`, which integration tests set and deployment
does not.

Gating by flag rather than by deletion is what keeps the tested artifact and the
deployed artifact the same artifact. Deleting the routes at deploy time would
mean shipping something the test suite never exercised.

### Phase D — identity module

Complete `SPEC-identity.md` first, resolving its three remaining open questions.
Then build it: `users` and `sessions` tables, `scrypt` hashing with the
specified parameters, cookie handling, the authorisation middleware, and the
`owner_id` column added to `links`.

Closing the Phase C gate is part of this phase, not a follow-up.

### Phase E — analytics module

Complete `SPEC-analytics.md` first, resolving its three remaining open
questions. Then build it.

## Risks and Mitigations

| Risk                                                 | Where it bites                                                          | Mitigation                                                                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Hand-written router matches the wrong route          | `/health` swallowed by `/:slug`                                         | Literal-before-parameter rule plus segment-count matching, unit tested in Phase A before any module registers a route                          |
| `HEAD` requests fall through to 404                  | Link checkers and chat unfurlers see a broken link                      | Router matches `HEAD` against `GET` entries; covered by a Phase B test                                                                         |
| `--experimental-strip-types` behaviour changes       | Every command                                                           | Node version pinned in `.nvmrc` and in the Dockerfile. Falling back to a `tsc` build touches two npm scripts                                   |
| `--env-file` on a platform with no `.env`            | Service crashes on boot in production                                   | `start` and `migrate` use `--env-file-if-exists`; local scripts keep the strict form                                                           |
| Test database never created                          | `npm test` cannot run at all                                            | Compose init script creates `urlshortener_test`, with the first-initialisation caveat written down                                             |
| Request body read without a limit                    | Memory exhaustion from one request                                      | 16 KB cap enforced while streaming, unit tested on `readBody` directly rather than only through HTTP                                           |
| Migration runner is hand-written                     | Corrupt schema state                                                    | Runner records applied filenames in a table and runs each file in a transaction. Migrations run as a pre-deploy step, never at container start |
| Client IP resolved wrongly behind the platform proxy | Rate limiter becomes one global bucket; unique visitors collapse to one | Single shared resolver, `TRUST_PROXY_HOPS` from config, counted from the right-hand end. Verified as a deployment success criterion            |
| Rate-limit map grows without bound                   | Memory exhaustion from unauthenticated traffic                          | Sweep on write, hard cap of 10,000 entries                                                                                                     |
| `scrypt` cost raised past default `maxmem`           | `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` at sign-in                           | Parameters and `maxmem` specified together; parameters stored inside the hash string                                                           |
| Fire-and-forget click write rejects unhandled        | Process exit under load                                                 | Mandatory `.catch()`, synchronous registration into the pending set, loop-until-empty drain, bounded deadlines                                 |
| Scope creep into load balancing, Redis, queues       | Project never finishes                                                  | Recorded as declined in `SPEC.md`. Any reversal edits the decision record first                                                                |

## Verification Checkpoints

A checkpoint is a hard stop. Do not begin the next phase until it passes.

| After phase | Must be true                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A           | Server starts. `/health` returns 200 with `database: "ok"`. Unit tests pass for slug, validators, client IP, router precedence, and body limit. `npm run typecheck` clean                                                       |
| B           | Every `SPEC-links.md` verification item passes. `pg` is still the only production dependency                                                                                                                                    |
| C           | Image builds and runs as non-root with a healthy `HEALTHCHECK`. Public URL responds. `TRUST_PROXY_HOPS` verified by two clients producing two rate-limit buckets. Both unauthenticated admin routes return 404 without the flag |
| D           | Cookie is `HttpOnly` and `Secure`, named `__Host-session` in production. Unknown and expired sessions return 401. Sign-out deletes the row and the old cookie fails. Cross-user delete returns 403                              |
| E           | After `drainPendingWrites()`, the click count equals the number of redirects performed in the test                                                                                                                              |

## What Is Explicitly Not in This Plan

Load balancing, clustering, Redis, message queues, schedulers, workers,
microservices, JWTs, and a frontend. Each was considered and declined in
`SPEC.md`. Adding any of them means editing the spec first, not the code.
