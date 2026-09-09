import { randomBytes } from 'node:crypto';

/**
 * Base62 alphabet. Digits, uppercase, lowercase, in that order. The order is
 * arbitrary but must stay stable, because changing it changes which slugs a
 * given byte sequence produces.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export const SLUG_LENGTH = 7;

/**
 * Bytes at or above this value are discarded rather than folded into the
 * alphabet.
 *
 * 256 is not a multiple of 62. Taking `byte % 62` over the full byte range
 * would map 256 values onto 62 characters unevenly: the first 256 % 62 = 8
 * characters would each be produced by 5 byte values while the other 54 would
 * be produced by 4, making those 8 characters about 25% more likely. 248 is the
 * largest multiple of 62 not exceeding 256, so accepting only bytes 0..247
 * gives every character exactly 4 sources and a uniform distribution.
 *
 * The cost is discarding 8 of every 256 bytes, about 3.1%.
 */
const REJECTION_THRESHOLD = 248;

/**
 * How many random bytes to draw per attempt. Larger than SLUG_LENGTH so that
 * the ~3.1% rejection rate almost never forces a second call into the CSPRNG.
 */
const BYTES_PER_DRAW = 32;

/**
 * Slugs that must never be issued, because a route already owns that path or
 * plausibly will. Matched case-insensitively.
 *
 * This list is about what may be *created*. It has nothing to do with which
 * route matches an incoming request — that is the router's precedence rule.
 *
 * `favicon.ico` and `robots.txt` are deliberately absent: the slug charset
 * excludes `.`, so neither could ever be stored in the first place.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'health',
  'admin',
  'login',
  'logout',
  'register',
  'signup',
  'signin',
  'static',
  'assets',
  '_next',
  'docs',
  'status',
]);

/**
 * Generates a random slug of {@link SLUG_LENGTH} base62 characters.
 *
 * Characters are drawn from `node:crypto` with rejection sampling, so every
 * character in the alphabet is equally likely. See {@link REJECTION_THRESHOLD}
 * for why plain modulo would not be.
 *
 * Uniqueness is **not** guaranteed here, and deliberately so. The unique index
 * on `links.slug` is the only real guard against collisions; callers retry on a
 * `23505` violation rather than checking first, because checking first is a
 * race.
 *
 * @returns A newly generated slug. Never empty, never reserved in practice,
 *   though callers that accept custom slugs must still check
 *   {@link isReservedSlug}.
 */
export function generateSlug(): string {
  let slug = '';

  while (slug.length < SLUG_LENGTH) {
    const buffer = randomBytes(BYTES_PER_DRAW);

    for (const byte of buffer) {
      if (byte >= REJECTION_THRESHOLD) continue;
      slug += ALPHABET[byte % ALPHABET.length];
      if (slug.length === SLUG_LENGTH) break;
    }
  }

  return slug;
}

/**
 * Reports whether a caller-supplied slug is one this service refuses to issue.
 *
 * Comparison is case-insensitive, so `API` is rejected as readily as `api`.
 * Callers should treat a `true` result as a validation failure and return 400,
 * not 409: a reserved slug conflicts with no stored row.
 *
 * @param slug - The candidate slug, exactly as the caller supplied it.
 * @returns `true` when the slug is reserved and must be rejected.
 */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

/**
 * The base62 alphabet used by {@link generateSlug}, exposed so that tests can
 * assert against the real alphabet rather than restating it and drifting.
 */
export const SLUG_ALPHABET = ALPHABET;
