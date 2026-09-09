import { env } from '../../config/env.ts';
import { AppError } from '../../lib/AppError.ts';
import { hashClientIp } from '../../lib/ipHash.ts';
import { describeError, log } from '../../lib/logger.ts';
import type { Link } from '../links/links.schema.ts';
import * as linkService from '../links/links.service.ts';
import * as repository from './analytics.repository.ts';
import {
  MAX_REFERRER_LENGTH,
  MAX_USER_AGENT_LENGTH,
  type ClickInput,
  type LinkReferrers,
  type LinkStats,
  type NewClickEvent,
} from './analytics.schema.ts';
import { createWriteTracker } from './analytics.writes.ts';

/**
 * Click recording.
 *
 * The redirect is the product and analytics is not, so the write happens after
 * the response and nobody waits for it. That decision is cheap to state and
 * expensive to get wrong: an unawaited promise that rejects terminates a modern
 * Node process, and an unawaited promise nobody tracks makes every test that
 * counts clicks a race. Both hazards are handled here rather than at each call
 * site.
 */

/**
 * Substrings that mark a user agent as automation.
 *
 * Deliberately shallow. It catches software that announces itself, which is all
 * `SPEC-analytics.md` puts in scope, and catches nothing that would rather not
 * be caught.
 */
const BOT_MARKERS: readonly string[] = [
  'bot',
  'crawler',
  'spider',
  'preview',
  'curl',
  'wget',
  'headless',
];

/** The tracker every click write registers with. */
const writes = createWriteTracker();

/**
 * Reports whether a user agent announces itself as automation.
 *
 * A missing user agent is **not** a bot. Plenty of ordinary clients send none,
 * and treating absence as automation would quietly delete real traffic from
 * every figure the module reports.
 *
 * @param userAgent - The header value, or `undefined` when absent.
 * @returns `true` when a known marker appears in it.
 */
export function isBotUserAgent(userAgent: string | undefined): boolean {
  if (userAgent === undefined) return false;
  const lowered = userAgent.toLowerCase();
  return BOT_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Takes the first value of a header Node may have supplied more than once.
 *
 * @param value - The raw header.
 * @returns The single value, or `undefined` when absent or empty.
 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return single === undefined || single === '' ? undefined : single;
}

/**
 * Trims a header to what the column accepts.
 *
 * Truncating rather than rejecting is the point. The check constraints are a
 * backstop against a future write path, not the enforcement point, because a
 * constraint violation on a write nobody awaits loses the click in silence.
 *
 * @param value - The header value, or `undefined`.
 * @param max - Longest value the column allows.
 * @returns The value, cut to length, or `null` when absent.
 */
function truncate(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Builds the row a click produces.
 *
 * Separate from {@link recordClick} so the normalisation is testable without
 * starting a write.
 *
 * @param input - What the redirect handler saw.
 * @param salt - `IP_HASH_SALT`.
 * @returns The event to insert.
 */
export function toClickEvent(input: ClickInput, salt: string): NewClickEvent {
  const userAgent = firstHeader(input.userAgent);

  return {
    linkId: input.linkId,
    referrer: truncate(firstHeader(input.referrer), MAX_REFERRER_LENGTH),
    userAgent: truncate(userAgent, MAX_USER_AGENT_LENGTH),
    ipHash: hashClientIp(input.clientIp, salt),
    isBot: isBotUserAgent(userAgent),
  };
}

/**
 * Records a click, without waiting for it.
 *
 * Returns `void` rather than a promise, and that is the safety property. A
 * function returning a promise here would make every call site responsible for
 * remembering `.catch()`, and the one that forgets takes the process down. This
 * cannot reject, cannot throw, and cannot be awaited by mistake.
 *
 * Call it **before** the response is sent. The write is registered
 * synchronously, so a test that awaits its own request and then drains is
 * guaranteed to find the write already tracked. Registering after an `await`,
 * or from a `finish` handler on the response, reintroduces the race the tracker
 * exists to remove.
 *
 * A failure is logged at error level with the link id and the SQLSTATE. A
 * swallowed error is invisible by definition, and a systematic failure that
 * logs nothing looks exactly like an absence of traffic.
 *
 * @param input - The link, the resolved client address, and the two headers.
 */
export function recordClick(input: ClickInput): void {
  let event: NewClickEvent;

  try {
    event = toClickEvent(input, env().ipHashSalt);
  } catch (error) {
    // Nothing here should throw, but a redirect that fails because analytics
    // could not build a row would invert the entire point of this module.
    log('error', 'click event could not be built', describeError(error));
    return;
  }

  // The return value is deliberately ignored here. A refused write is already
  // reported by the tracker, and there is nothing else this module can do about
  // one: dropping the click is the designed answer to a backlog.
  writes.track(() =>
    repository.insertClick(event).catch((error: unknown) => {
      log('error', 'click write failed', {
        linkId: event.linkId,
        sqlstate: (error as { code?: string }).code,
        ...describeError(error),
      });
    }),
  );

}

/**
 * Waits for every started click write to finish.
 *
 * Two callers and no others: the shutdown sequence, which runs it after
 * in-flight requests and before the pool closes, and integration tests, which
 * run it before asserting a count. Polling with a timeout would trade a flaky
 * failure for a slow one.
 *
 * Unbounded by design. The caller owns the deadline, because only the shutdown
 * sequence knows how much time the process has left.
 *
 * @returns A promise that resolves when nothing is outstanding.
 */
export function drainPendingWrites(): Promise<void> {
  return writes.drain();
}

/**
 * How many click writes are outstanding.
 *
 * @returns The count, for diagnostics and tests.
 */
export function pendingWriteCount(): number {
  return writes.size();
}

/**
 * Resolves a link the caller is allowed to read statistics for.
 *
 * The rule is `deleteLink`'s, not a new one. A slug is public by construction:
 * it appears in browser history, in referrer headers, and in every chat log the
 * link passes through, so it cannot also be the credential that guards a link's
 * click history.
 *
 * The link is read before any aggregate query runs, which costs one query and
 * buys the difference between "no such link" and "not yours".
 *
 * @param slug - The slug from the path.
 * @param userId - The authenticated caller.
 * @returns The link.
 * @throws {AppError} 404 when no such slug exists, 403 when it belongs to
 *   someone else or to nobody. An ownerless link has no owner who can prove
 *   they created it, so there is no correct person to allow.
 */
async function requireOwnedLink(slug: string, userId: string): Promise<Link> {
  const link = await linkService.getLink(slug);

  if (link.ownerId !== userId) {
    throw new AppError('FORBIDDEN', 'That link belongs to someone else.', 403);
  }

  return link;
}

/**
 * Reads one link's click statistics.
 *
 * Two queries, not one transaction. A click landing between them can make the
 * total and the series disagree by one. That is consistent with what this
 * module already promises: the write is not awaited, so every figure is a lower
 * bound rather than an exact count, and a snapshot would buy agreement between
 * two numbers that are both approximate anyway.
 *
 * @param slug - The link to report on.
 * @param userId - The authenticated caller, who must own it.
 * @param windowDays - Window length in whole UTC days, ending today.
 * @returns The statistics, with every count already a number.
 * @throws {AppError} 404 for an unknown slug, 403 for a link the caller does
 *   not own.
 */
export async function readLinkStats(
  slug: string,
  userId: string,
  windowDays: number,
): Promise<LinkStats> {
  const link = await requireOwnedLink(slug, userId);

  const [totals, byDay] = await Promise.all([
    repository.readClickTotals(link.id, windowDays),
    repository.readClicksByDay(link.id, windowDays),
  ]);

  return { slug: link.slug, windowDays, ...totals, byDay };
}

/**
 * Reads where one link's traffic came from.
 *
 * @param slug - The link to report on.
 * @param userId - The authenticated caller, who must own it.
 * @param windowDays - Window length in whole UTC days, ending today.
 * @param limit - Most referrers to return.
 * @returns The ranked referrers.
 * @throws {AppError} 404 for an unknown slug, 403 for a link the caller does
 *   not own.
 */
export async function readLinkReferrers(
  slug: string,
  userId: string,
  windowDays: number,
  limit: number,
): Promise<LinkReferrers> {
  const link = await requireOwnedLink(slug, userId);
  const referrers = await repository.readTopReferrers(link.id, windowDays, limit);

  return { slug: link.slug, windowDays, referrers };
}
