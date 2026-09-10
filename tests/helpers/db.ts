import { pool } from '../../src/db/pool.ts';

/**
 * Database helpers for integration tests.
 *
 * Tests run against a real PostgreSQL database, never a mock. A mocked query
 * proves the code called a function; it proves nothing about whether the SQL is
 * valid, whether a constraint fires, or whether a column exists.
 */

/**
 * Empties the links table.
 *
 * `truncate` rather than `delete`, and `restart identity` so ids start from one
 * in every test file. Tests that assert on pagination order are easier to read
 * when ids are small and predictable.
 *
 * Call this in `beforeEach`, not `afterEach`. Cleaning before means a failed
 * test leaves its rows behind for inspection, and the next test still starts
 * from a known state.
 */
export async function truncateLinks(): Promise<void> {
  await pool().query('truncate table links restart identity cascade');
}

/**
 * Inserts a link directly, bypassing the API.
 *
 * For arranging state a test needs but is not exercising. Creating fixtures
 * through the API would make an unrelated failure in `POST /api/links` fail
 * every test that merely needed a row to exist.
 *
 * @param overrides.slug - Slug to use. Defaults to a unique one.
 * @param overrides.url - Destination. Defaults to a valid example URL.
 * @param overrides.expiresAt - Expiry. Absent means the link never expires.
 *   Set a past instant here to arrange an expired link: the column's check
 *   constraint only compares against `created_at`, which is also set.
 * @returns The stored slug and id.
 */
export async function insertLink(
  overrides: {
    readonly slug?: string;
    readonly url?: string;
    readonly expiresAt?: Date;
    readonly createdAt?: Date;
    readonly ownerId?: string;
  } = {},
): Promise<{ readonly id: string; readonly slug: string }> {
  const slug = overrides.slug ?? `t${Math.random().toString(36).slice(2, 8)}`;
  const url = overrides.url ?? 'https://example.com/target';

  // created_at is settable so that an expired link can be arranged without
  // violating the constraint that expiry must follow creation.
  const createdAt =
    overrides.createdAt ??
    (overrides.expiresAt === undefined
      ? new Date()
      : new Date(overrides.expiresAt.getTime() - 60_000));

  const result = await pool().query<{ id: string; slug: string }>(
    `insert into links (slug, url, expires_at, created_at, owner_id)
     values ($1, $2, $3, $4, $5)
     returning id, slug`,
    [slug, url, overrides.expiresAt ?? null, createdAt, overrides.ownerId ?? null],
  );

  const row = result.rows[0];
  if (row === undefined) throw new Error('Fixture insert returned no row.');
  return row;
}
