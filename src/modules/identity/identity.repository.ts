import type pg from 'pg';

import { pool } from '../../db/pool.ts';
import { hashSessionId } from '../../lib/sessionId.ts';
import type { Session, User, UserWithHash } from './identity.schema.ts';

/** SQL for users and sessions, and nothing else. */

type UserRow = {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly created_at: Date;
};

type SessionRow = {
  readonly id: string;
  readonly user_id: string;
  readonly expires_at: Date;
};

/**
 * Converts a user row, dropping the hash.
 *
 * @param row - The row.
 * @returns The user, without credentials attached.
 */
function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

/**
 * Converts a user row, keeping the hash.
 *
 * Separate from {@link toUser} so that the hash travels only where it is needed.
 * A single converter that always included it would make leaking the hash into a
 * response a one-line mistake.
 *
 * @param row - The row.
 * @returns The user with the stored hash.
 */
function toUserWithHash(row: UserRow): UserWithHash {
  return { ...toUser(row), passwordHash: row.password_hash };
}

/**
 * Inserts a user.
 *
 * No existence check first: that would be a race, and the unique constraint is
 * the authority.
 *
 * @param email - Already lowercased and validated.
 * @param passwordHash - The encoded hash.
 * @returns The created user.
 * @throws A `pg` error with SQLSTATE `23505` when the address exists. Callers
 *   test for it with {@link isEmailConflict}.
 */
export async function insertUser(email: string, passwordHash: string): Promise<User> {
  const result = await pool().query<UserRow>(
    `insert into users (email, password_hash)
     values ($1, $2)
     returning id, email, password_hash, created_at`,
    [email, passwordHash],
  );

  const row = result.rows[0];
  if (row === undefined) throw new Error('User insert returned no row.');
  return toUser(row);
}

/**
 * Finds a user by email, with the stored hash.
 *
 * @param email - Already lowercased.
 * @returns The user and hash, or `undefined`.
 */
export async function findUserByEmail(email: string): Promise<UserWithHash | undefined> {
  const result = await pool().query<UserRow>(
    `select id, email, password_hash, created_at from users where email = $1`,
    [email],
  );

  const row = result.rows[0];
  return row === undefined ? undefined : toUserWithHash(row);
}

/**
 * Creates a session.
 *
 * @param id - The generated session id.
 * @param userId - Who it belongs to.
 * @param ttlSeconds - Lifetime from now.
 * @returns The stored session.
 */
export async function insertSession(
  sessionId: string,
  userId: string,
  ttlSeconds: number,
): Promise<Session> {
  // Expiry is computed by the database, from the database's own clock. Sending
  // a timestamp computed here would make sessions expire according to whichever
  // clock happened to drift.
  const result = await pool().query<SessionRow>(
    `insert into sessions (id, user_id, expires_at)
     values ($1, $2, now() + make_interval(secs => $3))
     returning id, user_id, expires_at`,
    [hashSessionId(sessionId), userId, ttlSeconds],
  );

  const row = result.rows[0];
  if (row === undefined) throw new Error('Session insert returned no row.');

  // The identifier travels back out, not the hash the row holds. The caller puts
  // this value in the cookie, and it is the only copy of it that will ever
  // exist: nothing else in the process keeps it and nothing writes it down.
  return { id: sessionId, userId: row.user_id, expiresAt: row.expires_at };
}

/**
 * Finds the user owning an unexpired session.
 *
 * Expiry is filtered in SQL against `now()`, so an expired session is
 * indistinguishable from an absent one to every caller. That is the correct
 * answer: both mean unauthenticated.
 *
 * @param sessionId - The value from the cookie.
 * @returns The user, or `undefined` when the session is unknown or expired.
 */
export async function findUserBySession(sessionId: string): Promise<User | undefined> {
  const result = await pool().query<UserRow>(
    `select u.id, u.email, u.password_hash, u.created_at
     from sessions s
     join users u on u.id = s.user_id
     where s.id = $1 and s.expires_at > now()`,
    [hashSessionId(sessionId)],
  );

  const row = result.rows[0];
  return row === undefined ? undefined : toUser(row);
}

/**
 * Deletes a session.
 *
 * @param sessionId - The session to end.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await pool().query('delete from sessions where id = $1', [hashSessionId(sessionId)]);
}

/**
 * Deletes expired sessions.
 *
 * Called opportunistically rather than on a schedule. A scheduler is a whole
 * subsystem, and this is one statement that can run whenever a session is
 * created anyway.
 *
 * @returns How many rows were removed.
 */
export async function deleteExpiredSessions(): Promise<number> {
  const result = await pool().query('delete from sessions where expires_at <= now()');
  return result.rowCount ?? 0;
}

/** SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Reports whether an error is a duplicate email.
 *
 * Checks the constraint name as well as the code. `links_slug_unique` raises
 * the same SQLSTATE, so a code-only check would let one module misreport the
 * other's conflicts.
 *
 * @param error - Anything caught from a query.
 * @returns `true` when the address is already registered.
 */
export function isEmailConflict(error: unknown): boolean {
  const candidate = error as Partial<pg.DatabaseError> | null;
  return candidate?.code === UNIQUE_VIOLATION && candidate.constraint === 'users_email_unique';
}
