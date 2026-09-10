# 0001. Redirect with `302`, never `301`

**Status:** Accepted

## Context

A URL shortener has to answer a slug lookup with a redirect, and the choice of
status decides how browsers and intermediaries treat it afterwards. `301` is a
permanent redirect: browsers cache it indefinitely, and many do not revalidate
it even after a hard refresh.

Two things depend on that choice. A destination is typed by a human and can be
wrong. And click counting only works if the request reaches this server.

## Decision

Every slug resolution answers `302`, with `Cache-Control: no-store` set by the
redirect helper rather than by each route.

## Consequences

- A mistyped destination stays fixable. Under `301` it would be unfixable for
  every visitor who had already followed the link once, because their browser
  would never ask again.
- A deleted or expired link actually stops working.
- Every visit reaches the server, so it can be counted. Under `301` the second
  and later visits from one browser are invisible, and the click totals would
  understate traffic by an unknowable amount.
- The cost is one request per visit that a permanent redirect could have served
  from cache. That is the price of the three properties above, and for a service
  whose entire product is the redirect, it is the right trade.
- `307` would behave identically here, since the method is `GET` either way, so
  there is no reason to prefer it.
