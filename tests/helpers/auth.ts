import { randomBytes } from 'node:crypto';

import { pool } from '../../src/db/pool.ts';
import type { TestServer } from './server.ts';

/**
 * Session helpers for integration tests.
 *
 * Node's global `fetch` keeps no cookie jar, so a test that signs in must read
 * the `Set-Cookie` header itself and send it back on the next request. Doing
 * that inline in every test would be noise; doing it wrong would make an
 * authorisation test pass because nothing was ever authenticated.
 */

/** A registered account and the cookie that authenticates it. */
export type TestAccount = {
  readonly email: string;
  readonly cookie: string;
  readonly userId: string;
};

/** Empties users and sessions. Links cascade from users, so this clears those too. */
export async function truncateUsers(): Promise<void> {
  await pool().query('truncate table users restart identity cascade');
}

/**
 * Registers a new account and returns its session cookie.
 *
 * Registration issues a session directly, so no separate sign-in is needed.
 *
 * @param server - The running test server.
 * @param email - Address to register. Defaults to a unique one, so two accounts
 *   in one test never collide on the unique constraint.
 * @returns The account and its cookie.
 */
export async function registerAccount(
  server: TestServer,
  email = `${randomBytes(6).toString('hex')}@example.com`,
): Promise<TestAccount> {
  const response = await server.fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'a sufficiently long passphrase' }),
  });

  if (response.status !== 201) {
    throw new Error(`Registration failed with ${response.status}: ${await response.text()}`);
  }

  const cookie = extractCookie(response);
  const body = (await response.json()) as { id: string };

  return { email, cookie, userId: body.id };
}

/**
 * Reads the session cookie from a response.
 *
 * `getSetCookie` is used rather than `headers.get('set-cookie')`, because a
 * response may carry several cookies and `get` would join them into one
 * unusable string.
 *
 * @param response - A response expected to set a session cookie.
 * @returns The `name=value` pair, ready to send as a `Cookie` header.
 */
export function extractCookie(response: Response): string {
  const headers = response.headers.getSetCookie();
  const session = headers.find((header) => header.startsWith('session='));

  if (session === undefined) {
    throw new Error(`No session cookie in response: ${JSON.stringify(headers)}`);
  }

  // Only the name=value pair travels back. The attributes describe how a
  // browser should store the cookie and are not part of what it sends.
  return session.split(';')[0] ?? '';
}

/**
 * Builds request headers carrying a session.
 *
 * @param cookie - The cookie from {@link registerAccount}.
 * @param extra - Additional headers.
 * @returns Headers for `fetch`.
 */
export function authHeaders(
  cookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { cookie, ...extra };
}
