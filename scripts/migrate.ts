import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, pool } from '../src/db/pool.ts';

/**
 * Migration runner.
 *
 * Numbered SQL files, applied in filename order, each recorded once. There is
 * no migration library here, and the rules it would enforce are enforced
 * instead by three properties of this script:
 *
 * 1. Each file runs inside a transaction, so a file that fails halfway leaves
 *    no partial schema behind.
 * 2. Applied filenames are recorded in the same transaction as the change, so
 *    the record and the schema cannot disagree.
 * 3. An advisory lock serialises concurrent runs, so two deploys starting at
 *    once do not both apply the same file.
 */

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Lock key for `pg_advisory_lock`. Arbitrary but fixed: any two runners using
 * the same number exclude each other, which is the entire point.
 */
const LOCK_KEY = 8_274_113;

/** A migration file on disk. */
type Migration = {
  readonly filename: string;
  readonly sql: string;
};

/**
 * Creates the bookkeeping table if it does not exist.
 *
 * @param client - A connected client.
 */
async function ensureMigrationsTable(client: {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      filename    text primary key,
      applied_at  timestamptz not null default now()
    )
  `);
}

/**
 * Reads every migration file, in filename order.
 *
 * Numeric prefixes are zero-padded, so lexicographic order is also numeric
 * order. `002` sorting before `010` is why the padding matters.
 *
 * @returns Migrations in the order they must be applied.
 */
async function loadMigrations(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const filenames = entries.filter((name) => name.endsWith('.sql')).sort();

  return Promise.all(
    filenames.map(async (filename) => ({
      filename,
      sql: await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8'),
    })),
  );
}

/**
 * Applies every migration that has not been applied yet.
 *
 * Idempotent: running it twice applies nothing the second time.
 */
async function up(): Promise<void> {
  const client = await pool().connect();

  try {
    // Held until this connection is released. A second runner blocks here
    // rather than racing, so two deploys cannot apply the same file twice.
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureMigrationsTable(client);

    const applied = await client.query<{ filename: string }>(
      'select filename from schema_migrations',
    );
    const seen = new Set(applied.rows.map((row) => row.filename));

    const migrations = await loadMigrations();
    const pending = migrations.filter((migration) => !seen.has(migration.filename));

    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }

    for (const migration of pending) {
      // Both the schema change and its record commit together, or neither does.
      await client.query('begin');
      try {
        await client.query(migration.sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [
          migration.filename,
        ]);
        await client.query('commit');
        console.log(`Applied ${migration.filename}`);
      } catch (error) {
        await client.query('rollback');
        throw new Error(`Migration failed: ${migration.filename}`, { cause: error });
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {
      // Releasing the connection drops the lock anyway.
    });
    client.release();
  }
}

/** Prints which migrations are applied and which are pending. */
async function status(): Promise<void> {
  const client = await pool().connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await client.query<{ filename: string }>(
      'select filename from schema_migrations',
    );
    const seen = new Set(applied.rows.map((row) => row.filename));

    for (const migration of await loadMigrations()) {
      console.log(`${seen.has(migration.filename) ? 'applied' : 'pending'}  ${migration.filename}`);
    }
  } finally {
    client.release();
  }
}

/**
 * Creates an empty migration file with the next number.
 *
 * @param name - Descriptive suffix, such as `add_owner_id`.
 */
async function create(name: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error('Migration name must use lowercase letters, digits, and underscores.');
  }

  const existing = await loadMigrations();
  const next = String(existing.length + 1).padStart(3, '0');
  const filename = `${next}_${name}.sql`;

  await writeFile(
    path.join(MIGRATIONS_DIR, filename),
    `-- ${filename}\n-- Describe why this change is needed, not what it does.\n`,
    { flag: 'wx' },
  );

  console.log(`Created migrations/${filename}`);
}

/**
 * Entry point. Dispatches on the first command-line argument.
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';

  switch (command) {
    case 'up':
      await up();
      break;
    case 'status':
      await status();
      break;
    case 'new': {
      const name = process.argv[3];
      if (name === undefined) throw new Error('Usage: migrate new <name>');
      await create(name);
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.cause !== undefined) console.error(error.cause);
  process.exitCode = 1;
} finally {
  await closePool();
}
