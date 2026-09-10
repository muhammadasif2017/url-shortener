import {
  clearSessionCookie,
  readSessionId,
  requireJsonContentType,
  sessionCookie,
  unauthenticated,
} from '../../http/auth.ts';
import type { RequestContext, RouteResponse, RouteTable } from '../../http/context.ts';
import { json, noContent } from '../../http/respond.ts';
import type { RateLimitDecision } from '../../http/rateLimit.ts';
import { checkSharedLimit } from '../../http/sharedRateLimit.ts';
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
 * Counts one failed sign-in and reports whether the account has any budget left.
 *
 * Counting happens here and nowhere else, and it happens only after
 * verification has actually failed. Both halves matter. Counting every attempt
 * would let noise fill the budget; consulting the budget before verification
 * would refuse the correct password once it was gone, and since the attacker
 * supplies the failures, that is a lockout anyone who knows an address could
 * trigger with twenty requests and hold indefinitely. Refusing only attempts
 * that already failed keeps the throttle and leaves the owner a way in.
 *
 * The returned decision is the one that counted this failure, not a second read
 * of the bucket. Spending the last of the budget is still allowed, so the
 * attempt that exhausts it is answered 401 like the ones before it and the next
 * one is answered 429. Re-reading the bucket instead would move that boundary by
 * one, which is a visible change in when an account starts being throttled.
 *
 * What this does not do is bound the hashing cost of guessing at one account
 * from many addresses. The per-address credential limit in `server.ts` bounds
 * that, which is where a limit on request volume belongs.
 *
 * @param email - The normalised address from the request.
 * @param context - The request, which carries the counter namespace.
 * @returns The decision covering this failure.
 */
async function countAccountFailure(
  email: string,
  context: RequestContext,
): Promise<RateLimitDecision> {
  return checkSharedLimit(accountFailureBucket(email, context), ACCOUNT_FAILURE_LIMIT);
}

/**
 * Turns a spent failure budget into a 429.
 *
 * @param decision - The decision from {@link countAccountFailure}.
 * @param context - The request, for the audit line.
 * @throws {AppError} 429 when the account's failure budget is spent.
 */
function refuseWhenFailureBudgetSpent(decision: RateLimitDecision, context: RequestContext): void {
  if (decision.allowed) return;

  audit('auth.login.throttled', { clientIp: context.clientIp, requestId: context.requestId });
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
        audit('auth.register.duplicate', {
          clientIp: context.clientIp,
          requestId: context.requestId,
        });
      } else {
        audit('auth.register', {
          userId: user.id,
          clientIp: context.clientIp,
          requestId: context.requestId,
        });
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

      // Verification runs before the failure budget is consulted, and the order
      // is the security property. Gating verification on the budget meant a
      // spent budget refused the correct password too, and the failures that
      // spend it are supplied by whoever is guessing: twenty wrong passwords
      // locked a known address out for the hour, renewable indefinitely. The
      // budget still decides what a *failed* attempt is answered with, so
      // guessing gains nothing from the change, and the account's owner can
      // always sign in.
      let user;
      let session;
      try {
        ({ user, session } = await identityService.login(parsed.value));
      } catch (error) {
        // Only a rejected credential counts. A malformed request or a database
        // failure is not evidence of guessing, and counting either would let
        // noise fill the budget up.
        if (error instanceof AppError && error.code === 'INVALID_CREDENTIALS') {
          const decision = await countAccountFailure(parsed.value.email, context);
          audit('auth.login.failed', { clientIp: context.clientIp, requestId: context.requestId });

          // Once the budget is gone, further guesses are throttled rather than
          // merely rejected. Missing accounts have a bucket too, so which of the
          // two answers comes back still discloses nothing about the address.
          refuseWhenFailureBudgetSpent(decision, context);
        }
        throw error;
      }

      audit('auth.login.succeeded', {
        userId: user.id,
        clientIp: context.clientIp,
        requestId: context.requestId,
      });

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
        audit('auth.logout', {
          userId: user.id,
          clientIp: context.clientIp,
          requestId: context.requestId,
        });
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
