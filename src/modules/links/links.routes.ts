import { env } from '../../config/env.ts';
import { readSessionId, requireJsonContentType } from '../../http/auth.ts';
import type { RequestContext, RouteResponse, RouteTable } from '../../http/context.ts';
import { json, noContent, redirect } from '../../http/respond.ts';
import { AppError } from '../../lib/AppError.ts';
import { parseBoundedInteger } from '../../lib/validate.ts';
import * as analyticsService from '../analytics/analytics.service.ts';
import * as identityService from '../identity/identity.service.ts';
import { parseCreateLinkInput, type Link } from './links.schema.ts';
import * as linkService from './links.service.ts';

/**
 * HTTP surface for the links module.
 *
 * Handlers parse input, call a service, and shape the answer. They hold no
 * business rules and write no SQL. A handler that grows a decision belongs in
 * the service instead.
 */

/** Redirect status. 302, never 301: see {@link linkRoutes}. */
const REDIRECT_STATUS = 302;

/** Default page size for listing. */
const DEFAULT_LIMIT = 20;
/** Largest page a caller may request. */
const MAX_LIMIT = 100;

/**
 * Shapes a link for a response.
 *
 * `id` is deliberately not exposed. It is an internal surrogate key, and
 * publishing a sequential identifier tells every caller how many links exist
 * and lets them walk the whole table.
 *
 * @param link - The stored link.
 * @returns The public representation.
 */
function toLinkResponse(link: Link): Record<string, unknown> {
  return {
    slug: link.slug,
    shortUrl: `${env().baseUrl}/${link.slug}`,
    url: link.url,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
  };
}

/**
 * Encodes a pagination cursor.
 *
 * Base64url rather than the raw id, so the value reads as opaque and callers do
 * not build logic on its contents.
 *
 * @param id - The last id on the page.
 * @returns The cursor.
 */
function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

/**
 * Decodes a pagination cursor.
 *
 * @param cursor - The caller-supplied cursor.
 * @returns The id it encodes.
 * @throws {AppError} 400 when the cursor is not one this service issued.
 */
function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');

  // Ids are digits. Anything else was corrupted, invented, or copied from
  // somewhere else, and passing it to the query would be a type error at best.
  if (!/^\d+$/.test(decoded)) {
    throw new AppError('INVALID_CURSOR', 'That cursor is not valid.', 400);
  }

  return decoded;
}

/**
 * Resolves the caller's session, allowing none.
 *
 * Used by link creation, which stays open to anonymous callers. A bad or
 * expired cookie is treated as absence rather than as a failure: the request is
 * valid either way, and the only consequence is that the link has no owner.
 *
 * @param context - The request.
 * @returns The user's id, or `undefined`.
 */
async function optionalUserId(context: RequestContext): Promise<string | undefined> {
  const user = await identityService.resolveSession(readSessionId(context));
  return user?.id;
}

/**
 * Every route this module serves.
 *
 * The redirect route is registered first on purpose, to demonstrate that the
 * router's precedence rules hold regardless of order. `/health` and
 * `/api/links` still win, because a literal segment beats a parameter.
 */
export const linkRoutes: RouteTable = [
  {
    method: 'GET',
    path: '/:slug',
    async handle(context): Promise<RouteResponse> {
      const slug = context.params['slug'] ?? '';
      const link = await linkService.resolveSlug(slug);

      // Started here, deliberately not awaited, and registered synchronously
      // before this handler returns and the response is written. A visitor
      // never pays for the analytics write, and a database that is slow or
      // unreachable cannot turn a working redirect into a failure.
      //
      // `recordClick` returns void and cannot throw, so there is no promise for
      // this call site to mishandle. See `analytics.service.ts`.
      analyticsService.recordClick({
        linkId: link.id,
        clientIp: context.clientIp,
        referrer: context.headers['referer'],
        userAgent: context.headers['user-agent'],
      });

      // 302, not 301. A permanent redirect is cached by browsers forever, which
      // makes a mistyped destination unfixable and hides every later visit from
      // the server, breaking click counting before it is built.
      return redirect(REDIRECT_STATUS, link.url);
    },
  },
  {
    method: 'POST',
    path: '/api/links',
    async handle(context): Promise<RouteResponse> {
      requireJsonContentType(context);

      const parsed = parseCreateLinkInput(context.body, {
        baseUrl: env().baseUrl,
        now: new Date(),
      });

      if (!parsed.ok) throw AppError.validation(parsed.issues);

      const link = await linkService.createLink(parsed.value, await optionalUserId(context));
      return json(201, toLinkResponse(link));
    },
  },
  {
    method: 'GET',
    path: '/api/links',
    async handle(context): Promise<RouteResponse> {
      const ownerId = await identityService.requireUserId(readSessionId(context));

      const limit = parseBoundedInteger(
        context.query.get('limit') ?? undefined,
        'limit',
        { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT },
      );
      if (!limit.ok) throw AppError.validation(limit.issues);

      const rawCursor = context.query.get('cursor');
      const cursorId = rawCursor === null ? undefined : decodeCursor(rawCursor);

      const page = await linkService.listLinks({ ownerId, limit: limit.value, cursorId });

      return json(200, {
        data: page.links.map(toLinkResponse),
        nextCursor: page.nextCursorId === null ? null : encodeCursor(page.nextCursorId),
      });
    },
  },
  {
    method: 'GET',
    path: '/api/links/:slug',
    async handle(context): Promise<RouteResponse> {
      const link = await linkService.getLink(context.params['slug'] ?? '');
      return json(200, toLinkResponse(link));
    },
  },
  {
    method: 'DELETE',
    path: '/api/links/:slug',
    async handle(context): Promise<RouteResponse> {
      const userId = await identityService.requireUserId(readSessionId(context));
      await linkService.deleteLink(context.params['slug'] ?? '', userId);
      return noContent();
    },
  },
];
