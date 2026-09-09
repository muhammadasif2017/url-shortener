import {
  clearSessionCookie,
  readSessionId,
  requireJsonContentType,
  sessionCookie,
  unauthenticated,
} from '../../http/auth.ts';
import type { RouteResponse, RouteTable } from '../../http/context.ts';
import { json, noContent } from '../../http/respond.ts';
import { AppError } from '../../lib/AppError.ts';
import * as identityService from './identity.service.ts';
import { parseCredentials, type User } from './identity.schema.ts';

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

      const { user, session } = await identityService.register(parsed.value);

      return json(201, toUserResponse(user), {
        'Set-Cookie': sessionCookie(session.id),
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

      const { user, session } = await identityService.login(parsed.value);

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
      await identityService.logout(readSessionId(context));

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
