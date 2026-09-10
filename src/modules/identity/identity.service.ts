import { unauthenticated } from '../../http/auth.ts';

import { env } from '../../config/env.ts';
import { AppError } from '../../lib/AppError.ts';
import { getDummyHash, hashPassword, verifyPassword } from '../../lib/password.ts';
import { createSessionId } from '../../lib/sessionId.ts';
import * as repository from './identity.repository.ts';
import type { CredentialsInput, Session, User } from './identity.schema.ts';

/** Business rules for accounts and sessions. */

/**
 * Registers an account, if the address is free.
 *
 * No session is issued. Registration used to sign the caller straight in, which
 * was pleasant and which is what makes enumeration unavoidable: a response that
 * carries a session says the address was free, and one that does not says it was
 * taken, whatever the status code claims. Signing in is now a second call, and
 * it is the only call that produces a session.
 *
 * The cost is real and is a product decision, not a side effect: a new account
 * takes two requests instead of one. What it buys is that registration stops
 * being an oracle for which addresses hold accounts.
 *
 * @param input - Validated credentials.
 * @returns The new user, or `undefined` when the address was already taken. The
 *   caller must answer identically either way; the distinction exists so the
 *   audit log can record what actually happened.
 */
export async function register(input: CredentialsInput): Promise<User | undefined> {
  // Hashed before the insert is attempted, and on every path. An address that is
  // already taken must cost the same scrypt run as one that is free, or the
  // response time answers the question the response body refuses to.
  const passwordHash = await hashPassword(input.password);

  try {
    return await repository.insertUser(input.email, passwordHash);
  } catch (error) {
    if (repository.isEmailConflict(error)) {
      // Swallowed on purpose. The caller cannot distinguish this from success,
      // which is the entire point: a distinct 409 confirmed which addresses hold
      // accounts to anyone who cared to ask, one request at a time.
      //
      // Nothing is written and nothing is sent to the address, because there is
      // no mail channel here. The owner of an existing account is unaffected:
      // their password is untouched and their sessions are untouched.
      return undefined;
    }
    throw error;
  }
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
  // The identifier is created here and handed straight to the repository, which
  // stores only its hash and hands the identifier back untouched. This function
  // is therefore the only place the raw value exists, and its one destination is
  // the cookie.
  const session = await repository.insertSession(
    createSessionId(),
    userId,
    env().sessionTtlSeconds,
  );

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
