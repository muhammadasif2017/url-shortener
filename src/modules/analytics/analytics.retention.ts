import { env } from '../../config/env.ts';
import { describeError, log } from '../../lib/logger.ts';
import * as repository from './analytics.repository.ts';

/**
 * Deletion of click events past their retention window.
 *
 * Click rows are personal data. `ip_hash` is a pseudonym rather than an
 * anonymisation, since it reverses for anyone holding the salt, and `referrer`
 * records where a visitor had been. Data with no expiry is a breach scheduled
 * for a later date, and it is also the one form of erasure available here: a
 * visitor cannot ask for their own rows, because nothing in a row identifies
 * them well enough to find it.
 *
 * This runs on a timer rather than riding on a write, which is the shape
 * `deleteExpiredSessions` uses. The two differ because the work differs. A
 * session sweep deletes rows the same request just made unreachable, and doing
 * it inline costs one statement on a path already writing one. A retention
 * sweep deletes rows written months ago, scans by a column no index covers, and
 * has to run whether or not anyone is using the service. Attaching that to the
 * redirect path would put an occasional table scan on the hot path and would
 * stop deleting the moment traffic stopped, which is precisely when the promise
 * still has to hold.
 */

/** How often the sweep runs. Daily is well below the shortest retention window. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Rows deleted per statement, so one sweep never holds a long transaction. */
const SWEEP_BATCH_SIZE = 10_000;

/** Most batches one sweep will run before leaving the rest for the next one. */
const MAX_BATCHES_PER_SWEEP = 100;

/**
 * Deletes every click event older than the retention window.
 *
 * Batched, because the first sweep after a retention period is shortened can
 * match a very large number of rows, and one statement deleting all of them
 * holds a transaction and a lock for as long as it takes.
 *
 * @returns How many rows were deleted.
 */
export async function sweepExpiredClicks(): Promise<number> {
  const retentionDays = env().clickRetentionDays;
  let deleted = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
    const removed = await repository.deleteClicksOlderThan(retentionDays, SWEEP_BATCH_SIZE);
    deleted += removed;
    if (removed < SWEEP_BATCH_SIZE) break;
  }

  if (deleted > 0) {
    log('info', 'click retention sweep', { deleted, retentionDays });
  }

  return deleted;
}

/**
 * Starts the retention timer.
 *
 * The first sweep runs one interval after start rather than immediately, so a
 * restart loop cannot turn into a delete loop.
 *
 * The timer is unreferenced, so it never holds the process open on its own. A
 * service that refuses to exit because housekeeping is scheduled is a service
 * that fails its shutdown deadline for no reason.
 *
 * @returns A function that stops the timer.
 */
export function startClickRetention(): () => void {
  const timer = setInterval(() => {
    void sweepExpiredClicks().catch((error: unknown) => {
      // A failed sweep is not a failed service. The next one will cover the same
      // rows, since nothing here depends on a sweep having run.
      log('error', 'click retention sweep failed', describeError(error));
    });
  }, SWEEP_INTERVAL_MS);

  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
