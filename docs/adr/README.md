# Architecture decision records

One file per decision that would be expensive to reverse or confusing to
rediscover. Each records the context that forced the choice, the choice itself,
and what it costs, so a reader can tell a deliberate constraint from an
accident.

These were previously a numbered list at the bottom of `SPEC.md`. Two of them
had quietly become false, which is the failure this format exists to prevent: a
decision written as a list item has nowhere to say it was superseded, so it just
keeps asserting itself. A record here is never edited to reflect a reversal.
It is marked **Superseded** and the record that replaced it is named.

## Status meanings

| Status     | Meaning                                                       |
| ---------- | ------------------------------------------------------------- |
| Accepted   | In force. The code matches it.                                |
| Superseded | No longer in force. The replacing record is named at the top. |

## The records

| #                                                     | Decision                                                         | Status             |
| ----------------------------------------------------- | ---------------------------------------------------------------- | ------------------ |
| [0001](0001-redirect-with-302.md)                     | Redirect with `302`, never `301`                                 | Accepted           |
| [0002](0002-in-memory-rate-limiting.md)               | Rate limiting in process memory                                  | Superseded by 0007 |
| [0003](0003-anonymous-links-stay-ownerless.md)        | Anonymous links stay ownerless                                   | Superseded by 0006 |
| [0004](0004-hash-the-client-ip.md)                    | Store a salted hash of the client IP, never the address          | Accepted           |
| [0005](0005-single-process-no-load-balancer.md)       | One process, no load balancer of our own                         | Accepted, verified |
| [0006](0006-require-a-session-to-create-a-link.md)    | Creating a link requires a session                               | Accepted           |
| [0007](0007-shared-rate-limit-counter-in-postgres.md) | Count API rate limits in Postgres, redirects in memory           | Accepted           |
| [0008](0008-split-liveness-from-readiness.md)         | Answer liveness and readiness separately                         | Accepted           |
| [0009](0009-thread-the-request-id-explicitly.md)      | Pass the correlation id, do not store it in ambient context      | Accepted           |
| [0010](0010-openapi-as-the-checked-contract.md)       | Keep the API contract in OpenAPI, and test it against the routes | Accepted           |

## Writing a new one

Copy the shape of any existing record: a one-line status, then Context,
Decision, Consequences. Number it sequentially. Add a row above. Keep it short
enough that someone reads it, and specific enough that someone can disagree
with it.
