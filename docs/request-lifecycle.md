# One request, socket to response

This is the path every request takes, in order, naming the file that owns each
step. It exists because that knowledge is currently spread across eight files as
excellent comments that nobody reads in sequence.

Read this once and the rest of the codebase stops being a maze. Nothing here is
a rule; the rules live in `SPEC.md` and `docs/adr/`. This is the map.

## The shape of it

```
socket
  │
  ├─ 1. accept and time-bound          server.ts
  ├─ 2. resolve the correlation id     lib/requestId.ts
  ├─ 3. match a route                  http/router.ts
  ├─ 4. resolve the client address     lib/clientIp.ts
  ├─ 5. count against a rate limit     http/sharedRateLimit.ts, http/rateLimit.ts
  ├─ 6. read and size-limit the body   http/readBody.ts
  ├─ 7. build the request context      http/context.ts
  ├─ 8. run the handler                modules/<name>/<name>.routes.ts
  │        └─ business rules           modules/<name>/<name>.service.ts
  │              └─ SQL                modules/<name>/<name>.repository.ts
  ├─ 9. convert any thrown value       http/errorHandler.ts
  └─ 10. write the response            http/respond.ts
```

Steps 2 through 10 all live in one function, `handle`, in `src/server.ts`. Only
the timeouts in step 1 sit outside it, on the server object. `handle` is worth
reading top to bottom once.

## 1. Accept, and put a clock on it

`src/server.ts` builds the server and sets three timeouts: ten seconds for
headers, twenty for the whole request, five for keep-alive. A size limit without
a time limit stops nothing, because a client that sends headers one byte at a
time occupies this single-process service indefinitely.

The server is built here and never started here. `src/index.ts` is the only
thing that calls `listen`, which is what lets a test start the real server on an
ephemeral port.

## 2. Resolve the correlation id

`src/lib/requestId.ts` returns an id for this request, before anything can fail.
A safe inbound `X-Request-Id` is adopted so a trace started at a proxy continues;
anything malformed or oversized is replaced with a fresh UUID.

Doing this first is deliberate. The `404`, the `405`, and the failure caught
while writing a response all happen before a handler exists, and every one of
them still carries an id.

See [ADR 0009](adr/0009-thread-the-request-id-explicitly.md) for why the id is
passed down rather than stored in ambient context.

## 3. Match a route

`src/http/router.ts` matches method and path. Two rules decide everything:

- A literal segment beats a parameter at the first position where they differ.
- Segment counts must match exactly.

Together those are why `/health` is not swallowed by the catch-all `/:slug`, and
why `/api/links` is not either, regardless of the order routes were registered
in. The link module registers `/:slug` first on purpose, to prove it.

Three outcomes: matched, method-not-allowed, or not-found. The last two are
answered immediately, with the correlation id, and nothing further runs.

`GET` routes also serve `HEAD`.

## 4. Resolve the client address

`src/lib/clientIp.ts` reads `X-Forwarded-For` and the socket address and applies
the configured number of trusted proxy hops.

This happens exactly once per request and the result is passed down. Rate
limiting and unique-visitor counting both need it, and resolving it twice is how
two features that must agree on who a caller is start disagreeing.

## 5. Count against a rate limit

Two limiters, and which one applies is decided by the path:

- `/api/` paths go to `src/http/sharedRateLimit.ts`, a counter in Postgres, so
  the limit is global across instances. Credential paths get a far stricter
  window. If the counter cannot be read, the request is refused with `503`: the
  limiter fails closed.
- The health endpoints are exempt from both, and checked first.
- Everything else goes to `src/http/rateLimit.ts`, a counter in process memory,
  at 600 per minute per address.

The health exemption is a boundary match, not a prefix: `/health` and anything
under `/health/`, but never `/healthy`, which is one segment and therefore a
slug. Without that boundary, anyone could mint themselves an unmetered route by
choosing the right slug.

The split between the two limiters is a decision, not an unfinished migration.
[ADR 0007](adr/0007-shared-rate-limit-counter-in-postgres.md) explains it.

## 6. Read the body

Only for `POST`, `PUT`, and `PATCH`. `src/http/readBody.ts` streams the body and
stops at 16 KB, answering `413`.

Body reading happens after routing, which is why posting to a `GET`-only route
returns `405` and never reaches the size limit at all.

## 7. Build the request context

`src/http/context.ts` defines what a handler is allowed to see: method, path,
route parameters, query, headers, the resolved client address, the correlation
id, and the parsed body.

Deliberately narrow. A handler never touches Node's `IncomingMessage` or
`ServerResponse`. That is what keeps handlers testable as plain functions and
keeps the one place that writes to a socket small enough to reason about. A
handler that needs something else gets it added to this type, visibly.

## 8. Run the handler

Route handlers live in `src/modules/<name>/<name>.routes.ts` and do HTTP only:
read the context, call a service, shape a response. Authentication happens here,
by resolving a session before anything else.

Below that:

- `<name>.service.ts` holds the business rules. Services throw `AppError` and
  never touch a request or a response, which is what lets them be called from a
  test, a script, or a future background job with no server involved.
- `<name>.repository.ts` holds the SQL, and nothing else does.
- `<name>.schema.ts` holds the types and the parse functions.

Parsing returns a result object; failures throw. That split is intentional: a
malformed field is an expected answer, and a broken invariant is not.

The redirect handler is the one place that starts work it does not wait for. It
fires the click write and returns. The visitor never pays for analytics, and a
slow database cannot turn a working redirect into a failure. Every click count
is therefore a lower bound.

## 9. Convert whatever was thrown

`src/http/errorHandler.ts` is the only place that decides what a caller sees when
something fails.

The rule it enforces: an `AppError` was thrown deliberately and its message is
meant for the caller. Anything else is a bug, and its message may name an
internal path, a query, or a value the caller must not see. Those are logged in
full, with the correlation id, and answered with a generic `500`.

Client errors are not logged. They are ordinary traffic and would drown the log.

## 10. Write the response

`src/http/respond.ts` is the only module that touches a `ServerResponse`. It
sets the security headers on every response, adds `Content-Type` and
`Content-Length` when there is a body, echoes the correlation id, and handles
the three cases where a body would be wrong: a `HEAD` request, a status defined
as bodyless, and a handler that returned none.

Afterwards, `server.ts` drains anything the client is still sending. An
oversized body stops being read at the limit, which leaves the stream paused,
and leaving it that way makes the client report a connection reset instead of
reading the status it was just sent.

## Where to look next

| Question                         | File                        |
| -------------------------------- | --------------------------- |
| Why is any of this the way it is | `SPEC.md`, `docs/adr/`      |
| What does each endpoint return   | `openapi.json`              |
| What could an attacker do        | `THREAT-MODEL.md`           |
| How is this tested               | `SPEC.md`, Testing Strategy |
