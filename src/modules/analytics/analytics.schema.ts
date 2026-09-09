/**
 * Types and limits for the analytics module.
 *
 * Nothing here validates a request body, because no analytics endpoint accepts
 * one. What it holds instead are the shapes that cross the module's boundaries
 * and the two lengths the database also enforces.
 */

/**
 * Longest referrer stored.
 *
 * Matches the check constraint on the column. The service truncates to this
 * before inserting rather than relying on the constraint, because the insert is
 * not awaited: a rejected row disappears with nothing to show for it.
 */
export const MAX_REFERRER_LENGTH = 2048;

/** Longest user agent stored. Matches the check constraint on the column. */
export const MAX_USER_AGENT_LENGTH = 512;

/**
 * A click event ready to be written.
 *
 * Every field is already normalised: headers truncated, absence expressed as
 * `null`, and the address hashed. The repository writes this as given.
 */
export type NewClickEvent = {
  /** The link that was followed. A `bigint` id, and therefore a string. */
  readonly linkId: string;
  /** `Referer` header, truncated, or `null` for direct traffic. */
  readonly referrer: string | null;
  /** `User-Agent` header, truncated, or `null` when none was sent. */
  readonly userAgent: string | null;
  /** Salted digest of the visitor's address. Always 64 hex characters. */
  readonly ipHash: string;
  /** Whether the user agent announced itself as automation. */
  readonly isBot: boolean;
};

/**
 * What the redirect handler knows about a click.
 *
 * Headers arrive exactly as Node supplies them, including the array form of a
 * repeated header, because normalising them is this module's job rather than
 * the caller's.
 */
export type ClickInput = {
  readonly linkId: string;
  /** Already resolved through the shared client-IP helper. */
  readonly clientIp: string;
  readonly referrer: string | string[] | undefined;
  readonly userAgent: string | string[] | undefined;
};
