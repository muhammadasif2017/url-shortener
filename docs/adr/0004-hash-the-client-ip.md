# 0004. Store a salted hash of the client IP, never the address

**Status:** Accepted

## Context

Counting unique visitors needs a stable per-visitor identifier. The obvious one
is the client's IP address, and storing it is the obvious implementation.

An IP address is personal data in most jurisdictions. A click table holding raw
addresses is a table that has to be defended, disclosed, and deleted on request,
and it turns an analytics feature into a privacy liability.

## Decision

Hash the address with a secret salt, `IP_HASH_SALT`, and store only the digest.
The raw value never reaches a table and never reaches the log, including the
audit log, which hashes it with the same salt.

## Consequences

- Two clicks from one visitor still collapse to one digest, so unique-visitor
  counts work, which is the only thing the value was ever for.
- The digest cannot be reversed to an address without the salt. The address
  space is small enough to brute-force, which is exactly why the salt is secret
  and is what makes the hash worth more than a bare digest.
- Rotating the salt resets unique-visitor counts. That is unavoidable and is
  recorded in `SPEC-analytics.md`, and the service logs a fingerprint of the
  salt at startup so a discontinuity in the numbers can later be explained as a
  rotation rather than a traffic drop.
- Nothing can ever answer "which visitor was this", including for abuse
  investigation. Accepted: the audit log records the acting account for every
  action that has one.
