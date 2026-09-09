# Spec: identity module

Module id: `identity`
Depends on: `links`
Status: **placeholder — full spec written at the start of Phase D**
Parent spec: `SPEC.md`

This module is second in the build order. The detailed endpoint contracts are
written after `links` is finished and reviewed, because specifying them now
means guessing at answers that building `links` will supply.

What is recorded here are the decisions already taken, because each one has
consequences that reach into `links` and `analytics`, and leaving them implicit
is how they get quietly reversed.

## Objective (provisional)

Give links an owner, so that a person can sign in, see only their own links, and
be the only one able to delete them.

## Scope (provisional)

In scope:

- Registration with an email address and a password.
- Sign-in that establishes a session.
- Sign-out that ends it.
- A route returning the current user.
- A nullable `owner_id` column added to `links`, with a foreign key to `users`.
- Authorisation on link listing and deletion.

Out of scope:

- Password reset and email verification. Both need an email provider, which is
  another dependency and another system to learn.
- OAuth and social sign-in. Worth doing later as a separate module.
- Roles and permissions. There is one role: a user who owns links.

## Decision: opaque session id, not JWT

**Resolved.** The cookie carries 32 random bytes from `crypto.randomBytes`,
base64url encoded. That value is a lookup key into a `sessions` table. It is not
signed, it is not structured, and it carries no claims.

### Why JWT was rejected

A hand-written JWT verifier has to independently get right: pinning the
algorithm, rejecting `none`, rejecting algorithm confusion between HMAC and RSA,
verifying `exp` and `nbf`, rejecting non-canonical base64url encodings, and
rejecting duplicate JSON keys. Each of those has a history of real
vulnerabilities, and each needs its own test.

An opaque identifier has no signature, so none of those failure modes exist.
Either the row is in the table and unexpired, or the request is unauthenticated.
That is one code path and one test.

It also delivers server-side revocation, which was previously listed as out of
scope precisely because JWTs make it hard. Sign-out becomes a real thing, not a
polite suggestion to the client. And it teaches more database work, which is the
stated objective of the project.

### The trade-off, stated honestly

Every authenticated request costs one indexed lookup by primary key. That is the
price of revocation, and at this scale it is not a real cost. A stateless token
avoids the lookup, which matters when authentication is distributed across many
services. This service is one process.

### Table: `sessions`

| Column | Type | Constraints |
|---|---|---|
| `id` | `text` | primary key; base64url of 32 random bytes |
| `user_id` | `bigint` | not null, references `users(id)` on delete cascade |
| `expires_at` | `timestamptz` | not null |
| `created_at` | `timestamptz` | not null, default `now()` |

- Expiry is checked in SQL against `now()`, so the database clock is the single
  source of truth, exactly as link expiry already is.
- Sign-out deletes the row.
- Expired rows are deleted opportunistically on lookup. No scheduler is added,
  because a scheduler is a subsystem and this is one `delete` statement.
- `SESSION_TTL_SECONDS` defaults to seven days.

## Decision: the session id travels in an HTTP-only cookie

**Resolved.** Never in the response body, never in `localStorage`.

```
Set-Cookie: __Host-session=<id>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<seconds>
```

`HttpOnly` makes the value unreadable to JavaScript, so a cross-site scripting
bug cannot exfiltrate the session. Anything returned in a response body has to
be stored by the client, and every storage location a browser offers is readable
by any script on the page.

### The `__Host-` prefix

The cookie already satisfies every precondition the prefix requires: `Secure`,
`Path=/`, and no `Domain` attribute. The prefix makes the browser enforce those,
which means no sibling subdomain can overwrite the session cookie. That closes
the same-site-but-not-same-origin hole described below, at no cost.

The prefix requires `Secure`, and `Secure` cookies are not set over plain HTTP.
So the cookie name is environment-dependent: `__Host-session` in production,
`session` locally with `Secure` omitted. This is stated explicitly because a
name that silently changes between environments is otherwise a debugging trap.

### Cross-site request forgery

The browser attaches this cookie to every request to the origin automatically.
That is the entire benefit and also the entire problem.

`SameSite=Lax` blocks the cookie on cross-site `POST`, `PATCH`, and `DELETE`.
That covers this API, because no state-changing request here is a top-level
navigation.

The second layer is a content-type check: state-changing endpoints reject any
request whose media type is not `application/json`, returning `415`.

**The reasoning behind that check, stated correctly.** An earlier draft claimed
an HTML form cannot send `application/json` "without a preflight". That was
wrong, and the wrong version hides which mechanism is actually load-bearing.

- An HTML form cannot trigger a CORS preflight at all. Form submission is not a
  CORS-governed fetch. The reason a form cannot mount this attack is simpler:
  the HTML specification restricts a form's `enctype` to
  `application/x-www-form-urlencoded`, `multipart/form-data`, and `text/plain`.
  `application/json` is not expressible.
- Preflight is what stops `fetch` and `XMLHttpRequest`. Setting
  `Content-Type: application/json` makes the request non-simple, so the browser
  sends an `OPTIONS` preflight first. No CORS is configured, so that preflight
  goes unanswered and the real request is never sent.

**The consequence that matters.** The second protection is a property of having
no CORS configuration, not of the content-type check itself. The day an explicit
allowed origin is added with `Access-Control-Allow-Credentials: true`, preflight
starts succeeding and the content-type check stops blocking anything on its own.
At that point a real CSRF token or an `Origin` allowlist becomes mandatory. This
is written down because it is a trap that springs later, when a frontend is
added and nobody remembers why the check was there.

Two further limits, so the defence is not overestimated:

- `SameSite` is same-**site**, not same-**origin**. Any host sharing the
  registrable domain can forge requests carrying the cookie. On a
  `*.onrender.com` URL this happens to be safe, because `onrender.com` is on the
  Public Suffix List and sibling subdomains are therefore cross-site. That is
  luck, not design, and it disappears on a custom domain with other subdomains.
  The `__Host-` prefix is what turns that luck into a guarantee.
- `SameSite` is enforced by browsers only. It does nothing for a non-browser
  client.

**Writing the check correctly.** Parse the media type and ignore parameters,
because `application/json; charset=utf-8` is legitimate and fails a naive string
equality test. A missing `Content-Type` header is rejected, not treated as
acceptable.

### Sign-out

`POST /api/auth/logout` deletes the session row and sends a `Set-Cookie` that
clears the cookie.

The clearing cookie must repeat `Path=/`, the `__Host-` prefix, and every other
attribute that scopes the original. A deletion cookie only matches when its
scope matches exactly. Omitting `Path=/` leaves the cookie in place while the
endpoint reports success, which is a silent authentication failure.

Because the row is deleted server-side, a captured cookie is dead immediately.
This is the concrete benefit of choosing an opaque id over a JWT.

## Decision: password hashing parameters

**Resolved.** `node:crypto` `scrypt`, async form only.

| Parameter | Value |
|---|---|
| `N` (cost) | 32768 |
| `r` (block size) | 8 |
| `p` (parallelisation) | 1 |
| `keylen` | 32 bytes |
| salt | 16 bytes from `randomBytes`, unique per user |
| `maxmem` | 64 MiB, set explicitly |

### Why each of those is written down

- **`maxmem` is not optional at `N=32768`.** `N=32768, r=8` needs roughly 33 MiB,
  and Node's default `maxmem` is 32 MiB. Exceeding it throws
  `ERR_CRYPTO_INVALID_SCRYPT_PARAMS: memory limit exceeded`. Verified. The
  parameters and `maxmem` must therefore be chosen together, or raising the cost
  later breaks sign-in at runtime rather than at review.
- **The async form is mandatory.** `scryptSync` blocks for roughly 100
  milliseconds per call on the single event loop that also serves every
  redirect. A modest burst of sign-in attempts stalls the whole service. The
  callback form runs on the libuv thread pool. This is why sign-in also carries
  a much stricter rate limit, specified in `SPEC.md`.
- **`timingSafeEqual` throws on a length mismatch**, with
  `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`. Verified. It is not a drop-in for `===`
  on values of unknown length. Compare lengths first and return a failed
  verification, so a malformed stored hash produces a 401 rather than a 500.

### Stored format

Parameters are stored alongside the hash, in a single text column:

```
scrypt$N=32768,r=8,p=1$<salt base64url>$<hash base64url>
```

Without this, the cost parameters can never be raised, because there would be no
way to verify a password hashed under the old ones. With it, verification reads
the parameters from the stored string, and a later increase can re-hash on next
successful sign-in.

### Password policy

- Minimum 12 characters.
- Maximum 128 characters. The maximum matters more than it looks: `scrypt` on an
  unbounded input is a CPU amplification vector against a single-threaded
  service.
- No composition rules. Length is what matters, and rules push people toward
  predictable substitutions.

## Decision: anonymous links stay ownerless

**Resolved.** Links created before this module exists keep a null `owner_id`
forever. There is no claim flow, because a claim flow needs a proof of ownership
that was never issued.

Consequence for `links`: `owner_id` is nullable, and the listing query must
distinguish "belongs to nobody" from "belongs to someone else". Once this module
lands, the listing index becomes `(owner_id, id desc)`.

## Verification (provisional)

Beyond the usual success and failure paths:

- Sign-in sets a cookie carrying `HttpOnly`, `Secure`, and `SameSite=Lax`, named
  `__Host-session` when `NODE_ENV` is production.
- A request with no cookie returns 401.
- A request with an unknown session id returns 401.
- A request with an expired session returns 401, and the row is gone afterwards.
- Sign-out clears the cookie, deletes the row, and the old cookie no longer
  authenticates. The test issues the follow-up request from a path other than
  `/`, so a missing `Path` attribute on the clearing cookie is actually caught.
- A state-changing request with `Content-Type: text/plain` returns 415.
- A state-changing request with `application/json; charset=utf-8` is accepted.
- A state-changing request with no `Content-Type` returns 415.
- Deleting another user's link returns 403, not 404.
- Cookie parsing handles several cookies in one header, and a value containing
  `=`.
- Registering an existing email surfaces SQLSTATE `23505` on the `users` email
  constraint and returns 409, not a slug-collision error.

## Open questions to resolve before writing the full spec

1. Session lifetime beyond the seven-day default, and whether activity extends
   it or the expiry is absolute.
2. Whether unauthenticated link creation survives once accounts exist.
3. Whether an email address is verified in any way before it can be used.
