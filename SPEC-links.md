# Spec: links module

Module id: `links`
Depends on: nothing
Status: reviewed and corrected; ready to implement
Parent spec: `SPEC.md`

## Objective

Turn a long URL into a short slug, and send anyone who visits that slug to the
original destination.

This module is the whole product in miniature. It must be usable and deployable
on its own, before accounts or analytics exist.

## Scope

In scope:

- Creating a link, with a generated slug or a caller-supplied custom slug.
- Optional expiry, after which the link stops resolving.
- Resolving a slug to a redirect.
- Reading a single link's metadata.
- Listing links with cursor pagination.
- Deleting a link.

Out of scope for this module:

- Who owns a link. Ownership arrives with `identity`.
- How many times a link was opened. Counting arrives with `analytics`.
- Editing a link's destination after creation. Deliberately excluded, because a
  mutable destination makes a short link untrustworthy.

## Data Model

### Table: `links`

| Column       | Type          | Constraints                               | Notes                             |
| ------------ | ------------- | ----------------------------------------- | --------------------------------- |
| `id`         | `bigint`      | primary key, generated always as identity | Internal only, never exposed      |
| `slug`       | `text`        | not null, unique                          | The public identifier             |
| `url`        | `text`        | not null                                  | The destination                   |
| `expires_at` | `timestamptz` | nullable                                  | Null means the link never expires |
| `created_at` | `timestamptz` | not null, default `now()`                 |                                   |

Constraints and indexes:

- `unique (slug)` — this is the real guard against collisions, not application
  code. The retry loop in the service exists only to avoid surfacing a rare
  collision as a server error.
- `check (char_length(slug) between 3 and 32)`
- `check (slug ~ '^[A-Za-z0-9_-]+$')`
- `check (char_length(url) <= 2048)`
- `check (expires_at is null or expires_at > created_at)`
- The unique index on `slug` also serves the redirect lookup.
- No second index is needed. Listing orders by `id desc`, which the primary key
  index already serves. This is a direct consequence of the cursor decision
  below. Ordering by `created_at` instead would require
  `create index on links (created_at desc, id desc)`.

`id` is a surrogate key kept for future foreign keys from `identity` and
`analytics`, and it is also the pagination cursor. The public API addresses
links by `slug` only.

`pg` returns `bigint` as a JavaScript **string**, deliberately, because 64-bit
integers do not fit in a JavaScript number. `links.id` therefore arrives as a
string and stays one. It is an identifier, and no arithmetic is ever performed
on it. See Cross-Cutting Requirements in `SPEC.md`.

The repository detects a unique-constraint violation by SQLSTATE **`23505`**.
`isUniqueViolation` must also check `error.constraint`, not the code alone,
because `identity` will add `unique (email)` to `users`, and a bare code check
would misreport a duplicate email as a slug collision. Two neighbouring codes
the same repository will meet: `23514` for a CHECK violation, and `23503` for a
foreign-key violation once `analytics` lands.

### Slug generation

- Alphabet is base62: `A-Z`, `a-z`, `0-9`.
- Length is 7 characters, giving roughly 3.5 × 10¹² possibilities. Collisions
  are rare enough that a five-attempt retry loop is sufficient.
- Bytes come from `crypto.randomBytes`. Modulo bias is avoided by rejecting
  bytes at or above the largest multiple of 62 below 256, which is 248.
- Custom slugs accept `A-Z`, `a-z`, `0-9`, `-`, and `_`, between 3 and 32
  characters. They are matched case-sensitively, because URLs are.

### Reserved slugs

These are rejected as custom slugs so that they can never shadow a real route:

`api`, `health`, `admin`, `login`, `logout`, `register`, `signup`, `signin`,
`static`, `assets`, `_next`, `docs`, `status`.

`favicon.ico` and `robots.txt` are deliberately absent. The CHECK constraint
excludes `.` from the slug charset, so neither string can ever be inserted, and
listing them would create entries no test could ever exercise.

The list lives in `src/lib/slug.ts` and is compared case-insensitively.

## URL Validation

A destination URL is accepted only when all of these hold:

1. It parses with `new URL(value)`.
2. Its protocol is exactly `http:` or `https:`. This rejects `javascript:`,
   `data:`, `file:`, and every other scheme.
3. It has a host.
4. Its serialised length is 2048 characters or fewer.

The server never fetches the URL. No previewing, no reachability check, no
metadata scraping. Fetching a user-supplied URL from the server is server-side
request forgery, and the fact that it would be a nice feature does not change
that.

Private and loopback hosts are **not** blocked at this stage, because the server
never makes a request to them. If a preview feature is ever added, that decision
must be revisited first.

## Endpoints

### `POST /api/links`

Creates a link.

Request body:

```json
{
  "url": "https://example.com/some/very/long/path",
  "customSlug": "my-link",
  "expiresAt": "2026-12-31T23:59:59.000Z"
}
```

- `url` is required.
- `customSlug` is optional.
- `expiresAt` is optional, must be a valid ISO 8601 instant, and must be in the
  future.

A reserved slug returns 400, not 409. It is knowable without touching the
database and conflicts with no existing resource, which makes it an input
validation failure. `409` is reserved for a genuine conflict with a row that
already exists, so `SLUG_TAKEN` is the only 409 in this module.

The destination may not point at this service's own `BASE_URL` host. A link
that redirects to another slug on the same host creates a redirect chain, and
one pointing at its own short URL creates a loop.

Response `201`:

```json
{
  "slug": "aB3xK9p",
  "shortUrl": "http://localhost:3000/aB3xK9p",
  "url": "https://example.com/some/very/long/path",
  "expiresAt": null,
  "createdAt": "2026-09-09T10:00:00.000Z"
}
```

`shortUrl` is built from the `BASE_URL` environment variable so that the value
is correct in both local and deployed environments.

Failures:

| Status | Code                | Cause                                                         |
| ------ | ------------------- | ------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED` | Missing or malformed field, bad protocol, expiry in the past  |
| 409    | `SLUG_TAKEN`        | The custom slug already exists                                |
| 400    | `SLUG_RESERVED`     | The custom slug is on the reserved list                       |
| 413    | `BODY_TOO_LARGE`    | Request body exceeds 16 KB                                    |
| 429    | `RATE_LIMITED`      | Rate limit exceeded; carries `Retry-After`                    |
| 503    | `SLUG_EXHAUSTED`    | Five generated slugs collided in a row; carries `Retry-After` |

### `GET /:slug`

Resolves a slug and redirects. This is the only route outside `/api`.

`HEAD /:slug` is served by this same route and returns identical status and
headers with no body. `node:http` suppresses the body for `HEAD` automatically,
so this is purely a matter of the router matching `HEAD` against `GET` entries.
Without it, every link checker, chat unfurler, and uptime monitor gets a 404.

- `302` with the destination in the `Location` header, when the link exists and
  has not expired.
- `404` with code `LINK_NOT_FOUND` when no such slug exists.
- `410` with code `LINK_EXPIRED` when the link exists but `expires_at` has
  passed.

The response carries `Cache-Control: no-store`. A cached redirect would make
click counting wrong once `analytics` lands, and would make a deleted link keep
working in the visitor's browser.

`302` is used rather than `301` because `301` is cached permanently by browsers.
A permanently cached mistake is unfixable, and it hides every subsequent click
from the server.

Expiry is evaluated in SQL, comparing `expires_at` against `now()`, so that the
database clock is the single source of truth. The row is still fetched when
expired, so that 410 can be distinguished from 404.

This route is **not** rate limited. It is the product, and one shared office
behind a single address must not be able to exhaust it for everyone there.

### `GET /api/links/:slug`

Returns one link's metadata, in the same shape as the create response.

- `200` when found.
- `404` with code `LINK_NOT_FOUND` otherwise.

An expired link is still returned here, with its `expiresAt` in the past. This
endpoint describes the link; it does not follow it.

### `GET /api/links`

Lists links, newest first, with cursor pagination.

Query parameters:

- `limit`, optional, an integer between 1 and 100, defaulting to 20.
- `cursor`, optional, an opaque string returned by the previous page.

Response `200`:

```json
{
  "data": [
    {
      "slug": "aB3xK9p",
      "url": "https://example.com",
      "expiresAt": null,
      "createdAt": "2026-09-09T10:00:00.000Z"
    }
  ],
  "nextCursor": "MTcyNTg3ODQwMDAwMHwxMjM"
}
```

`nextCursor` is null on the last page.

The cursor is base64url of the last row's `id`, and the query uses keyset
pagination:

```sql
where id < $cursorId
order by id desc
limit $limit
```

Keyset pagination is used rather than `OFFSET` because `OFFSET` scans and skips
every preceding row, and because rows inserted during paging shift the offset
and cause items to be seen twice or missed.

The cursor is the `id` alone, not a timestamp. `id` is
`generated always as identity`, so it is already monotonic and unique. That
makes `order by id desc` a total order on its own, and lets the primary key
index serve the query with no second index.

An earlier draft encoded `created_at` as epoch milliseconds. That was wrong.
`timestamptz` holds microsecond precision, so truncating to milliseconds makes a
row created at `T+0.001200s` fail the comparison against a cursor at
`T+0.001000s`, and that row is **silently skipped**. The integration test below
would not have caught it, because five links are very unlikely to land inside
the same millisecond. Ordering by insertion sequence removes the encoding
problem rather than working around it.

An unparseable cursor returns `400` with code `INVALID_CURSOR`.

Once `identity` lands, this endpoint is scoped to the authenticated user, and
the correct index becomes `(owner_id, id desc)`.

**Blocking gate.** Until `identity` lands, this endpoint returns every link
every visitor has ever created, with full destination URLs, to anyone who asks.
That is an unauthenticated data disclosure of the same class as the open delete
below, and it must be closed before any public deployment.

### `DELETE /api/links/:slug`

- `204` with no body when the link existed and was deleted.
- `404` with code `LINK_NOT_FOUND` when it did not.

Deletion is a hard delete in this module. Once `analytics` lands, the click
events table references `links.id`, and that foreign key uses
`on delete cascade`.

**Blocking gate.** Until `identity` lands, this endpoint is unauthenticated,
which means anyone can delete any link. That is acceptable only in local
development.

Both this route and `GET /api/links` sit behind an environment flag,
`ENABLE_UNAUTHENTICATED_LINK_ADMIN`, which defaults to off. Integration tests
set it on, so every test in this spec keeps passing unchanged, while a deployed
build has both routes disabled and returns 404 for them. This keeps the tested
artifact and the deployed artifact reconcilable, instead of deleting endpoints
at deploy time and shipping something the tests never covered.

Once `analytics` lands, `click_events` references `links.id` with
`on delete cascade`, so deleting a link destroys its entire click history
irreversibly. That is a second reason this route must not be open.

### `GET /health`

- `200` with `{"status":"ok","database":"ok"}` when `select 1` succeeds.
- `503` with `{"status":"degraded","database":"down"}` when it does not.

The database check runs on every call, with a 2 second timeout. A health check
that does not touch its dependencies reports that the process is alive, which is
not the question anyone is asking.

## Error Response Shape

Every failure uses one shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request body is invalid.",
    "details": [{ "field": "url", "message": "Must be an http or https URL." }]
  }
}
```

`details` is present only on validation failures.

## Verification

Unit tests:

- Generated slugs are 7 characters and use only the base62 alphabet.
- Slug generation over many samples produces a roughly uniform distribution
  across the alphabet, proving modulo bias was handled.
- Reserved slugs are rejected case-insensitively.
- URL validation accepts `http` and `https`, and rejects `javascript:`,
  `data:`, `file:`, a missing host, malformed input, and an over-length URL.
- Custom slug validation enforces the character set and the length bounds.
- Expiry parsing rejects a past instant and a malformed date.
- Cursor encoding round-trips, and a corrupted cursor is rejected.
- A URL whose host matches `BASE_URL` is rejected, so a link cannot redirect to
  itself or to another slug on the same host.
- Route matching prefers a literal route over `/:slug`, so `/health` resolves to
  the health route and never to the redirect route.
- `/:slug` does not match a two-segment path, so `/api/links` never reaches the
  redirect route.

Integration tests, each against a real server and a real database:

- Creating a link returns 201 and a 7-character slug.
- Creating with a custom slug returns that exact slug.
- Creating with a duplicate custom slug returns 409 `SLUG_TAKEN`.
- Creating with a reserved slug returns 409 `SLUG_RESERVED`.
- Creating with a `javascript:` URL returns 400 with a field-level detail.
- Creating with a 20 KB body returns 413.
- Following a slug returns 302 and the exact destination in `Location`.
- Following an unknown slug returns 404.
- Following an expired slug returns 410, and the same slug returns 200 from
  `GET /api/links/:slug`.
- Listing with `limit=2` across five links returns two pages and then a null
  `nextCursor`, with no duplicated and no missing rows.
- Listing with a malformed cursor returns 400.
- Deleting returns 204, and the slug then returns 404 on both routes.
- `GET /health` returns 200 with `database: "ok"`.
- `HEAD /:slug` returns 302 with the same `Location` header as `GET`, and an
  empty body.
- `PUT /api/links` returns 405 with an `Allow` header.
- Exceeding the rate limit on `POST /api/links` returns 429 with `Retry-After`,
  while `GET /:slug` stays reachable.
- A duplicate custom slug surfaces as SQLSTATE `23505` and is translated to 409,
  never to 500.
- With `ENABLE_UNAUTHENTICATED_LINK_ADMIN` unset, `GET /api/links` and
  `DELETE /api/links/:slug` both return 404.

## Definition of Done

- Every endpoint above is implemented and returns the documented status codes.
- Every test listed under Verification passes.
- `npm run typecheck` passes with zero errors.
- Migration `001_create_links.sql` applies to an empty database and creates
  every constraint listed in the data model.
- Both unauthenticated admin routes are disabled unless
  `ENABLE_UNAUTHENTICATED_LINK_ADMIN` is set.
- `package.json` still lists `pg` as the only production dependency.
