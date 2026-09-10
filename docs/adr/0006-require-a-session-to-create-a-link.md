# 0006. Creating a link requires a session

**Status:** Accepted. Supersedes
[0003](0003-anonymous-links-stay-ownerless.md) for new links.

## Context

`POST /api/links` was open to anyone. That is the defining abuse of a URL
shortener: anybody could mint a link on this domain pointing anywhere, with
nothing recorded about who did it.

A link that borrows this domain's reputation for a phishing page is the product
working exactly as built. With no owner there is nobody to suspend and no way to
find the rest of what the same person made.

## Decision

Resolve a session before creating a link. An anonymous `POST /api/links`
answers `401`.

## Consequences

- Abuse becomes attributable. Requiring an account does not stop anyone
  determined, but it makes every link traceable to a registration and an audit
  trail, which is the cheapest control that changes anything.
- Every new link has an owner, so listing and deletion have a subject. Both
  routes are owner-scoped, and a link belonging to somebody else answers `403`.
- The service is no longer usable without signing up, which is a real product
  cost and is accepted.
- `createLink` in the service layer still takes an optional owner. That is not
  a leftover: rows predating this decision have a null `owner_id` under 0003,
  and a script or backfill may legitimately insert one. The HTTP path cannot.
