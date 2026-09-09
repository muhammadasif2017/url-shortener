import {
  fail,
  isRecord,
  issue,
  ok,
  parseCustomSlug,
  parseDestinationUrl,
  parseFutureInstant,
  type ParseResult,
  type ValidationIssue,
} from '../../lib/validate.ts';

/**
 * A validated request to create a link.
 *
 * Every field is already checked by the time a value of this type exists, so a
 * service receiving one performs no further validation. `customSlug` being
 * present means the caller chose it; absent means the service generates one.
 */
export type CreateLinkInput = {
  /** Destination URL. Always `http:` or `https:`, never on this service's host. */
  readonly url: string;
  /** Caller-chosen slug, already shape-checked. Absent means generate one. */
  readonly customSlug?: string;
  /** Expiry instant, already known to be in the future. Absent means never. */
  readonly expiresAt?: Date;
};

/**
 * A stored link, as the repository returns it.
 *
 * `id` is a string rather than a number on purpose. It is a Postgres `bigint`,
 * which `pg` returns as a string because 64-bit integers do not fit in a
 * JavaScript number. It is an identifier and nothing does arithmetic on it, so
 * it stays a string all the way through.
 */
export type Link = {
  readonly id: string;
  readonly slug: string;
  readonly url: string;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
};

/**
 * Parses and validates a create-link request body.
 *
 * Every field is checked, and every problem is collected, so one response tells
 * the caller everything that is wrong. Stopping at the first failure would make
 * a caller with three mistakes send four requests.
 *
 * Two checks are deliberately absent here, because neither can be answered from
 * the request alone. Whether a custom slug is reserved is decided by
 * `isReservedSlug`, and whether it is already taken is decided by the unique
 * index when the insert runs. Checking the latter here would be a race.
 *
 * @param body - The parsed JSON request body, untrusted and of unknown shape.
 * @param options.baseUrl - This service's public base URL, used to reject
 *   destinations that point back at it.
 * @param options.now - The instant to treat as the present when checking expiry.
 * @returns The validated input, or every issue found.
 */
export function parseCreateLinkInput(
  body: unknown,
  options: { readonly baseUrl: string; readonly now: Date },
): ParseResult<CreateLinkInput> {
  if (!isRecord(body)) {
    return fail([issue('body', 'Request body must be a JSON object.')]);
  }

  const issues: ValidationIssue[] = [];

  const url = parseDestinationUrl(body['url'], {
    field: 'url',
    baseUrl: options.baseUrl,
  });
  if (!url.ok) issues.push(...url.issues);

  let customSlug: string | undefined;
  if (body['customSlug'] !== undefined && body['customSlug'] !== null) {
    const parsed = parseCustomSlug(body['customSlug'], 'customSlug');
    if (parsed.ok) customSlug = parsed.value;
    else issues.push(...parsed.issues);
  }

  let expiresAt: Date | undefined;
  if (body['expiresAt'] !== undefined && body['expiresAt'] !== null) {
    const parsed = parseFutureInstant(body['expiresAt'], 'expiresAt', options.now);
    if (parsed.ok) expiresAt = parsed.value;
    else issues.push(...parsed.issues);
  }

  if (issues.length > 0) return fail(issues);
  if (!url.ok) return fail(issues);

  // Optional properties are attached conditionally rather than set to
  // undefined, because exactOptionalPropertyTypes distinguishes "absent" from
  // "present and undefined", and the repository treats them differently.
  const input: CreateLinkInput = {
    url: url.value,
    ...(customSlug === undefined ? {} : { customSlug }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };

  return ok(input);
}
