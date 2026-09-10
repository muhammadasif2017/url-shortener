# 0009. Pass the correlation id, do not store it in ambient context

**Status:** Accepted

## Context

A structured log is only useful if the lines belonging to one request can be
gathered back together. Without an identifier, a `500` and the audit line that
preceded it are two unrelated facts, and reconstructing what one caller did means
guessing from timestamps.

Node offers `AsyncLocalStorage`, which would make the id available anywhere
without passing it. That is the conventional answer and it removes real
plumbing.

## Decision

Resolve one id per request at the top of the pipeline and pass it explicitly:
into the request context handlers receive, into the error handler, and into
`audit()`. Echo it to the caller as `X-Request-Id`.

An inbound `X-Request-Id` is adopted when it is at most 128 characters of
unreserved URL characters. Anything else is replaced with a fresh UUID.

## Consequences

- The plumbing is visible. This project already keeps what a handler may see in
  one narrow type, so that reaching for something not passed in is a deliberate
  act rather than an invisible one. Ambient context reverses that.
- The cost is small here because services throw rather than log. The call sites
  needing the id are the error handler, the rate-limit failure log, and
  `audit()`. That is three places, not thirty.
- A trace started at a proxy continues through this service, because a safe
  inbound id is adopted rather than replaced.
- A malformed or oversized inbound id is replaced rather than rejected. Refusing
  the request would let a broken upstream take the service down over a header
  nothing depends on.
- The character restriction is not cosmetic. The value is written to a response
  header and to a log line; a value carrying CR or LF is response splitting.
- The outermost failure handler, which catches errors thrown while writing a
  response, has no id, because it can be reached before one is resolved. That is
  the one gap and it is accepted.
