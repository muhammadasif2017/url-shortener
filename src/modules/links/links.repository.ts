import type pg from 'pg';

import { pool } from '../../db/pool.ts';
import type { Link } from './links.schema.ts';

/**
 * SQL for the links table, and nothing else.
 *
 * No business rules live here. A repository function decides how to ask the
 * database a question; whether the question should be asked is the service's
 * decision. Keeping that line sharp is what makes both testable.
 */

/** The shape a row arrives in, before conversion to camelCase. */
type LinkRow = {
  /** `bigint`, which `pg` returns as a string. It stays one. */
  readonly id: string;
  readonly slug: string;
  readonly url: string;
  readonly expires_at: Date | null;
  readonly created_at: Date;
  readonly owner_id: string | null;
};

/** Columns every query selects, so a row always maps the same way. */
const COLUMNS = 'id, slug, url, expires_at, created_at, owner_id';

/**
 * Converts a database row to the shape the rest of the service uses.
 *
 * This is the one place `snake_case` becomes `camelCase`. Letting a row escape
 * unconverted means every caller has to know the column names, and the
 * database's naming becomes the API's naming by accident.
 *
 * @param row - A row from any query in this module.
 * @returns The link.
 */
function toLink(row: LinkRow): Link {
  return {
    id: row.id,
    slug: row.slug,
    url: row.url,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    ownerId: row.owner_id,
  };
}

/** Fields needed to insert a link. */
export type InsertLink = {
  readonly slug: string;
  readonly url: string;
  readonly expiresAt?: Date | undefined;
  /** Owner, or absent for an anonymous link. */
  readonly ownerId?: string | undefined;
};

/**
 * Inserts a link.
 *
 * No existence check runs first, deliberately. Checking and then inserting is a
 * race: another request can take the slug in between. The unique index is the
 * authority, and a caller handles the violation it raises.
 *
 * @param input - The link to store.
 * @returns The stored link, including its generated id and timestamps.
 * @throws A `pg` error with SQLSTATE `23505` when the slug is taken. Callers
 *   test for it with {@link isSlugConflict}.
 */
export async function insert(input: InsertLink): Promise<Link> {
  const result = await pool().query<LinkRow>(
    `insert into links (slug, url, expires_at, owner_id)
     values ($1, $2, $3, $4)
     returning ${COLUMNS}`,
    [input.slug, input.url, input.expiresAt ?? null, input.ownerId ?? null],
  );

  const row = result.rows[0];
  if (row === undefined) throw new Error('Insert returned no row.');
  return toLink(row);
}

/**
 * Finds a link by slug, whether or not it has expired.
 *
 * Expiry is not filtered here on purpose. The caller needs the row to tell 410
 * apart from 404, and a query that hid expired rows would make both look the
 * same.
 *
 * @param slug - The slug to look up. Matched case-sensitively, as URLs are.
 * @returns The link, or `undefined` when no such slug exists.
 */
export async function findBySlug(slug: string): Promise<Link | undefined> {
  const result = await pool().query<LinkRow>(
    `select ${COLUMNS} from links where slug = $1`,
    [slug],
  );

  const row = result.rows[0];
  return row === undefined ? undefined : toLink(row);
}

/**
 * Reports whether a link has expired, according to the database clock.
 *
 * Expiry is evaluated in SQL rather than in JavaScript so that one clock
 * governs the decision. A service comparing against its own clock would answer
 * differently from the database whenever the two drift.
 *
 * @param slug - The slug to check.
 * @returns `true` when the row exists and its expiry has passed.
 */
export async function isExpired(slug: string): Promise<boolean> {
  const result = await pool().query<{ expired: boolean }>(
    `select (expires_at is not null and expires_at <= now()) as expired
     from links where slug = $1`,
    [slug],
  );

  return result.rows[0]?.expired ?? false;
}

/**
 * Lists links newest first, using keyset pagination.
 *
 * Ordered by `id desc`, which is total on its own because `id` is
 * `generated always as identity`. That lets the primary key index serve the
 * query and leaves nothing to encode in a cursor beyond the id itself.
 *
 * `OFFSET` is not used. It scans and discards every preceding row, and rows
 * inserted while paging shift the offset, so items are seen twice or missed.
 *
 * Scoped to one owner. There is no query here that lists every link
 * regardless of owner, and that absence is deliberate: an endpoint cannot
 * accidentally expose other people's links if the query to do so does not
 * exist.
 *
 * The `(owner_id, id desc)` index matches this shape exactly, so the database
 * walks the index backwards and stops at the page size instead of scanning
 * every link ever stored.
 *
 * @param options.ownerId - Whose links to return.
 * @param options.limit - Maximum rows to return.
 * @param options.cursorId - Return rows with an id below this. Absent for the
 *   first page.
 * @returns Up to `limit` links, newest first.
 */
export async function listByOwner(options: {
  readonly ownerId: string;
  readonly limit: number;
  readonly cursorId?: string | undefined;
}): Promise<Link[]> {
  const { ownerId, limit, cursorId } = options;

  const result =
    cursorId === undefined
      ? await pool().query<LinkRow>(
          `select ${COLUMNS} from links
           where owner_id = $1
           order by id desc limit $2`,
          [ownerId, limit],
        )
      : await pool().query<LinkRow>(
          `select ${COLUMNS} from links
           where owner_id = $1 and id < $2
           order by id desc limit $3`,
          [ownerId, cursorId, limit],
        );

  return result.rows.map(toLink);
}

/**
 * Deletes a link.
 *
 * Takes no owner filter. Whether the caller may delete this link is a business
 * rule, decided by the service after it has read the row, because answering 403
 * rather than 404 requires knowing that the link exists and belongs to somebody
 * else.
 *
 * @param slug - The slug to delete.
 * @returns `true` when a row was deleted, `false` when none matched.
 */
export async function remove(slug: string): Promise<boolean> {
  const result = await pool().query('delete from links where slug = $1', [slug]);
  return (result.rowCount ?? 0) > 0;
}

/** SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Reports whether an error is a slug collision.
 *
 * The constraint name is checked as well as the code, and that is not
 * defensive padding. The identity module adds `unique (email)` to `users`, so a
 * bare code check would report a duplicate email as a slug collision and answer
 * a registration attempt with 409 `SLUG_TAKEN`.
 *
 * @param error - Anything caught from a query.
 * @returns `true` when the error is a violation of the slug unique index.
 */
export function isSlugConflict(error: unknown): boolean {
  const candidate = error as Partial<pg.DatabaseError> | null;
  return (
    candidate?.code === UNIQUE_VIOLATION && candidate.constraint === 'links_slug_unique'
  );
}
