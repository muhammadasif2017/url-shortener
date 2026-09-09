# Threat Model

Scope: the HTTP service in `src/`, its PostgreSQL database, and the container that runs
them. Written against the code as it stands, not against the specs. Every finding below
names the file and the line of code that produces it.

The purpose of this document is to record where untrusted data enters the system, what an
attacker would want from it, and which of those paths are currently unguarded. It is a
design artifact first. Three of its findings have since been fixed in the code, and each
is marked where it appears.

## 1. Trust boundaries

Data crosses into the service at six points. Everything on the untrusted side of each
boundary is attacker-controlled, regardless of how ordinary it looks.

| # | Boundary | Untrusted input | Entry point |
|---|---|---|---|
| B1 | Public HTTP request line | Method, path, query string, slug segment | `src/server.ts` |
| B2 | Request headers | `Cookie`, `X-Forwarded-For`, `Referer`, `User-Agent`, `Content-Type`, `Content-Length` | `src/server.ts`, `src/http/auth.ts` |
| B3 | Request body | Registration and login credentials, link creation payload | `src/http/readBody.ts` |
| B4 | Stored destination URL, replayed outward | The `Location` header of every redirect | `src/modules/links/links.routes.ts` |
| B5 | Database connection | Rows returned by PostgreSQL, and the TLS session carrying them | `src/db/pool.ts` |
| B6 | Process environment | Every setting, including the IP hash salt and the proxy hop count | `src/config/env.ts` |

Note on B4: the service stores an attacker-supplied URL and later emits it into a response
header for a different victim. The destination is untrusted on the way in and untrusted on
the way out. This is the boundary most easily mistaken for internal state.

There is no LLM in this system, no file upload, and no server-side fetch of a
user-supplied URL, so there is no SSRF surface and no prompt-injection surface.

## 2. Assets

Ranked by what an attacker gains from reaching them.

1. **Session identifiers**, stored in plaintext in the `sessions` table. A session id is a
   bearer token for one account, valid for seven days by default.
2. **Password hashes** in the `users` table. scrypt at N=32768, so offline cracking is
   expensive but not free.
3. **The redirect mapping itself.** The ability to create a link on a domain the victim
   trusts is the product, and is also the abuse.
4. **Click history**, which is personal data: a salted hash of every visitor's IP address
   alongside the referring page and user agent.
5. **The IP hash salt.** With the salt, every stored `ip_hash` reverses to a raw IPv4
   address by brute force over four billion candidates.
6. **Service availability.** The redirect path performs a database write per request.

## 3. STRIDE over the boundaries

### Spoofing

`resolveClientIp` in `src/lib/clientIp.ts` reads the client address from
`X-Forwarded-For` when `TRUST_PROXY_HOPS` is above zero, counting from the right-hand
end. That is the correct construction, and `TRUST_PROXY_HOPS` is required with no default,
so a deployment cannot drift into trusting the header by accident. If the value is ever set
higher than the number of proxies actually in front of the service, a client can inject
entries and choose its own rate-limit bucket and its own analytics identity.

Session identifiers are 32 bytes from `randomBytes`, so they are not guessable. A fresh
session is minted on every login and register, so session fixation does not apply.

### Tampering

Every SQL statement in `links.repository.ts`, `identity.repository.ts` and
`analytics.repository.ts` is parameterized. No query string is assembled by concatenation
anywhere in the codebase. Injection through B3 is closed.

B5 was open. `src/db/pool.ts` set `ssl: { rejectUnauthorized: false }` whenever
`DATABASE_SSL` was on, so the connection was encrypted but the server certificate was never
verified: anything able to intercept the route to the database could present its own
certificate and read and alter every row in transit, password hashes and session
identifiers included. Turning TLS on and then declining to check who is on the other end
buys very little over plaintext.

**Fixed.** The certificate is verified, and the provider's own authority is supplied
through `DATABASE_CA_CERT`, which is the piece whose absence made the unverified setting
look necessary. A deployment that enables TLS against a provider outside Node's default
trust store must now supply that bundle or the connection is refused. Note that the test
database speaks plaintext, so the verifying path has no automated coverage and is exercised
first on a real deployment.

### Repudiation

There is no audit log of security-relevant events. Successful and failed logins, session
creation, and link deletion leave no record. After an account compromise there is nothing
to reconstruct what happened. `src/lib/logger.ts` is used for errors only.

### Information disclosure

Registration answers a duplicate address with a distinct `EMAIL_TAKEN` 409, while login
answers everything with the same 401. The register path therefore confirms whether any
given address holds an account. This is the usual tradeoff and may be accepted
deliberately, but it should be an explicit decision rather than an accident of two
different error paths.

`GET /api/links/:slug` requires no session and performs no ownership check, so anyone
holding a slug can read that link's destination, expiry and creation time. Since the
redirect already discloses the destination, the marginal leak is the metadata.

Session identifiers are stored in the database exactly as they appear in the cookie. Read
access to the `sessions` table, through a backup, a log, a replica or an injection in some
future query, is immediate account takeover for every live session. Storing a hash of the
identifier and looking sessions up by that hash would remove the table as a credential
store.

Error responses are generic and stack traces never reach the client
(`src/http/errorHandler.ts`).

### Denial of service

The rate limiter in `src/http/rateLimit.ts` keeps its counters in a process-local `Map`.
Behind more than one instance the effective limit is the configured maximum multiplied by
the instance count, and the ten-attempt credential limit that the login route depends on
becomes ten per instance. This is the single most consequential gap in the current
controls, because it silently weakens a control that appears to be present.

The same limiter could also be made to forget a victim on demand. When a key was new or
its window had expired, `check` swept expired entries and then, if the map was still at
capacity, deleted `windows.keys().next()`. A `Map` iterates in insertion order, so that
evicted the oldest *inserted* entry rather than the oldest *expiring* one. `server.ts`
passes no `maxEntries`, so both limiters sit at the ten-thousand default. An attacker
sending roughly ten thousand requests from distinct source addresses to `/api/auth/login`
evicted the window belonging to an account under attack, and the victim's next attempt took
the fresh-window branch and started again from one. Every request in that flood was itself
allowed, because each one opened a new window, which made the flood cheap.

Evicting by soonest expiry would not have helped. With a single window length the oldest
window is also the one expiring first, so it is still the victim's.

**Fixed, in the sense of priced rather than closed.** Keys that have reached the limit are
held in a second map and are evicted only when no unlimited key is left, and when the
protected map itself has to give something up, it drops the window expiring soonest rather
than the one standing longest. Clearing a protected entry now costs `max` requests per key
across the whole cap instead of one, and every one of those requests is refused.

The residual is worth stating plainly: an attacker prepared to spend `maxEntries × max`
refused requests still fills the protected map and reaches a real window. At the shipped
defaults that is one hundred thousand requests against the credential paths rather than ten
thousand. What removes the class rather than raising its price is the shared counter store
in finding 2, which remains open. Two regression tests in `tests/unit/rateLimit.test.ts`
cover both eviction paths.

`isRateLimited` in `src/server.ts` applies the limiter only to paths beginning with
`/api/`. The redirect route is therefore unmetered, and each redirect issues an
unawaited insert into `click_events`. An attacker with one valid slug can drive unbounded
write volume against the database from a single host. The write tracker in
`analytics.writes.ts` sheds above ten thousand pending writes, which protects process
memory but not the database.

Body size is capped at 16 KB and the server sets `headersTimeout`, `requestTimeout` and
`keepAliveTimeout`, so slow-header and oversized-body attacks are covered.

Password brute force is limited per address only. Ten attempts per fifteen minutes from
each of a thousand hosts is ten thousand attempts against one account, and nothing counts
attempts per account or locks one out.

### Elevation of privilege

Authorization is checked where it matters. `deleteLink` compares `link.ownerId` against the
session user, and both analytics routes go through `requireOwnedLink`. Link listing is
scoped to the owner in SQL.

`POST /api/links` accepts anonymous callers by design: `optionalUserId` returns undefined
when no session is present and the link is stored with a null owner. That is not privilege
escalation, but it is the abuse case in section 4.

## 4. Abuse cases

Three, in the order an attacker would reach for them.

**Phishing laundering.** Anyone, unauthenticated, can mint a link on this domain pointing
at any http or https destination. There is no reputation check, no destination denylist,
and no owner to hold responsible. This is the defining abuse of a URL shortener, and the
service currently has no answer to it beyond a general per-address rate limit. Requiring a
session to create a link makes abuse attributable and is the cheapest available control.

**Redirect header smuggling.** `parseDestinationUrl` in `src/lib/validate.ts` validated a
parsed `URL` and then returned the caller's original string rather than `parsed.href`. The
WHATWG parser strips tab, carriage return and newline while parsing, so a string containing
them validated successfully and was stored verbatim, then handed to `response.writeHead` as
a `Location` value. Node rejects control characters in header values, so the outcome was a
500 on every visit rather than a split response, but the link was permanently broken and
the real mistake was persisting a string in a form nothing had checked.

**Fixed.** The parser's serialization is what is returned and stored, and the length cap is
applied to that serialization as well, since normalization can lengthen a URL past the
column constraint. The visible change is that `http://example.com` is stored as
`http://example.com/`.

**Visitor de-anonymization.** `ip_hash` is a single unsalted-per-row SHA-256 over the
global salt and the address. SHA-256 is fast, and the IPv4 space is small, so anyone who
obtains both the salt and the table recovers every visitor's raw address. The salt is
correctly required to be at least 32 characters and is never logged, but the two assets
should not share a blast radius. Keeping the salt in a separate secret store from the
database, and rotating it on a schedule, is what limits the damage.

## 5. Findings, ranked

| # | Severity | Finding | Location |
|---|---|---|---|
| 1 | High | ~~Database TLS does not verify the server certificate~~ **Fixed.** `rejectUnauthorized` is now true, with the provider bundle read from `DATABASE_CA_CERT` | `src/db/pool.ts` |
| 2 | High | Rate limiter is process-local, so limits multiply by instance count | `src/http/rateLimit.ts` |
| 2b | High | ~~Limiter evicts by insertion order, so a flood clears a victim's credential window~~ **Mitigated.** Keys at the limit are protected, and the cost of clearing one rises from one request to `max`. Not closed: see finding 2 | `src/http/rateLimit.ts` |
| 3 | High | Anonymous link creation with no destination reputation control | `src/modules/links/links.routes.ts` |
| 4 | Medium | Redirect route is unmetered and writes to the database per request | `src/server.ts` |
| 5 | Medium | Session identifiers stored in plaintext in the database | `src/modules/identity/identity.repository.ts` |
| 6 | Medium | ~~Destination URL is persisted unnormalized, from the raw input string~~ **Fixed.** `parseDestinationUrl` returns `parsed.href`, and the length cap is applied to it | `src/lib/validate.ts` |
| 7 | Medium | No per-account throttle or lockout, only per-address | `src/server.ts` |
| 8 | Medium | Click history has no retention limit and no deletion path | `migrations/004_create_click_events.sql` |
| 9 | Low | Registration discloses whether an address is already registered | `src/modules/identity/identity.routes.ts` |
| 10 | Low | No HSTS or `Referrer-Policy`, and no cache directive on authenticated JSON | `src/http/respond.ts` |
| 11 | Low | No audit log for authentication or deletion events | `src/lib/logger.ts` |
| 12 | Low | `GET /api/links/:slug` exposes link metadata without a session | `src/modules/links/links.routes.ts` |

## 6. What is already right

Recorded so that a later change does not undo it by accident.

- Every query is parameterized, everywhere.
- scrypt at N=32768 with a per-user salt, compared with `timingSafeEqual`, and a dummy hash
  on the missing-user path so login timing does not disclose account existence.
- `__Host-` cookie prefix in production, with `HttpOnly`, `Secure` and `SameSite=Lax`.
- JSON content type required on state-changing routes, which combined with `SameSite=Lax`
  closes cross-site request forgery.
- Request body capped at 16 KB, with header and request timeouts set explicitly.
- Slugs drawn from `randomBytes` with rejection sampling, so the alphabet stays uniform.
- Raw visitor addresses are never stored, and the salt is never logged.
- The container runs as a non-root user, installs with `--ignore-scripts`, and pins its
  base image to a minor version.
- `.env` is ignored by git and no secret is committed.

## 7. Privacy position

Click events are personal data. `ip_hash` is a pseudonym rather than an anonymization,
because it reverses given the salt, and `referrer` records pages the visitor came from.

Three things are missing and all three are schema and code, not policy:

- No retention limit. Rows accumulate for the life of the deployment.
- No deletion path for a visitor. Deleting a link cascades its clicks away, which is the
  link owner's erasure story, not the visitor's.
- No stated collection purpose recorded anywhere outside the migration comment.

## 8. Suggested order of work

Findings 1, 2b and 6 are done, and are struck through in the table above. What
follows is what remains, with the completed steps kept in place so the ordering
still reads as one sequence.


1. ~~Verify the database certificate (finding 1).~~ Done. The flag alone was not enough:
   most managed PostgreSQL providers use a chain outside Node's default trust store, so
   `DATABASE_CA_CERT` carries their published bundle. A deployment that turns TLS on
   without supplying it now fails to connect rather than connecting unverified, which is
   the intended direction but is a deployment step someone has to take.
2. ~~Fix the eviction order in the limiter (finding 2b).~~ Done, and it raises the price of
   the attack rather than ending it. Still outstanding, and now carrying the rest of that
   exposure: move the counters to a shared store, or state single-instance deployment
   explicitly in the README (finding 2).
3. ~~Return `parsed.href` from `parseDestinationUrl` (finding 6).~~ Done.
4. Decide on anonymous link creation (finding 3). This is a product decision, not a
   patch.
5. Meter the redirect path (finding 4).
6. Hash session identifiers at rest (finding 5).
7. Retention job and response headers (findings 8 and 10).
