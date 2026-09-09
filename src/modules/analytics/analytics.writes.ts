import { log } from '../../lib/logger.ts';

/**
 * Tracking for writes that nobody waits for.
 *
 * The click insert is deliberately not awaited, which creates three hazards
 * that have nothing to do with clicks and everything to do with the mechanism:
 * an unhandled rejection ends the process, an untracked promise makes every
 * test that counts rows a race, and an unbounded set of them is a memory leak
 * fed by unauthenticated traffic. All three live here, so
 * `analytics.service.ts` is left holding what a click *is* rather than how a
 * background write behaves.
 *
 * This is a fifth file in a module whose other three follow the four-file shape
 * in `SPEC.md`. The shape is there to keep routes, services, repositories, and
 * schemas apart; a mechanism that is none of those is better as its own file
 * than buried in the service.
 */

/**
 * Most writes allowed to be outstanding at once.
 *
 * The redirect route is not rate limited, on purpose, so it is the one path
 * where unauthenticated traffic can grow something without bound. The
 * connection pool holds ten connections, so a burst queues writes faster than
 * they drain. The number matches the rate limiter's hard cap, which exists
 * against the same class of memory exhaustion.
 *
 * Shedding is the right answer rather than blocking, because losing click
 * events is already accepted and delaying redirects is not.
 */
const MAX_PENDING_WRITES = 10_000;

/** Tracks writes that have started but not finished. */
export type WriteTracker = {
  /**
   * Starts a write and registers it.
   *
   * Takes a function rather than a promise so a refused write is never started
   * at all. Accepting the promise and then discarding it would still run the
   * insert, which is the load the limit exists to shed.
   *
   * @returns `false` when the tracker is full and nothing was started.
   */
  readonly track: (start: () => Promise<unknown>) => boolean;
  /** Resolves once every registered write has settled. */
  readonly drain: () => Promise<void>;
  /** How many writes are outstanding. For tests and diagnostics. */
  readonly size: () => number;
};

/** Options for {@link createWriteTracker}. */
export type WriteTrackerOptions = {
  /** Most writes outstanding before new ones are refused. */
  readonly limit?: number;
};

/**
 * Builds a tracker for fire-and-forget writes.
 *
 * A factory rather than a module singleton, so every property below can be
 * tested without a database and without one test's state reaching another's.
 * Three of them are mandatory:
 *
 * 1. **A rejecting write is neutralised on registration.** The promise stored
 *    has already had `.catch()` attached, so a rejection can reach neither the
 *    process nor {@link WriteTracker.drain}. Registering the raw promise and
 *    catching a separate reference would leave the drain awaiting a rejecting
 *    promise, turning one failed insert into a failed shutdown.
 * 2. **The drain loops until the set is empty.** A single pass over a live set
 *    misses writes added while that pass was pending, and those are exactly the
 *    writes a shutdown is racing.
 * 3. **Shedding is reported on its edges.** The first refusal and the first
 *    acceptance afterwards each log once, with the number dropped in between. A
 *    service already failing to keep up does not need a log line per request as
 *    well, and this state lives in the closure so it cannot be left set by one
 *    test and read by the next.
 *
 * @param options.limit - Most writes outstanding before new ones are refused.
 *   Defaults to {@link MAX_PENDING_WRITES}.
 * @returns A tracker with no writes outstanding.
 */
export function createWriteTracker(options: WriteTrackerOptions = {}): WriteTracker {
  const pending = new Set<Promise<void>>();
  const limit = options.limit ?? MAX_PENDING_WRITES;

  let shedding = false;
  let dropped = 0;

  return {
    track(start) {
      // Refused before the work begins, so a full tracker stops growing rather
      // than merely growing more slowly.
      if (pending.size >= limit) {
        dropped += 1;
        if (!shedding) {
          shedding = true;
          log('warn', 'background writes are being shed', { pending: pending.size, limit });
        }
        return false;
      }

      if (shedding) {
        log('warn', 'background writes recovered', { dropped });
        shedding = false;
        dropped = 0;
      }

      // The caught promise is what gets stored, not the original.
      const settled = start().then(
        () => undefined,
        () => undefined,
      );
      pending.add(settled);
      void settled.then(() => {
        pending.delete(settled);
      });
      return true;
    },

    async drain() {
      // A write registered while the previous pass was awaiting is still in the
      // set on the next check, which is why this repeats rather than snapshots.
      // The loop is unbounded on purpose: the deadline belongs to the shutdown
      // sequence, which knows how much time the process has left.
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },

    size() {
      return pending.size;
    },
  };
}
