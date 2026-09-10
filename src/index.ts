import type { Server } from 'node:http';

import { env } from './config/env.ts';
import { saltFingerprint } from './lib/ipHash.ts';
import { log } from './lib/logger.ts';
import { startClickRetention } from './modules/analytics/analytics.retention.ts';
import { analyticsRoutes } from './modules/analytics/analytics.routes.ts';
import { identityRoutes } from './modules/identity/identity.routes.ts';
import { linkRoutes } from './modules/links/links.routes.ts';
import { createAppServer } from './server.ts';
import { performShutdown } from './shutdown.ts';

/**
 * Process entry point.
 *
 * Owns exactly three things: reading configuration, listening, and reacting to
 * a signal. The shutdown sequence itself lives in `shutdown.ts`, which is
 * testable because it never exits, and the server lives in `server.ts`, which
 * is testable because it never listens.
 */

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
  const server: Server = createAppServer([
    ...linkRoutes,
    ...identityRoutes,
    ...analyticsRoutes,
  ]);

  // Click events expire. The timer is unreferenced, so it never delays exit, and
  // it is started here rather than inside the analytics module so that importing
  // that module in a test does not schedule deletions.
  startClickRetention();

  server.listen(config.port, () => {
    log('info', 'server listening', {
      port: config.port,
      env: config.nodeEnv,
      baseUrl: config.baseUrl,
      clickRetentionDays: config.clickRetentionDays,

      // A digest of the salt, never the salt. Rotating IP_HASH_SALT resets
      // unique-visitor counts, so this is what makes a discontinuity in those
      // numbers explainable later: same fingerprint means the salt did not
      // change and the drop was real traffic.
      ipHashSalt: saltFingerprint(config.ipHashSalt),
    });
  });

  // One flag across both signals, not `once` per signal. `once` only stops a
  // repeat of the same signal: SIGTERM followed by SIGINT would otherwise start
  // the sequence twice, and both runs would race the pool close.
  let shuttingDown = false;

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;

      void performShutdown(server, signal).then((code) => {
        process.exit(code);
      });
    });
  }
}

main();
