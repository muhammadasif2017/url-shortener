import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, pool } from '../../src/db/pool.ts';

/**
 * The pool's error listener.
 *
 * `pg` emits `error` on the pool when a client sitting idle loses its
 * connection, and an `error` event with no listener is an uncaught exception in
 * Node. Without a listener the process exits whenever the database restarts,
 * fails over, or drops a backend, which is what happened during the
 * multi-instance experiments: both containers died within a second of each
 * other with `terminating connection due to administrator command`.
 *
 * Nothing in the rest of the suite could catch that. Every other test runs
 * against a database that stays up, and reproducing the real failure needs the
 * server to drop an idle connection, which a test cannot arrange without
 * restarting PostgreSQL underneath the whole suite.
 *
 * So this asserts the one thing that is both checkable here and sufficient: a
 * listener exists. Emitting a synthetic error would prove only that
 * `EventEmitter` works.
 */

after(async () => {
  await closePool();
});

describe('database pool', () => {
  it('listens for errors on idle clients, so a database restart cannot kill the process', () => {
    assert.ok(
      pool().listenerCount('error') > 0,
      'the pool has no error listener; a dropped idle connection would exit the process',
    );
  });
});
