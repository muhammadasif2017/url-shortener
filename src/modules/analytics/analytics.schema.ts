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

/** Smallest reporting window a caller may ask for, in days. */
export const MIN_WINDOW_DAYS = 1;

/**
 * Largest reporting window a caller may ask for, in days.
 *
 * A bound exists because an unbounded breakdown returns one entry per day for
 * as long as the link has existed, so the response would grow without limit as
 * the service ages.
 */
export const MAX_WINDOW_DAYS = 90;

/** Window used when the caller asks for none. */
export const DEFAULT_WINDOW_DAYS = 30;

/** Counts for one link over one window, bot rows already separated out. */
export type ClickTotals = {
  /** Clicks that were not from an announced bot. */
  readonly total: number;
  /** Distinct visitor hashes among those clicks. */
  readonly uniqueVisitors: number;
  /** Clicks excluded from the two figures above. */
  readonly botClicks: number;
};

/** One UTC day of the breakdown. */
export type DailyClicks = {
  /** The UTC calendar day, as `YYYY-MM-DD`. */
  readonly date: string;
  readonly clicks: number;
};

/**
 * Everything the statistics endpoint reports.
 *
 * Every number is a lower bound. Click writes are not awaited, so a crash
 * between the response and the insert drops the event. Anything presenting
 * these figures says so.
 */
export type LinkStats = ClickTotals & {
  readonly slug: string;
  /** Window length these figures cover, in whole UTC days, ending today. */
  readonly windowDays: number;
  /** One entry per day in the window, oldest first, including zeros. */
  readonly byDay: readonly DailyClicks[];
};
