import {
  clearSessionCookie,
  readSessionId,
  requireJsonContentType,
  sessionCookie,
  unauthenticated,
} from '../../http/auth.ts';
import type { RequestContext, RouteResponse, RouteTable } from '../../http/context.ts';
import { json, noContent } from '../../http/respond.ts';
import { checkSharedLimit, peekSharedLimit } from '../../http/sharedRateLimit.ts';
import { env } from '../../config/env.ts';
import { AppError } from '../../lib/AppError.ts';
import { audit } from '../../lib/audit.ts';
import { hashIdentifier } from '../../lib/ipHash.ts';
import * as identityService from './identity.service.ts';
import { parseCredentials, type User } from './identity.schema.ts';

/**
 * Failed sign-ins permitted per account, per window.
 *
 * Separate from the per-address limit, which counts requests from one client.
 * That limit does nothing about the attack it looks like it covers: ten attempts
 * per address from a thousand addresses is ten thousand attempts at one account,
 * and credential stuffing is run exactly that way.
 */
export const ACCOUNT_FAILURE_MAX = 20;

/** Window for the per-account limit: one hour. */
const ACCOUNT_FAILURE_WINDOW_MS = 60 * 60 * 1000;

/** Limit and window for the per-account bucket. */
const ACCOUNT_FAILURE_LIMIT = {
  max: ACCOUNT_FAILURE_MAX,
  windowMs: ACCOUNT_FAILURE_WINDOW_MS,
};

/**
 * The bucket counting failed sign-ins for one account.
 *
 * The address is hashed, so the counter table holds no email addresses. Missing
 * accounts get a bucket too, since skipping it would make the limiter's own
 * behaviour disclose which addresses are registered.
 *
 * @param email - The normalised address from the request.
 * @param context - The request, which carries the namespace these counters live
 *   under. Empty in production; per-server in tests.
 * @returns The bucket key.
 */
function accountFailureBucket(email: string, context: RequestContext): string {
  return `${context.rateLimitNamespace}login-failure:${hashIdentifier(email, env().ipHashSalt)}`;
}

/**
 * Refuses a sign-in when the account has already failed too many times.
 *
 * This reads the bucket rather than counting against it, and the difference is
 * the whole design. A bucket that counts every attempt is a lockout weapon:
 * anyone who knows an address could spend the account's allowance and keep its
 * owner out. Only failures are counted, and only once verification has actually
 * failed, so a legitimate sign-in never consumes anything.
 *
 * @param email - The normalised address from the request.
 * @param context - The request, for the audit line.
 * @throws {AppError} 429 when the account's failure budget is spent.
 */
async function requireAccountAttemptsRemaining(
  email: string,
  context: RequestContext,
): Promise<void> {
  const decision = await peekSharedLimit(
    accountFailureBucket(email, context),
    ACCOUNT_FAILURE_LIMIT,
  );
  if (decision.allowed) return;

  audit('auth.login.throttled', { clientIp: context.clientIp });
  throw new AppError('RATE_LIMITED', 'Too many failed sign-in attempts.', 429, {
    headers: { 'Retry-After': String(decision.retryAfterSeconds) },
  });
}

/** HTTP surface for accounts and sessions. */

/**
 * Shapes a user for a response.
 *
 * The password hash is never in the {@link User} type at all, so it cannot be
 * leaked here by forgetting to remove it. That is the point of separating
 * `User` from `UserWithHash` in the repository.
 *
 * @param user - The user.
 * @returns The public representation.
 */
function toUserResponse(user: User): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}

export const identityRoutes: RouteTable = [
  {
    method: 'POST',
    path: '/api/auth/register',
    async handle(context): Promise<RouteResponse> {
      requireJsonContentType(context);

      const parsed = parseCredentials(context.body);
      if (!parsed.ok) throw AppError.validation(parsed.issues);

      const user = await identityService.register(parsed.value);

      // The audit log records which of the two happened. It is written for an
      // operator reconstructing an incident, not returned to the caller, so the
      // asymmetry here costs nothing that the response is protecting.
      if (user === undefined) {
        audit('auth.register.duplicate', { clientIp: context.clientIp });
      } else {
        audit('auth.register', { userId: user.id, clientIp: context.clientIp });
      }

      // One answer for both cases, carrying no account details and no session.
      // A 201 with a body would say the address was free; a 409 would say it was
      // taken. Even a cookie on one path and not the other would say it, which
      // is why registration no longer issues one at all.
      return json(202, {
        status: 'accepted',
        message:
          'If that address was not already registered, an account now exists for it. Sign in to continue.',
      });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/login',
    async handle(context): Promise<RouteResponse> {
      requireJsonContentType(context);

      const parsed = parseCredentials(context.body);

      // A malformed body gets the same 401 as wrong credentials, not a 400
      // listing which field was wrong. A validation error here would confirm
      // that the address exists, or reveal the password policy to someone
      // guessing.
      if (!parsed.ok) {
        throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
      }

      await requireAccountAttemptsRemaining(parsed.value.email, context);

      let user;
      let session;
      try {
        ({ user, session } = await identityService.login(parsed.value));
      } catch (error) {
        // Only a rejected credential counts. A malformed request or a database
        // failure is not evidence of guessing, and counting either would let
        // noise lock an account out.
        if (error instanceof AppError && error.code === 'INVALID_CREDENTIALS') {
          await checkSharedLimit(
            accountFailureBucket(parsed.value.email, context),
            ACCOUNT_FAILURE_LIMIT,
          );
          audit('auth.login.failed', { clientIp: context.clientIp });
        }
        throw error;
      }

      audit('auth.login.succeeded', { userId: user.id, clientIp: context.clientIp });

      return json(200, toUserResponse(user), {
        'Set-Cookie': sessionCookie(session.id),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    async handle(context): Promise<RouteResponse> {
      // No content-type requirement and no session requirement. Logging out is
      // not a state change an attacker benefits from forcing, and answering 401
      // to someone whose session already expired would be unhelpful.
      const sessionId = readSessionId(context);

      // Read the account before the row is deleted, so the audit line can say
      // whose session ended. Afterwards there is nothing left to ask.
      const user = await identityService.resolveSession(sessionId);
      await identityService.logout(sessionId);

      if (user !== undefined) {
        audit('auth.logout', { userId: user.id, clientIp: context.clientIp });
      }

      return noContent({ 'Set-Cookie': clearSessionCookie() });
    },
  },
  {
    method: 'GET',
    path: '/api/auth/me',
    async handle(context): Promise<RouteResponse> {
      const user = await identityService.resolveSession(readSessionId(context));
      if (user === undefined) throw unauthenticated();

      return json(200, toUserResponse(user));
    },
  },
];
