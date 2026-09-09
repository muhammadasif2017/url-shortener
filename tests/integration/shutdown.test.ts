import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { closePool, pool } from '../../src/db/pool.ts';
import { pendingWriteCount, recordClick } from '../../src/modules/analytics/analytics.service.ts';
import { linkRoutes } from '../../src/modules/links/links.routes.ts';
import { performShutdown, type ClosableServer } from '../../src/shutdown.ts';
import { insertLink, truncateLinks } from '../helpers/db.ts';
import { startTestServer } from '../helpers/server.ts';

/**
 * The graceful shutdown sequence.
 *
 * The sequence is called directly rather than by signalling a child process.
 * Windows does not deliver a real `SIGTERM`: `process.kill` terminates the
 * target immediately instead, so the graceful path cannot be reached that way
 * on this machine. Calling it here proves the ordering, which is the part that
 * is easy to get wrong; that the signal handler is wired to it is one line in
 * `src/index.ts` and is visible there.
 *
 * `performShutdown` closes the pool as its last step. `pool()` rebuilds one on
 * demand, so assertions after a shutdown still work.
 */

beforeEach(async () => {
  await truncateLinks();
});

after(async () => {
  await closePool();
});

/**
 * A stand-in server whose close is controlled by the test.
 *
 * A real listener would close as fast as the event loop allows, which is too
 * fast to observe anything. This one finishes step 1 only when released.
 *
 * @returns The stand-in and the function that lets its close complete.
 */
function controllableServer(): {
  readonly server: ClosableServer;
  readonly release: () => void;
} {
  let release: () => void = () => undefined;

  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    server: {
      close(callback) {
        void closed.then(() => callback());
      },
    },
    release,
  };
}

describe('performShutdown', () => {
  it('drains click writes before closing the pool', async () => {
    const link = await insertLink();

    // Registered before the sequence starts, and left outstanding.
    recordClick({
      linkId: link.id,
      clientIp: '203.0.113.5',
      referrer: undefined,
      userAgent: undefined,
    });

    const code = await performShutdown({ close: (callback) => callback() }, 'SIGTERM');
    assert.equal(code, 0);

    // Reaching the database at all proves the pool closed after the write, and
    // finding the row proves the drain ran rather than being skipped.
    const result = await pool().query<{ n: number }>(
      'select count(*)::int as n from click_events where link_id = $1',
      [link.id],
    );
    assert.equal(result.rows[0]?.n, 1);
    assert.equal(pendingWriteCount(), 0);
  });

  it('waits for in-flight requests before draining', async () => {
    const server = await startTestServer(linkRoutes);
    const link = await insertLink();
    const { server: stand, release } = controllableServer();

    const shutdown = performShutdown(stand, 'SIGTERM');

    // A request that lands while step 1 is still waiting. Its click write is
    // registered after the shutdown began, which is the case a drain placed
    // before step 1 would miss entirely.
    const response = await server.fetch(`/${link.slug}`);
    assert.equal(response.status, 302);

    release();
    assert.equal(await shutdown, 0);

    const result = await pool().query<{ n: number }>(
      'select count(*)::int as n from click_events where link_id = $1',
      [link.id],
    );
    assert.equal(result.rows[0]?.n, 1);

    await server.close();
  });

  it('reports failure rather than throwing when a step rejects', async () => {
    const failing: ClosableServer = {
      close(callback) {
        callback(new Error('close failed'));
      },
    };

    // A shutdown that throws would skip its remaining steps and exit 0 anyway,
    // which is how a broken shutdown looks identical to a clean one.
    assert.equal(await performShutdown(failing, 'SIGTERM'), 1);
  });
});
