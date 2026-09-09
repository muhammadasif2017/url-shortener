import type pg from 'pg';

import { pool } from './pool.ts';

/**
 * Transaction helper.
 *
 * The reason this exists rather than each caller writing `BEGIN` and `COMMIT`:
 * the rollback is easy to forget, and a forgotten rollback does not fail
 * loudly. It returns the connection to the pool with an open transaction, and
 * the next unrelated query inherits it. That produces a bug far from its cause.
 */

/**
 * Runs a function inside a transaction on a single connection.
 *
 * The callback receives the connection and must use it for every query. Using
 * the pool instead would run that query on a different connection, outside the
 * transaction, which is the subtle mistake this helper exists to prevent.
 *
 * @param work - Receives the transactional client.
 * @returns Whatever the callback returns, after the commit succeeds.
 * @throws Whatever the callback throws, after rolling back.
 */
export async function withTransaction<T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();

  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    // The rollback itself can fail, typically because the connection is already
    // gone. Swallowing that is correct: the original error is the one worth
    // reporting, and a dead connection rolls back on its own when released.
    try {
      await client.query('rollback');
    } catch {
      // Intentionally ignored. See above.
    }
    throw error;
  } finally {
    client.release();
  }
}
