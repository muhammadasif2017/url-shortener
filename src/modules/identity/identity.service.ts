import { randomBytes } from 'node:crypto';
import { unauthenticated } from '../../http/auth.ts';

import { env } from '../../config/env.ts';
import { AppError } from '../../lib/AppError.ts';
import { getDummyHash, hashPassword, verifyPassword } from '../../lib/password.ts';
import * as repository from './identity.repository.ts';
import type { CredentialsInput, Session, User } from './identity.schema.ts';

/** Business rules for accounts and sessions. */

/**
 * Session id length in bytes.
 *
 * 32 bytes of CSPRNG output. Guessing one is not a threat model worth
 * considering at that size, which is the entire security argument for an opaque
 * identifier: there is no signature to forge because there is nothing to sign.
 */
const SESSION_ID_BYTES = 32;

/**
 * Registers an account and signs it in.
 *
 * Registration issues a session immediately. Making someone register and then
 * sign in separately is friction with no security benefit, since they just
 * proved they know the password.
 *
 * @param input - Validated credentials.
 * @returns The user and their new session.
 * @throws {AppError} 409 when the address is already registered.
 */
export async function register(
  input: CredentialsInput,
): Promise<{ readonly user: User; readonly session: Session }> {
  const passwordHash = await hashPassword(input.password);

  let user: User;
  try {
    user = await repository.insertUser(input.email, passwordHash);
  } catch (error) {
    if (repository.isEmailConflict(error)) {
      throw new AppError('EMAIL_TAKEN', 'That email address is already registered.', 409);
    }
    throw error;
  }

  return { user, session: await createSession(user.id) };
}

/**
 * Signs in.
 *
 * An unknown address and a wrong password produce the same error, the same
 * message, and the same amount of work. When no user is found the password is
 * still verified, against a dummy hash: skipping that work makes the response
 * measurably faster for unregistered addresses, which turns this endpoint into
 * an account enumeration oracle that answers by timing alone.
 *
 * @param input - Validated credentials.
 * @returns The user and a new session.
 * @throws {AppError} 401 when the credentials do not match.
 */
export async function login(
  input: CredentialsInput,
): Promise<{ readonly user: User; readonly session: Session }> {
  const found = await repository.findUserByEmail(input.email);
  const hash = found?.passwordHash ?? (await getDummyHash());

  const matches = await verifyPassword(input.password, hash);

  if (found === undefined || !matches) {
    throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
  }

  return {
    user: { id: found.id, email: found.email, createdAt: found.createdAt },
    session: await createSession(found.id),
  };
}

/**
 * Creates a session for a user.
 *
 * @param userId - Who the session belongs to.
 * @returns The stored session.
 */
async function createSession(userId: string): Promise<Session> {
  const id = randomBytes(SESSION_ID_BYTES).toString('base64url');
  const session = await repository.insertSession(id, userId, env().sessionTtlSeconds);

  // Opportunistic cleanup, on a path that is already writing. Expired rows are
  // unreachable but not free, and this avoids adding a scheduler for one
  // statement. Failure here must not fail the sign-in, so it is not awaited.
  void repository.deleteExpiredSessions().catch(() => {
    // Deliberately ignored. A failed cleanup leaves dead rows, which is
    // harmless; failing the sign-in over it would not be.
  });

  return session;
}

/**
 * Resolves a session id to the user it belongs to.
 *
 * @param sessionId - The value from the cookie, or `undefined` when absent.
 * @returns The user, or `undefined` when the session is missing, unknown, or
 *   expired. All three mean the same thing to a caller: unauthenticated.
 */
export async function resolveSession(
  sessionId: string | undefined,
): Promise<User | undefined> {
  if (sessionId === undefined || sessionId === '') return undefined;
  return repository.findUserBySession(sessionId);
}

/**
 * Ends a session.
 *
 * Deleting a row is what makes sign-out real. A signed token would stay valid
 * until it expired, no matter what the server wanted.
 *
 * @param sessionId - The session to end, if there is one.
 */
export async function logout(sessionId: string | undefined): Promise<void> {
  if (sessionId === undefined || sessionId === '') return;
  await repository.deleteSession(sessionId);
}

/**
 * Resolves the caller's session, requiring one.
 *
 * Lives here rather than in each module's routes file, because it is the check
 * that decides whether a request is authenticated at all and two copies of it
 * are two things that can drift apart. It takes only what it needs from a
 * request, so the identity module keeps no dependency on the HTTP layer.
 *
 * @param sessionId - The value from the session cookie, or `undefined`.
 * @returns The authenticated user's id.
 * @throws {AppError} 401 when the cookie is missing, unknown, or expired. All
 *   three give the same answer, because distinguishing them would confirm which
 *   session ids once existed.
 */
export async function requireUserId(sessionId: string | undefined): Promise<string> {
  const user = await resolveSession(sessionId);
  if (user === undefined) throw unauthenticated();
  return user.id;
}
