import { env } from '../config/env.ts';
import { AppError } from '../lib/AppError.ts';
import type { RequestContext } from './context.ts';
import { clearCookie, parseCookies, serialiseCookie, type CookieOptions } from './cookies.ts';

/**
 * Session cookie handling and the authorisation guard.
 *
 * Everything about how a session travels lives here, so the rules cannot drift
 * between the route that sets the cookie and the route that clears it. A
 * clearing cookie whose attributes do not match the original silently fails to
 * delete anything, and the endpoint still reports success.
 */

/**
 * Cookie name, which depends on the environment.
 *
 * The `__Host-` prefix makes the browser enforce `Secure`, `Path=/`, and the
 * absence of `Domain`, which stops any sibling subdomain from overwriting the
 * session. It requires `Secure`, and `Secure` cookies are not stored over plain
 * HTTP, so the prefix cannot be used locally.
 *
 * @returns The cookie name for this environment.
 */
export function sessionCookieName(): string {
  return env().isProduction ? '__Host-session' : 'session';
}

/**
 * Attributes the session cookie is scoped with.
 *
 * Used for both setting and clearing. A deletion cookie only matches when its
 * scope matches exactly, so sharing one definition is what keeps sign-out
 * working.
 *
 * @returns The cookie options.
 */
function sessionCookieOptions(): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    secure: env().isProduction,
    sameSite: 'Lax',
  };
}

/**
 * Builds the `Set-Cookie` header that establishes a session.
 *
 * @param sessionId - The opaque session id.
 * @returns The header value.
 */
export function sessionCookie(sessionId: string): string {
  return serialiseCookie(sessionCookieName(), sessionId, {
    ...sessionCookieOptions(),
    maxAge: env().sessionTtlSeconds,
  });
}

/**
 * Builds the `Set-Cookie` header that ends a session.
 *
 * @returns The header value.
 */
export function clearSessionCookie(): string {
  return clearCookie(sessionCookieName(), sessionCookieOptions());
}

/**
 * Reads the session id from a request.
 *
 * @param context - The request.
 * @returns The session id, or `undefined` when no cookie was sent.
 */
export function readSessionId(context: RequestContext): string | undefined {
  const cookies = parseCookies(context.headers['cookie']);
  return cookies[sessionCookieName()];
}

/** Media type required on state-changing requests. */
const REQUIRED_MEDIA_TYPE = 'application/json';

/**
 * Rejects a state-changing request that does not declare JSON.
 *
 * This is the second layer of cross-site request forgery defence, behind
 * `SameSite=Lax`. An HTML form cannot express `application/json` as an
 * `enctype` at all, so a form cannot mount the attack. A `fetch` can set the
 * header, but doing so makes the request non-simple and triggers a preflight
 * that this service, having no CORS configuration, never answers.
 *
 * That second half is a property of the CORS configuration, not of this check.
 * The day an allowed origin is added with credentials, preflight starts
 * succeeding and this check stops blocking anything on its own. A real CSRF
 * token becomes mandatory at that point.
 *
 * @param context - The request.
 * @throws {AppError} 415 when the media type is missing or not JSON.
 */
export function requireJsonContentType(context: RequestContext): void {
  const raw = context.headers['content-type'];
  const header = Array.isArray(raw) ? raw[0] : raw;

  // The parameters are stripped before comparing, because
  // `application/json; charset=utf-8` is legitimate and would fail a naive
  // equality test. A missing header is rejected rather than treated as absent
  // and therefore acceptable.
  const mediaType = header?.split(';')[0]?.trim().toLowerCase();

  if (mediaType !== REQUIRED_MEDIA_TYPE) {
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      `Content-Type must be ${REQUIRED_MEDIA_TYPE}.`,
      415,
    );
  }
}

/**
 * Builds the error for an unauthenticated request.
 *
 * A missing cookie, an unknown session, and an expired session all produce the
 * same answer. Distinguishing them would tell a caller which session ids once
 * existed.
 *
 * @returns A 401 error.
 */
export function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', 'Sign in to continue.', 401);
}
