# Contributing

This is a learning project, built to expose backend concepts rather than to
reach a result quickly. That shapes what a good change looks like here: an
addition that hides a mechanism behind a library is usually the wrong direction,
even when it is shorter.

Read `README.md` for what the service does, and
[`docs/request-lifecycle.md`](docs/request-lifecycle.md) for how a request
travels through it. Those two are enough to start.

## Setting up

```
cp .env.example .env
cp .env.example .env.test        then change the database name to urlshortener_test
npm install
npm run db:up
npm run migrate
npm run migrate:test
```

Both env files must exist before any script runs, because `node --env-file`
fails when the file is missing. They are gitignored; `.env.example` is the
committed template.

Node 22.15 specifically, as pinned in `.nvmrc`. The runtime type-stripping this
project relies on is experimental and version-sensitive, so a floating major is
a silent way to change the language semantics.

## Before every commit

```
npm run verify
```

That runs the type check, the linter, the formatter check, and the full suite,
in the order CI runs them. A green local run and a green pipeline therefore
cannot mean different things.

## The rules that matter

**The dependency rule.** `pg` is the only production dependency, and adding a
second one needs an argument in the pull request, not just a package. `SPEC.md`
records what the standard library replaces and where the constraint is
deliberately relaxed.

**The layering rule.** Route handlers do HTTP. Services hold business rules and
throw `AppError`, never HTTP objects. Repositories hold SQL, and nothing else
does. A handler that runs a query, or a service that reads a header, is the
change most likely to be sent back.

**No suppressions.** There are no `eslint-disable` comments in this codebase and
adding one is the wrong repair. If a rule is wrong for this project, narrow it
in `eslint.config.js` with the reasoning next to it, where the next person can
see the decision and argue with it.

**Comments say why.** Every file here opens with the reasoning behind it, not a
restatement of what the code does. Match that. A comment that explains a
mechanism the code already shows is noise; one that records the failure a line
prevents is the most valuable thing in the file.

**Tests use the real database.** No mocks. A mocked query proves the code called
a function and proves nothing about whether the SQL is valid, a constraint
fires, or a column exists. Clear state with `resetDatabase()` in `beforeEach`,
never in `afterEach`, so a failed test leaves its rows behind for inspection.

## Changing the API

`openapi.json` is checked against the route tables on every run. Add, rename, or
remove a route without updating it and the build fails, by design. Update both
in the same commit.

## Changing a decision

Decisions that would be expensive to reverse live in
[`docs/adr/`](docs/adr/README.md). If a change contradicts one, do not edit that
record to match. Add a new one, mark the old one **Superseded**, and name the
replacement. The point of the format is that a reversal leaves a trail.

## Migrations

Numbered SQL in `migrations/`, applied in order, **never edited once applied**.
`npm run migrate:new -- <name>` creates an empty one. A migration that changes
stored shape is the one kind of change that cannot be fixed by a later commit,
so it is worth more review than the code around it.

## Commits and pull requests

Keep commit subjects short, single-line, and descriptive. Explain the reasoning
in the pull request body instead, where it can be discussed.

Say what you verified, not just what you changed. "355 tests pass" is worth more
than a summary of the diff, which the diff already provides.
