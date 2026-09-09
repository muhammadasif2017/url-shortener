import { env } from '../../config/env.ts';
import { hashClientIp } from '../../lib/ipHash.ts';
import { describeError, log } from '../../lib/logger.ts';
import * as repository from './analytics.repository.ts';
import {
  MAX_REFERRER_LENGTH,
  MAX_USER_AGENT_LENGTH,
  type ClickInput,
  type NewClickEvent,
} from './analytics.schema.ts';

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

/** Tracks writes that have started but not finished. */
export type WriteTracker = {
  /** Registers a write. Never throws, and neutralises a rejecting promise. */
  readonly track: (write: Promise<unknown>) => void;
  /** Resolves once every registered write has settled. */
  readonly drain: () => Promise<void>;
  /** How many writes are outstanding. For tests and diagnostics. */
  readonly size: () => number;
};

/**
 * Builds a tracker for fire-and-forget writes.
 *
 * Exported as a factory so its two mandatory properties can be unit tested
 * without a database. Both exist because of failures that are invisible until
 * they are not:
 *
 * 1. **A rejecting write is neutralised on registration.** The promise stored
 *    is one that has already had `.catch()` attached, so a rejection can reach
 *    neither the process nor {@link WriteTracker.drain}. Registering the raw
 *    promise and catching a separate reference would leave the drain awaiting
 *    a rejecting promise, which turns one failed insert into a failed shutdown.
 * 2. **The drain loops until the set is empty.** A single pass over a live set
 *    misses writes added while that pass was pending, and those are exactly the
 *    writes a shutdown is racing.
 *
 * @returns A tracker with no writes outstanding.
 */
export function createWriteTracker(): WriteTracker {
  const pending = new Set<Promise<void>>();

  return {
    track(write) {
      // The caught promise is what gets stored, not the original.
      const settled = write.then(
        () => undefined,
        () => undefined,
      );
      pending.add(settled);
      void settled.then(() => {
        pending.delete(settled);
      });
    },

    async drain() {
      // A write registered while the previous pass was awaiting is still in the
      // set on the next check, which is why this repeats rather than snapshots.
      // The loop is unbounded here on purpose: the deadline belongs to the
      // shutdown sequence, which knows how long the process has left.
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },

    size() {
      return pending.size;
    },
  };
}

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

  writes.track(
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
