import type { Server } from 'node:http';

import { env } from './config/env.ts';
import { closePool } from './db/pool.ts';
import { describeError, log } from './lib/logger.ts';
import { identityRoutes } from './modules/identity/identity.routes.ts';
import { linkRoutes } from './modules/links/links.routes.ts';
import { createAppServer } from './server.ts';

/**
 * Process entry point.
 *
 * Owns exactly three things: reading configuration, listening, and shutting
 * down cleanly. Everything else lives in `server.ts`, which is testable because
 * it never listens.
 */

/** How long to wait for in-flight requests before forcing exit. */
const DRAIN_TIMEOUT_MS = 10_000;

/**
 * Starts the service.
 *
 * Configuration is read first and deliberately not caught. A missing or invalid
 * variable stops the process here, with every problem listed, rather than
 * producing a confusing failure on the first request that needed it.
 */
function main(): void {
  const config = env();

  // Every module's routes are assembled here, in one visible list, rather than
  // registered by import side effects. A route that exists only because a file
  // was imported is a route nobody can find later.
  const server = createAppServer([...linkRoutes, ...identityRoutes]);

  server.listen(config.port, () => {
    log('info', 'server listening', {
      port: config.port,
      env: config.nodeEnv,
      baseUrl: config.baseUrl,
    });
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(server, signal);
    });
  }
}

/**
 * Shuts down in an order that does not lose work.
 *
 * The order matters and is easy to get wrong. `server.close()` stops new
 * connections; it does **not** wait for in-flight requests. Closing the pool
 * immediately afterwards would fail the requests still running, so the wait
 * comes between them.
 *
 * Every step is bounded. An unbounded wait against a hung database means the
 * platform sends `SIGKILL` and discards everything anyway, so a deadline with a
 * logged timeout is strictly better than waiting forever.
 *
 * @param server - The listening server.
 * @param signal - Which signal triggered the shutdown, for the log line.
 */
async function shutdown(server: Server, signal: string): Promise<void> {
  log('info', 'shutting down', { signal });

  try {
    // Step 1: stop accepting new connections, and wait for open ones to finish.
    await withDeadline(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      DRAIN_TIMEOUT_MS,
      'in-flight requests',
    );

    // Step 2 belongs here once analytics exists: drain pending click writes,
    // which are started deliberately without being awaited. Draining before
    // in-flight requests finish would miss the events those requests add.

    // Step 3: close the pool, now that nothing needs it.
    await closePool();

    log('info', 'shutdown complete');
    process.exit(0);
  } catch (error) {
    log('error', 'shutdown failed', describeError(error));
    process.exit(1);
  }
}

/**
 * Bounds a shutdown step.
 *
 * A timeout is logged rather than thrown, because a slow step should not stop
 * the remaining steps from running.
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

main();
