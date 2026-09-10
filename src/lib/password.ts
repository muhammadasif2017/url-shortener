import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing with `scrypt`.
 *
 * `scrypt` is memory-hard and built in, so no native module has to compile and
 * no dependency has to be trusted. Argon2id would be preferable on the merits,
 * but Node has no binding for it, and `scrypt` is a legitimate choice made
 * properly rather than a weak substitute.
 *
 * Everything risky here is in the parameters and the storage format, not in the
 * primitive.
 */

/**
 * Promisified `scrypt`, typed explicitly.
 *
 * `promisify` picks the first overload, which has no options parameter, so the
 * cost parameters would be rejected at type-check time. The cast names the
 * overload actually being used.
 */
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Cost parameter. Memory use is roughly `128 * N * r` bytes, so this needs
 * about 33 MiB per hash.
 */
const N = 32_768;
/** Block size. */
const R = 8;
/** Parallelisation. */
const P = 1;
/** Derived key length in bytes. */
const KEY_LENGTH = 32;
/** Salt length in bytes. */
const SALT_LENGTH = 16;

/**
 * Memory ceiling, raised explicitly.
 *
 * Node's default is 32 MiB and `N=32768, r=8` needs about 33, so leaving this
 * alone makes every hash throw `ERR_CRYPTO_INVALID_SCRYPT_PARAMS: memory limit
 * exceeded`. The cost parameters and this ceiling have to be chosen together,
 * or raising the cost later breaks sign-in at runtime rather than at review.
 */
const MAX_MEM = 64 * 1024 * 1024;

/** Shortest password accepted. Length matters more than composition rules. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Longest password accepted.
 *
 * The maximum matters more than it looks. `scrypt` on unbounded input is a CPU
 * amplification vector against a single-threaded service: one request could
 * occupy the event loop for as long as the attacker cares to make it.
 */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Hashes a password.
 *
 * The async form of `scrypt` is used, never `scryptSync`. The synchronous form
 * blocks the single event loop for roughly a tenth of a second per call, so a
 * burst of sign-in attempts would stall every redirect the service is serving.
 * The async form runs on the libuv thread pool instead.
 *
 * @param password - The plaintext password.
 * @returns An encoded string carrying the algorithm, its parameters, the salt,
 *   and the derived key. Storing the parameters alongside the hash is what
 *   allows the cost to be raised later: without them, an old hash could never
 *   be verified again.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);

  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });

  return [
    'scrypt',
    `N=${N},r=${R},p=${P}`,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Verifies a password against a stored hash.
 *
 * Never throws for a malformed or unreadable stored hash. A corrupted row
 * should fail the sign-in with 401, not produce a 500 that tells the caller
 * something unusual happened to that particular account.
 *
 * @param password - The plaintext password supplied by the caller.
 * @param stored - The encoded hash from the database.
 * @returns `true` when the password matches.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed === undefined) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(password, parsed.salt, parsed.hash.byteLength, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    });
  } catch {
    // Parameters outside what this build allows, for instance a hash written by
    // a future version with a higher cost. A failed verification is the right
    // answer; a crash is not.
    return false;
  }

  // timingSafeEqual throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on a length
  // mismatch, so it is not a drop-in for === on values of unknown length. The
  // lengths are compared first, and an unequal length is simply a failure.
  if (derived.byteLength !== parsed.hash.byteLength) return false;

  return timingSafeEqual(derived, parsed.hash);
}

/** A parsed stored hash. */
type ParsedHash = {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
};

/**
 * Parses an encoded hash.
 *
 * @param stored - The string from the database.
 * @returns Its parts, or `undefined` when it cannot be read.
 */
function parseHash(stored: string): ParsedHash | undefined {
  const parts = stored.split('$');
  if (parts.length !== 4) return undefined;

  const [algorithm, parameters, salt, hash] = parts;
  if (algorithm !== 'scrypt' || parameters === undefined) return undefined;
  if (salt === undefined || hash === undefined) return undefined;

  const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parameters);
  if (match === null) return undefined;

  const n = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);

  // A hash claiming absurd parameters would otherwise let a poisoned row turn
  // one sign-in attempt into a denial of service.
  if (n > N || r > R * 4 || p > 16) return undefined;

  const saltBytes = Buffer.from(salt, 'base64url');
  const hashBytes = Buffer.from(hash, 'base64url');

  // An empty salt or digest must be rejected here, and this is not a tidiness
  // check. `timingSafeEqual` on two zero-length buffers returns true, so a row
  // storing `scrypt$N=...$$` would authenticate every password. Length is also
  // required to be plausible, since a truncated digest weakens the comparison
  // even when it is not empty.
  if (saltBytes.byteLength < 8 || hashBytes.byteLength < 16) return undefined;

  return { n, r, p, salt: saltBytes, hash: hashBytes };
}

/**
 * A hash to verify against when no user was found.
 *
 * Sign-in must do the same work whether or not the address exists. Skipping the
 * hash for an unknown address makes that response measurably faster, and the
 * difference turns the endpoint into an account enumeration oracle: an attacker
 * learns which addresses are registered by timing alone.
 *
 * Built once at startup, because building it per request would cost a full
 * hash on every failed attempt.
 */
let dummyHash: Promise<string> | undefined;

/**
 * Returns a hash that no password matches.
 *
 * @returns The dummy hash, built on first use.
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}
