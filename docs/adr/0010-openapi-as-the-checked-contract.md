# 0010. Keep the API contract in OpenAPI, and test it against the routes

**Status:** Accepted

## Context

The API was described in prose, in four specification documents totalling
several thousand lines. Prose is good at explaining why a rule exists and bad at
staying true: nothing checks it, so it drifts, and a reader cannot tell a
current statement from a stale one.

A generated document was considered. Generating from route tables would need a
schema library the single-dependency rule forbids, and would produce a document
that describes shapes without explaining any of them.

## Decision

Hand-write `openapi.json` and check it with a test.
`tests/unit/openapi.test.ts` compares the document's operations against the
route tables the server assembles, and fails on a route documented but not
served, or served but not documented. It also checks that every internal
reference resolves.

`SPEC.md` keeps the reasoning. `openapi.json` keeps the shape.

## Consequences

- The route inventory cannot drift. Adding, renaming, or removing a route
  without touching the document fails the build.
- Response schemas are not checked, deliberately. Asserting every schema in that
  test would restate the integration tests in a second, weaker form. The
  inventory is what actually drifts.
- The document is hand-written, so it can carry the reasoning that a generated
  one cannot: why registration always answers `202`, why the redirect is `302`,
  why a slug is not a credential.
- It is JSON rather than YAML because Node parses JSON with no dependency, which
  is what makes the drift test possible without adding one.
- Two documents now describe the same surface, and only one is checked. `SPEC.md`
  points at `openapi.json` for anything per-route rather than repeating it.
