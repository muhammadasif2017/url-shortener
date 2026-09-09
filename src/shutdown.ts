import { closePool } from './db/pool.ts';
import { describeError, log } from './lib/logger.ts';
import { drainPendingWrites } from './modules/analytics/analytics.service.ts';

/**
 * The graceful shutdown sequence.
 *
 * Separate from the entry point so it can be tested. Windows does not deliver a
 * real `SIGTERM`, so a test that signals a child process cannot exercise this
 * path at all; calling the sequence directly can, and the ordering is the part
 * that is worth proving.
 *
 * The order is the whole design, and it is easy to get wrong in two directions.
 * `server.close()` stops new connections but does **not** wait for in-flight
 * requests, so closing the pool straight afterwards fails work that is still
 * running. And those same in-flight requests keep registering click writes as
 * they finish, so draining before they are done returns before the last events
 * exist.
 */

/** How long to wait for in-flight requests before giving up on them. */
const REQUEST_DRAIN_TIMEOUT_MS = 10_000;

/**
 * How long to wait for pending click writes.
 *
 * Shorter than the request wait, deliberately. A request still running has a
 * caller waiting for an answer; a click write has nobody waiting, and losing
 * one is already accepted in `SPEC-analytics.md`.
 */
const CLICK_DRAIN_TIMEOUT_MS = 5_000;

/** Exit code for a shutdown that completed every step. */
const EXIT_OK = 0;
/** Exit code for a shutdown that threw. */
const EXIT_FAILED = 1;

/**
 * The part of `http.Server` this sequence uses.
 *
 * Narrow on purpose, so a test can pass a stand-in whose close is controlled
 * rather than starting and stopping a real listener to observe ordering.
 */
export type ClosableServer = {
  close(callback: (error?: Error) => void): unknown;
};

/**
 * Runs the shutdown steps in order.
 *
 * Does not exit the process. The caller decides that, which is what makes this
 * callable from a test.
 *
 * @param server - The listening server.
 * @param signal - Which signal triggered this, for the log line.
 * @returns The exit code the process should use.
 */
export async function performShutdown(
  server: ClosableServer,
  signal: string,
): Promise<number> {
  log('info', 'shutting down', { signal });

  try {
    // Steps 1 and 2 of the sequence in `SPEC.md`, in one await: `close` stops
    // accepting connections immediately and calls back once the open ones have
    // finished.
    await withDeadline(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      REQUEST_DRAIN_TIMEOUT_MS,
      'in-flight requests',
    );

    // Step 3: drain click writes, which were started without being awaited.
    // This cannot move above the wait: requests still finishing keep
    // registering writes, and a drain that ran first would miss exactly those.
    //
    // The drain itself is unbounded, because only this sequence knows how much
    // time the process has left. The bound lives here.
    await withDeadline(drainPendingWrites(), CLICK_DRAIN_TIMEOUT_MS, 'pending click writes');

    // Step 4: close the pool, now that nothing needs it. Step 5, the exit, is
    // the caller's, which is what makes this function testable.
    await closePool();

    log('info', 'shutdown complete');
    return EXIT_OK;
  } catch (error) {
    log('error', 'shutdown failed', describeError(error));
    return EXIT_FAILED;
  }
}

/**
 * Bounds one shutdown step.
 *
 * A timeout is logged rather than thrown, because a slow step must not stop the
 * remaining steps from running. An unbounded wait against a hung database means
 * the platform sends `SIGKILL` and discards everything anyway, so a deadline is
 * strictly better than waiting forever.
 *
 * @param work - The step.
 * @param milliseconds - How long to allow.
 * @param what - Name of the step, for the log line.
 */
async function withDeadline(
  work: Promise<void>,
  milliseconds: number,
  what: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log('warn', 'shutdown step timed out', { step: what, milliseconds });
      resolve();
    }, milliseconds);
  });

  try {
    await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
