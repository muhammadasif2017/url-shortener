import pg from 'pg';

import { env } from '../config/env.ts';

/**
 * The shared PostgreSQL connection pool.
 *
 * `pg` is the one production dependency this project allows, because PostgreSQL
 * speaks a binary wire protocol over TCP and Node has no client for it.
 *
 * Two type-parsing decisions are made here rather than left to each caller,
 * because a value that arrives in an unexpected shape produces a wrong answer
 * rather than an error.
 */

const { Pool, types } = pg;

/**
 * `bigint` (OID 20) stays a string.
 *
 * This is `pg`'s default and it is deliberate: a 64-bit integer does not fit in
 * a JavaScript number, so parsing one would silently lose precision above
 * 2^53. Setting it explicitly documents that the default is a decision.
 *
 * Consequence for callers: `links.id` is a string everywhere. A `count(*)` also
 * arrives as a string, so a repository returning a count converts it with
 * `Number()` at its own boundary, where the value is known to be small.
 */
types.setTypeParser(types.builtins.INT8, (value) => value);

/**
 * Builds the pool for the current environment.
 *
 * @returns A configured pool. Not connected yet; `pg` connects lazily.
 */
function createPool(): pg.Pool {
  const config = env();

  return new Pool({
    connectionString: config.databaseUrl,

    // Managed providers require TLS, and `pg` does not enable it implicitly.
    //
    // The certificate is verified. This previously set `rejectUnauthorized` to
    // false, on the reasoning that a managed provider signs with its own
    // authority and the container has no root for it. That reasoning describes
    // the problem correctly and then solves it by trusting whoever answers:
    // encryption without verification stops a passive listener and does nothing
    // about an active one, which can present its own certificate and read every
    // password hash and session id on the wire. The provider's own CA bundle
    // goes in DATABASE_CA_CERT instead, which is the part that was missing.
    //
    // Driven by its own setting rather than by NODE_ENV. Tying TLS to the
    // environment name made the production image impossible to run against a
    // local database: it demanded TLS from a server that has none, and the
    // health check reported the database as down. Verified by running the built
    // image against the Compose database.
    ...(config.databaseSsl
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(config.databaseCaCert === undefined ? {} : { ca: config.databaseCaCert }),
          },
        }
      : {}),

    // A single-process service on a free-tier database. More connections than
    // the database allows turns into connection errors under load, not speed.
    max: 10,

    // Fail rather than hang. A request that waits indefinitely for a connection
    // holds a socket open and tells the caller nothing.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

let instance: pg.Pool | undefined;

/**
 * Returns the process-wide pool, creating it on first use.
 *
 * Deferred rather than created at import time, so importing a module in a unit
 * test does not open a database connection.
 *
 * @returns The shared pool.
 */
export function pool(): pg.Pool {
  instance ??= createPool();
  return instance;
}

/**
 * Closes the pool.
 *
 * Called during graceful shutdown, after in-flight requests have finished and
 * after pending background writes have drained. Closing earlier would fail
 * work that is still running.
 */
export async function closePool(): Promise<void> {
  if (instance === undefined) return;
  const closing = instance;
  instance = undefined;
  await closing.end();
}
