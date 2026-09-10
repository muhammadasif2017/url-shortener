# 0003. Anonymous links stay ownerless

**Status:** Superseded by
[0006](0006-require-a-session-to-create-a-link.md) for new links. Still in force
for rows created before that.

## Context

Links existed before accounts did. When the identity module landed, the stored
links had no owner and there was no way to prove who had made any of them.

The tempting move was a claim flow: let a signed-in user assert ownership of a
link they created earlier.

## Decision

Leave existing links with a null `owner_id`, permanently. Build no claim flow.

## Consequences

- A claim flow needs a proof of ownership, and no proof was ever issued to an
  anonymous creator. Anything built on a weaker signal, such as possession of
  the slug, would hand every link to whoever guessed or read it first, since a
  slug travels in browser history and referrer headers and is public by
  construction.
- An ownerless link still redirects, forever. It can never be listed, read, or
  deleted through the API, because every one of those routes resolves an owner
  first.
- The service therefore holds a set of links nobody can administer. That is
  accepted as the cost of not building an ownership check that would be wrong.

## Why it was superseded

This record answered what to do with links that already existed. It did not
settle whether new ones could be created anonymously, and for a while they
could. Record 0006 closed that: creating a link now requires a session. This
record still governs the rows created before it.
