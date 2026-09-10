# Threat Model

Scope: the HTTP service in `src/`, its PostgreSQL database, and the container that runs
them. Written against the code as it stands, not against the specs. Every finding below
names the file and the line of code that produces it.

The purpose of this document is to record where untrusted data enters the system, what an
attacker would want from it, and which of those paths are currently unguarded. It is a
design artifact first. All twelve of its findings have since been fixed, across three
passes, and each is marked where it appears. Four of the fixes change the public API, which
is recorded here and in the README rather than left for a client to discover.

## 1. Trust boundaries

Data crosses into the service at six points. Everything on the untrusted side of each
boundary is attacker-controlled, regardless of how ordinary it looks.

| #   | Boundary                                 | Untrusted input                                                                        | Entry point                         |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------- |
| B1  | Public HTTP request line                 | Method, path, query string, slug segment                                               | `src/server.ts`                     |
| B2  | Request headers                          | `Cookie`, `X-Forwarded-For`, `Referer`, `User-Agent`, `Content-Type`, `Content-Length` | `src/server.ts`, `src/http/auth.ts` |
| B3  | Request body                             | Registration and login credentials, link creation payload                              | `src/http/readBody.ts`              |
| B4  | Stored destination URL, replayed outward | The `Location` header of every redirect                                                | `src/modules/links/links.routes.ts` |
| B5  | Database connection                      | Rows returned by PostgreSQL, and the TLS session carrying them                         | `src/db/pool.ts`                    |
| B6  | Process environment                      | Every setting, including the IP hash salt and the proxy hop count                      | `src/config/env.ts`                 |

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

There was no audit log of security-relevant events. Successful and failed sign-ins, session
creation, and link deletion left no record, so after an account compromise there was
nothing to reconstruct.

**Fixed.** `src/lib/audit.ts` records registration, sign-in success and failure, throttling,
sign-out, link creation and link deletion. The client address is hashed with the same salt
the analytics tables use, which keeps two events from one client visibly related without
making the log the one place raw addresses are kept.

### Information disclosure

Registration answered a duplicate address with a distinct `EMAIL_TAKEN` 409 while login
answered everything with the same 401, so the register path confirmed whether any given
address held an account, one request at a time.

**Fixed, and it cost a feature.** Registration now answers 202 with one body whichever case
it hit, and issues no session at all. The session was the harder half: a response carrying
a cookie says the address was free and one without says it was taken, whatever the status
code claims, so the only way to answer identically was to stop signing people in at
registration. Creating an account is two requests now. Both paths run one scrypt before the
insert is attempted, so the response time does not answer the question either.

The proper fix is a mail channel, where registration says "check your email" and the
message differs rather than the response. There is no mailer in this service, and adding
one to close a low finding would be the larger change.

`GET /api/links/:slug` required no session and performed no ownership check, so anyone
holding a slug could read that link's expiry and creation time. The destination was never
the leak, since following the link discloses it.

**Fixed.** Owner only. A link belonging to someone else is refused with 403 rather than
404, matching deletion: hiding the link's existence would be pointless when the redirect
route confirms it to anyone, and two different answers to one question is the real
inconsistency.

Session identifiers were stored exactly as they appear in the cookie. Read access to the
`sessions` table, through a backup, a log, a replica or an injection in some future query,
was immediate account takeover for every live session.

**Fixed.** The table holds a SHA-256 digest and lookups hash before comparing, so the row
is no longer a credential. Unsalted and unstretched is correct here and is the opposite of
the password decision: the input is 32 bytes of CSPRNG output, so there is no guessable
candidate for a work factor to slow and no enumerable space for a salt to defend.

Error responses are generic and stack traces never reach the client
(`src/http/errorHandler.ts`).

### Denial of service

The rate limiter in `src/http/rateLimit.ts` kept its counters in a process-local `Map`.
Behind more than one instance the effective limit was the configured maximum multiplied by
the instance count, and the ten-attempt credential limit the login route depends on became
ten per instance. A control that silently scales with the deployment is worse than none,
because the code still reads as though it is there.

**Fixed.** API limits count in `rate_limit_windows`, shared by every instance. The
in-process limiter now serves the redirect path only, where per-instance counting is the
right trade and is argued in `isSharedRateLimited`.

The same limiter could also be made to forget a victim on demand. When a key was new or
its window had expired, `check` swept expired entries and then, if the map was still at
capacity, deleted `windows.keys().next()`. A `Map` iterates in insertion order, so that
evicted the oldest _inserted_ entry rather than the oldest _expiring_ one. `server.ts`
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

The redirect route was unmetered, and each redirect issues an unawaited insert into
`click_events`. An attacker with one valid slug could drive unbounded write volume at the
database from a single host. The write tracker in `analytics.writes.ts` sheds above ten
thousand pending writes, which protects process memory but not the database.

**Fixed.** Six hundred redirects per minute per address, which is far above anything a
person following links produces and far below what a write flood needs.

Body size is capped at 16 KB and the server sets `headersTimeout`, `requestTimeout` and
`keepAliveTimeout`, so slow-header and oversized-body attacks are covered.

Password brute force was limited per address only. Ten attempts per fifteen minutes from
each of a thousand hosts is ten thousand attempts against one account, and nothing counted
attempts per account or locked one out.

**Fixed.** Twenty failed sign-ins per account per hour, in the shared counter so the budget
is the account's and not one instance's. Only failures count, and only after verification
has actually failed, so a working password never spends the budget. That ordering is the
design: a bucket that counted every attempt would let anyone who knows an address lock its
owner out, turning the control into the attack.

### Elevation of privilege

Authorization is checked where it matters. `deleteLink` compares `link.ownerId` against the
session user, and both analytics routes go through `requireOwnedLink`. Link listing is
scoped to the owner in SQL.

`POST /api/links` accepted anonymous callers, storing the link with a null owner. That was
never privilege escalation, but it was the abuse case in section 4.

**Fixed.** Creating a link requires a session. Following one never will: a redirect that
demanded a session would be useless to everyone the link was sent to.

## 4. Abuse cases

Three, in the order an attacker would reach for them.

**Phishing laundering.** Anyone, unauthenticated, could mint a link on this domain pointing
at any http or https destination, with no reputation check, no destination denylist, and no
owner to hold responsible. This is the defining abuse of a URL shortener.

**Partly fixed.** Creating a link now requires a session, so every link has an owner and
abuse is attributable: an account can be suspended and everything it made can be found.
Attribution is not prevention. There is still no reputation check on destinations, and
registration is open, so the cost of an attributable identity is one email address. A
denylist or a reputation feed is the next control, and it is a larger piece of work than
anything in this pass.

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

**Visitor de-anonymization.** (Bounded by retention, not removed.) `ip_hash` is a single unsalted-per-row SHA-256 over the
global salt and the address. SHA-256 is fast, and the IPv4 space is small, so anyone who
obtains both the salt and the table recovers every visitor's raw address. The salt is
correctly required to be at least 32 characters and is never logged, but the two assets
should not share a blast radius. Keeping the salt in a separate secret store from the
database, and rotating it on a schedule, is what limits the damage.

## 5. Findings, ranked

| #   | Severity | Finding                                                                                                                                                                                      | Location                                       |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | High     | ~~Database TLS does not verify the server certificate~~ **Fixed.** `rejectUnauthorized` is now true, with the provider bundle read from `DATABASE_CA_CERT`                                   | `src/db/pool.ts`                               |
| 2   | High     | ~~Rate limiter is process-local, so limits multiply by instance count~~ **Fixed.** API counters live in `rate_limit_windows` and are shared by every instance                                | `src/http/sharedRateLimit.ts`                  |
| 2b  | High     | ~~Limiter evicts by insertion order, so a flood clears a victim's credential window~~ **Fixed.** Keys at the limit are protected, and the credential paths no longer use this limiter at all | `src/http/rateLimit.ts`                        |
| 3   | High     | ~~Anonymous link creation with no destination reputation control~~ **Fixed.** Creating a link requires a session, so every link has an owner                                                 | `src/modules/links/links.routes.ts`            |
| 4   | Medium   | ~~Redirect route is unmetered and writes to the database per request~~ **Fixed.** 600 redirects per minute per address, counted in process                                                   | `src/server.ts`                                |
| 5   | Medium   | ~~Session identifiers stored in plaintext in the database~~ **Fixed.** The table holds a SHA-256 digest; the identifier exists only in the cookie                                            | `src/lib/sessionId.ts`                         |
| 6   | Medium   | ~~Destination URL is persisted unnormalized, from the raw input string~~ **Fixed.** `parseDestinationUrl` returns `parsed.href`, and the length cap is applied to it                         | `src/lib/validate.ts`                          |
| 7   | Medium   | ~~No per-account throttle or lockout, only per-address~~ **Fixed.** 20 failed sign-ins per account per hour, counting failures only                                                          | `src/modules/identity/identity.routes.ts`      |
| 8   | Medium   | ~~Click history has no retention limit and no deletion path~~ **Fixed.** `CLICK_RETENTION_DAYS`, swept daily, default 90                                                                     | `src/modules/analytics/analytics.retention.ts` |
| 9   | Low      | ~~Registration discloses whether an address is already registered~~ **Fixed.** Register always answers 202 with one body and no session                                                      | `src/modules/identity/identity.routes.ts`      |
| 10  | Low      | ~~No HSTS or `Referrer-Policy`, and no cache directive on authenticated JSON~~ **Fixed.** All three, plus `X-Frame-Options`; HSTS in production only                                         | `src/http/respond.ts`                          |
| 11  | Low      | ~~No audit log for authentication or deletion events~~ **Fixed.** Registration, sign-in, sign-out, throttling, link creation and deletion                                                    | `src/lib/audit.ts`                             |
| 12  | Low      | ~~`GET /api/links/:slug` exposes link metadata without a session~~ **Fixed.** Owner only, 403 for anyone else, matching deletion                                                             | `src/modules/links/links.service.ts`           |

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

Retention now bounds all of it. `CLICK_RETENTION_DAYS` defaults to ninety days and a daily
sweep deletes past it, batched so one pass never holds a long transaction. That expiry is
also the erasure mechanism, and it has to be: nothing in a click row identifies a person
well enough for them to ask for their own rows, so there is no request to honour and the
only honest answer is a short life for every row.

What remains is a documentation gap rather than a code one. The collection purpose is
stated in the migration comment and in `.env.example`, and nowhere a visitor would look.
A deployment serving people in a jurisdiction with disclosure requirements needs that
written where they can read it.

## 8. What was done, and what was left

Ten findings are fixed. The work landed in two passes, and the table above marks each one.

The first pass took the three that were unambiguous: certificate verification on the
database connection, the limiter's eviction order, and storing the parser's serialization
of a destination URL rather than the caller's string.

The second pass took the rest, including the two that were product decisions rather than
patches:

- **Shared counters (finding 2).** API rate limits moved into `rate_limit_windows`, counted
  by an upsert that rolls the window over in one statement. One round trip per limited
  request, paid on the API paths only.
- **The redirect path (finding 4)** keeps an in-process limiter, at 600 per minute per
  address, and the split is deliberate. What that limit protects is the database from
  click-write amplification, and paying a synchronous round trip to that same database in
  order to protect it would be self-defeating. A per-instance cap still bounds the total.
- **Link creation requires a session (finding 3).** Every link now has an owner, so abuse
  is attributable. This is the change that alters the public API: an anonymous `POST
/api/links` is a 401.
- **Session identifiers are hashed at rest (finding 5).** Unsalted SHA-256, because the
  input is already 256 bits of randomness and there is nothing for a salt or a work factor
  to defend. The migration deletes every live session, so a deploy signs everyone out once.
- **Per-account sign-in throttle (finding 7).** Twenty failures per account per hour,
  counting failures only. Counting attempts would have handed anyone who knows an address
  a way to lock its owner out.
- **Retention (finding 8), headers (finding 10), audit log (finding 11).**

A third pass closed the last two, findings 9 and 12, which had been left open because both
change the public API contract. Registration now answers identically whether or not the
address was taken, at the cost of no longer signing the caller in, and link metadata is
readable by its owner only.

Four API changes came out of all this, and a client written against the old service will
hit every one: creating a link needs a session, reading a link's metadata needs the owner's
session, registration returns 202 with no session, and there is no `EMAIL_TAKEN` response
any more.

One residual is worth stating rather than filing: the audit log records a hashed client
address and an account id, and it is the same stream as every other log line. That is
enough to reconstruct an incident and not enough to satisfy an auditor who expects an
append-only trail with its own retention.
