import { createHash } from 'node:crypto';

/**
 * Visitor address hashing.
 *
 * Analytics needs to know whether two clicks came from the same visitor. It
 * does not need to know who that visitor is, so the raw address is never
 * stored. A salted digest answers the only question asked of it, and answers
 * nothing else.
 *
 * The salt is passed in rather than read from configuration here, so these stay
 * pure functions that a unit test can call without a valid environment.
 */

/** Characters of the digest kept as a fingerprint. */
const FINGERPRINT_LENGTH = 8;

/**
 * Hashes a client address for storage.
 *
 * The salt goes in before the address. Appending a secret to attacker-supplied
 * input is the shape length-extension attacks exploit, and while nothing here
 * verifies the digest, writing it in the safe order costs nothing and removes
 * the question.
 *
 * Without the salt this would be reversible: the entire IPv4 space is four
 * billion values, which is minutes of work to enumerate against an unsalted
 * digest.
 *
 * @param clientIp - The resolved address, already normalised by
 *   `resolveClientIp`. The literal `unknown` is hashed like any other value,
 *   so every unresolvable visitor shares one digest.
 * @param salt - `IP_HASH_SALT`. Rotating it resets unique-visitor counts.
 * @returns 64 lowercase hex characters, matching the column's check constraint.
 */
export function hashClientIp(clientIp: string, salt: string): string {
  return hashIdentifier(clientIp, salt);
}

/**
 * Hashes any identifier that should be countable but not readable.
 *
 * The same construction as `hashClientIp`, named for the general case. Two
 * callers use it: the audit log, which records which client acted without
 * recording the address, and the per-account login limit, whose bucket key would
 * otherwise put an email address in a table.
 *
 * Salting matters here for the same reason it does for addresses. Email
 * addresses are enumerable, so an unsalted digest of one is a lookup away from
 * the address itself.
 *
 * @param value - The identifier. Lowercase it first if two spellings of the same
 *   thing must hash alike.
 * @param salt - `IP_HASH_SALT`. Rotating it changes every derived value, which
 *   for a rate-limit bucket means one forgiving window and for the audit log
 *   means correlation stops at the rotation.
 * @returns 64 lowercase hex characters.
 */
export function hashIdentifier(value: string, salt: string): string {
  return createHash('sha256').update(salt).update(value).digest('hex');
}

/**
 * Fingerprints the salt itself, for the startup log.
 *
 * Rotating the salt resets unique-visitor counts, so a drop in those numbers
 * has two possible causes: less traffic, or a new salt. Logging this makes them
 * distinguishable after the fact without storing a rotation history anywhere.
 *
 * The salt is never logged. This is a one-way digest of it, truncated, and it
 * discloses nothing to anyone who does not already hold the salt.
 *
 * @param salt - `IP_HASH_SALT`.
 * @returns The first 8 hex characters of the salt's digest.
 */
export function saltFingerprint(salt: string): string {
  return createHash('sha256').update(salt).digest('hex').slice(0, FINGERPRINT_LENGTH);
}
