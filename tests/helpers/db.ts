import { pool } from '../../src/db/pool.ts';
import { drainPendingWrites } from '../../src/modules/analytics/analytics.service.ts';

/**
 * Database helpers for integration tests.
 *
 * Tests run against a real PostgreSQL database, never a mock. A mocked query
 * proves the code called a function; it proves nothing about whether the SQL is
 * valid, whether a constraint fires, or whether a column exists.
 */

/**
 * Empties every table a test writes to.
 *
 * One statement, not several, and that is the whole point of this function
 * rather than a convenience. `truncate` takes an `access exclusive` lock on
 * every table it reaches, including the ones reached by `cascade`. Truncating
 * `users` and then `links` in two statements takes those locks in two
 * overlapping sets, and a redirect's click write, which is deliberately not
 * awaited and so is still in flight, holds a lock on `click_events` while
 * waiting for one on `links`. That is a lock cycle, and PostgreSQL breaks it by
 * failing one side with `40P01 deadlock detected`. It surfaced as a test that
 * failed roughly one run in five, in a different file each time.
 *
 * Draining first removes the other half of the cycle. Listing every table in one
 * statement removes the rest: locks are then taken once, in an order PostgreSQL
 * chooses consistently.
 *
 * `restart identity` so ids start from one in every test file, which makes tests
 * that assert on pagination order readable. `cascade` reaches `sessions` and
 * `click_events` through their foreign keys.
 *
 * Call this in `beforeEach`, not `afterEach`. Cleaning before means a failed
 * test leaves its rows behind for inspection, and the next test still starts
 * from a known state.
 */
export async function resetDatabase(): Promise<void> {
  await drainPendingWrites();
  await pool().query('truncate table users, links, rate_limit_windows restart identity cascade');
}

/**
 * Empties the links table and everything that references it.
 *
 * For the files that never create an account. Drains first for the same reason
 * {@link resetDatabase} does.
 */
export async function truncateLinks(): Promise<void> {
  await drainPendingWrites();
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
