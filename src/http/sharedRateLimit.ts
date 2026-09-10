import { pool } from '../db/pool.ts';
import { describeError, log } from '../lib/logger.ts';
import type { RateLimitDecision } from './rateLimit.ts';

/**
 * Rate-limit counters held in PostgreSQL, so every instance counts together.
 *
 * The in-process limiter in `rateLimit.ts` counts per process. Two instances
 * keep two counters and the effective limit is the configured maximum times the
 * instance count, which turns the ten-attempt credential limit into ten per
 * instance. This module is the counter that does not do that.
 *
 * One round trip per limited request is the price, and it is why this is used on
 * the API paths only. `src/server.ts` records where the line is drawn and why.
 */

/** How one shared limit is configured. */
export type SharedRateLimitOptions = {
  /** Requests permitted per window. */
  readonly max: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
};

/**
 * How often the sweep of expired rows is attempted, as a fraction of calls.
 *
 * Housekeeping rides on a path that is already writing, which is the shape
 * `deleteExpiredSessions` established. It runs on a sample of calls rather than
 * every one, because unlike sessions this table is written on every limited
 * request and a delete alongside each of them would cost more than the dead rows
 * do.
 */
const SWEEP_PROBABILITY = 0.01;

/**
 * Counts one request against a bucket and decides whether it may proceed.
 *
 * The count and the window roll over in a single statement. Reading the row and
 * then writing a decision based on it would be two statements with a gap in the
 * middle, and under concurrency that gap is where a limit is exceeded: several
 * requests read the same count and all conclude they are the next one.
 *
 * An expired row is treated as absent by the same statement, so a window resets
 * correctly whether or not the sweep has removed it.
 *
 * @param bucket - Purpose prefix and identity, such as `api:203.0.113.4`. Never
 *   personal data: a caller keying on an email address hashes it first.
 * @param options - Limit and window.
 * @returns The decision.
 * @throws Whatever the database throws. The caller decides what an unavailable
 *   counter means, because the answer differs by route.
 */
export async function checkSharedLimit(
  bucket: string,
  options: SharedRateLimitOptions,
): Promise<RateLimitDecision> {
  const windowSeconds = options.windowMs / 1000;

  const result = await pool().query<{ count: number; retry_after_seconds: number }>(
    `insert into rate_limit_windows (bucket, count, expires_at)
     values ($1, 1, now() + make_interval(secs => $2))
     on conflict (bucket) do update
       set count = case
                     when rate_limit_windows.expires_at <= now() then 1
                     else rate_limit_windows.count + 1
                   end,
           expires_at = case
                          when rate_limit_windows.expires_at <= now()
                            then now() + make_interval(secs => $2)
                          else rate_limit_windows.expires_at
                        end
     returning count,
               greatest(1, ceil(extract(epoch from expires_at - now())))::int
                 as retry_after_seconds`,
    [bucket, windowSeconds],
  );

  const row = result.rows[0];
  if (row === undefined) throw new Error('Rate limit upsert returned no row.');

  if (Math.random() < SWEEP_PROBABILITY) void sweepExpired();

  return {
    allowed: row.count <= options.max,
    remaining: Math.max(0, options.max - row.count),
    retryAfterSeconds: row.retry_after_seconds,
  };
}

/**
 * Reads a bucket without counting against it.
 *
 * The check before a failure is counted has to be a read, or the check itself
 * becomes the attempt it is trying to measure.
 *
 * @param bucket - Purpose prefix and identity.
 * @param options - Limit and window.
 * @returns The decision implied by the current count, or an allowing decision
 *   when the bucket is absent or expired.
 * @throws Whatever the database throws.
 */
export async function peekSharedLimit(
  bucket: string,
  options: SharedRateLimitOptions,
): Promise<RateLimitDecision> {
  const result = await pool().query<{ count: number; retry_after_seconds: number }>(
    `select count,
            greatest(1, ceil(extract(epoch from expires_at - now())))::int
              as retry_after_seconds
     from rate_limit_windows
     where bucket = $1 and expires_at > now()`,
    [bucket],
  );

  const row = result.rows[0];
  if (row === undefined) {
    return {
      allowed: true,
      remaining: options.max,
      retryAfterSeconds: Math.ceil(options.windowMs / 1000),
    };
  }

  // Strictly less than, where `checkSharedLimit` uses less than or equal. The
  // difference is what each count means. There, the current request has already
  // been counted, so spending the last of the budget is still allowed. Here the
  // count is of events that have already happened, and a budget already spent
  // means the next thing must be refused.
  return {
    allowed: row.count < options.max,
    remaining: Math.max(0, options.max - row.count),
    retryAfterSeconds: row.retry_after_seconds,
  };
}

/**
 * Deletes rows whose window has passed.
 *
 * Never awaited by a request. A failed sweep leaves dead rows, which the upsert
 * already treats as absent; failing a request over it would be the worse
 * outcome.
 */
async function sweepExpired(): Promise<void> {
  try {
    await pool().query('delete from rate_limit_windows where expires_at <= now()');
  } catch (error) {
    log('warn', 'rate limit sweep failed', describeError(error));
  }
}
