/**
 * Shared validation primitives.
 *
 * This module deliberately contains no error class and throws nothing. Parsing
 * returns a {@link ParseResult} instead, so that a caller collects every problem
 * with a request body in one pass and reports all of them together. Throwing on
 * the first bad field would let a caller fix one thing, resubmit, and discover
 * the next.
 *
 * Turning a failed result into an HTTP response is the job of the error handler,
 * not of this module.
 */

/** A single problem with a single field, phrased for the person who sent it. */
export type ValidationIssue = {
  /** Dot-free field name as it appears in the request body, such as `url`. */
  readonly field: string;
  /** Human-readable explanation. Never includes the offending value. */
  readonly message: string;
};

/**
 * The outcome of parsing untrusted input.
 *
 * The success arm carries a fully narrowed value, so a caller that checks `ok`
 * needs no further casting or defensive checks.
 */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * Wraps a successfully parsed value.
 *
 * @param value - The narrowed value.
 * @returns A successful {@link ParseResult}.
 */
export function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

/**
 * Wraps one or more validation failures.
 *
 * @param issues - Every problem found, not just the first.
 * @returns A failed {@link ParseResult}.
 */
export function fail<T>(issues: readonly ValidationIssue[]): ParseResult<T> {
  return { ok: false, issues };
}

/**
 * Builds a single issue.
 *
 * @param field - The offending field name.
 * @param message - What is wrong with it.
 * @returns The issue.
 */
export function issue(field: string, message: string): ValidationIssue {
  return { field, message };
}

/**
 * Narrows an unknown value to a plain JSON object.
 *
 * Arrays and `null` are rejected, because both are `typeof 'object'` and both
 * would otherwise pass a naive check and fail later with a confusing error.
 *
 * @param value - Any parsed JSON value.
 * @returns `true` when the value is a non-array, non-null object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The largest destination URL this service will store, in characters. */
export const MAX_URL_LENGTH = 2048;

/** Protocols a destination URL may use. Everything else is rejected. */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Validates a destination URL.
 *
 * This is an allowlist, not a blocklist. Only `http:` and `https:` are accepted,
 * which rejects `javascript:`, `data:`, `file:`, and every scheme nobody has
 * thought of yet. A blocklist would need updating every time a new scheme
 * appears; an allowlist never does.
 *
 * The URL is never fetched, here or anywhere else in this service. Fetching a
 * caller-supplied URL from the server is server-side request forgery, and no
 * feature is worth introducing it.
 *
 * What is returned is the parser's own serialization, not the caller's string.
 * The two differ, and the difference is the bug this closes: the WHATWG parser
 * strips tab, carriage return and newline while parsing, so a value carrying
 * them parses cleanly while the original still holds them. Returning the
 * original stored a string that had never been validated in the form it was
 * stored, and that string is later emitted as a `Location` header. Node refuses
 * a header value containing control characters, so the link simply broke on
 * every visit rather than splitting the response, but a value nobody checked
 * reaching a response header is the class of mistake, not that outcome.
 *
 * The visible cost is normalization: `http://example.com` comes back as
 * `http://example.com/`. That is the same URL.
 *
 * @param value - The candidate, straight from the request body.
 * @param options.field - Field name to use in any issue produced.
 * @param options.baseUrl - This service's own public base URL. A destination on
 *   the same host is rejected, because it creates a redirect chain, and a link
 *   pointing at its own short URL creates a loop.
 * @returns The normalized URL, or the reasons it was rejected.
 */
export function parseDestinationUrl(
  value: unknown,
  options: { readonly field: string; readonly baseUrl: string },
): ParseResult<string> {
  const { field, baseUrl } = options;

  if (typeof value !== 'string' || value.trim() === '') {
    return fail([issue(field, 'A destination URL is required.')]);
  }

  if (value.length > MAX_URL_LENGTH) {
    return fail([issue(field, `Must be ${MAX_URL_LENGTH} characters or fewer.`)]);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail([issue(field, 'Must be a valid absolute URL.')]);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return fail([issue(field, 'Must be an http or https URL.')]);
  }

  if (parsed.hostname === '') {
    return fail([issue(field, 'Must include a host.')]);
  }

  if (isSameHost(parsed, baseUrl)) {
    return fail([issue(field, 'Must not point back at this service.')]);
  }

  // Length is checked again on the serialized form. Normalization can lengthen a
  // URL, by percent-encoding a character the caller sent raw, and the column
  // constraint applies to what is stored rather than to what arrived.
  if (parsed.href.length > MAX_URL_LENGTH) {
    return fail([issue(field, `Must be ${MAX_URL_LENGTH} characters or fewer.`)]);
  }

  return ok(parsed.href);
}

/**
 * Compares a destination's host against this service's own.
 *
 * Comparison is host-only and case-insensitive, ignoring path, port, and
 * scheme, because any URL on this host is a chain or a loop regardless of those.
 *
 * @param destination - The already-parsed destination URL.
 * @param baseUrl - This service's public base URL.
 * @returns `true` when both share a hostname. A malformed `baseUrl` yields
 *   `false`, so a configuration mistake never blocks legitimate links.
 */
function isSameHost(destination: URL, baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === destination.hostname.toLowerCase();
  } catch {
    return false;
  }
}

/** Shortest slug a caller may choose. */
export const MIN_SLUG_LENGTH = 3;
/** Longest slug a caller may choose. */
export const MAX_CUSTOM_SLUG_LENGTH = 32;

/**
 * Characters a custom slug may contain.
 *
 * `.` is excluded on purpose. It keeps slugs from resembling filenames such as
 * `robots.txt`, and it matches the CHECK constraint on the column so that
 * application validation and database validation cannot disagree.
 */
const CUSTOM_SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validates a caller-chosen slug's shape.
 *
 * Shape only. Whether the slug is reserved, and whether it is already taken,
 * are separate checks: the first lives in `lib/slug.ts`, and the second belongs
 * to the database's unique index.
 *
 * Matching is case-sensitive, because URL paths are.
 *
 * @param value - The candidate slug.
 * @param field - Field name to use in any issue produced.
 * @returns The slug unchanged, or the reasons it was rejected.
 */
export function parseCustomSlug(value: unknown, field: string): ParseResult<string> {
  if (typeof value !== 'string') {
    return fail([issue(field, 'Must be a string.')]);
  }

  if (value.length < MIN_SLUG_LENGTH || value.length > MAX_CUSTOM_SLUG_LENGTH) {
    return fail([
      issue(field, `Must be between ${MIN_SLUG_LENGTH} and ${MAX_CUSTOM_SLUG_LENGTH} characters.`),
    ]);
  }

  if (!CUSTOM_SLUG_PATTERN.test(value)) {
    return fail([issue(field, 'May contain only letters, digits, hyphens, and underscores.')]);
  }

  return ok(value);
}

/**
 * Validates an expiry instant.
 *
 * The value must be an ISO 8601 string and must lie in the future. `now` is a
 * parameter rather than a call to `Date.now()` so that tests can pin it; a
 * function that reads the clock internally cannot be tested at a boundary.
 *
 * This check is a convenience for the caller, not the authority. Whether a link
 * has actually expired is decided in SQL against the database clock, so that
 * one clock governs every decision.
 *
 * @param value - The candidate, expected to be an ISO 8601 string.
 * @param field - Field name to use in any issue produced.
 * @param now - The instant to treat as the present.
 * @returns The parsed `Date`, or the reasons it was rejected.
 */
export function parseFutureInstant(value: unknown, field: string, now: Date): ParseResult<Date> {
  if (typeof value !== 'string') {
    return fail([issue(field, 'Must be an ISO 8601 date-time string.')]);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fail([issue(field, 'Must be a valid ISO 8601 date-time string.')]);
  }

  if (parsed.getTime() <= now.getTime()) {
    return fail([issue(field, 'Must be in the future.')]);
  }

  return ok(parsed);
}

/**
 * Validates a positive integer supplied as a query parameter.
 *
 * Query parameters arrive as strings, so a numeric-looking value still has to
 * be checked for emptiness, sign, fractional parts, and range. `Number('')` is
 * `0` and `Number(' 5 ')` is `5`, both of which a naive conversion would
 * silently accept.
 *
 * @param value - The raw query parameter, or `undefined` when absent.
 * @param field - Field name to use in any issue produced.
 * @param options.min - Smallest acceptable value, inclusive.
 * @param options.max - Largest acceptable value, inclusive.
 * @param options.fallback - Value to use when the parameter is absent.
 * @returns The integer, or the reasons it was rejected.
 */
export function parseBoundedInteger(
  value: string | undefined,
  field: string,
  options: { readonly min: number; readonly max: number; readonly fallback: number },
): ParseResult<number> {
  if (value === undefined) return ok(options.fallback);

  if (!/^\d+$/.test(value)) {
    return fail([issue(field, 'Must be a whole number.')]);
  }

  const parsed = Number(value);
  if (parsed < options.min || parsed > options.max) {
    return fail([issue(field, `Must be between ${options.min} and ${options.max}.`)]);
  }

  return ok(parsed);
}
