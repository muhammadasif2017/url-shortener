import { createHash, randomBytes } from 'node:crypto';

/**
 * Session identifier generation and hashing.
 *
 * Two values with two homes. The identifier goes to the browser and is never
 * stored; its hash goes to the database and is never sent anywhere. Keeping the
 * pair in one small module is what makes that split hard to get wrong: a caller
 * that wants to look a session up has to ask for a hash by name.
 */

/**
 * Bytes of entropy in a session identifier.
 *
 * 32 bytes is 256 bits, which is not guessable and not reachable by any amount
 * of online or offline searching. That is what makes the unsalted, unstretched
 * hash below the right choice rather than a corner cut.
 */
const SESSION_ID_BYTES = 32;

/**
 * Creates a session identifier.
 *
 * @returns 32 random bytes in base64url, which is cookie-safe without encoding.
 */
export function createSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString('base64url');
}

/**
 * Hashes a session identifier for storage and lookup.
 *
 * SHA-256, unsalted and unstretched, because the input is already 256 bits of
 * randomness. A salt defends against a precomputed table over a space someone
 * could enumerate, and a work factor slows an attacker who can guess candidates.
 * Neither applies here. Passwords need both for the opposite reason: the input
 * is short, human-chosen, and reused.
 *
 * @param sessionId - The identifier as it arrives from the client cookie.
 * @returns The hex digest, always 64 characters, which the column constrains.
 */
export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}
