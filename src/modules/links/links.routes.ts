import { env } from '../../config/env.ts';
import type { RouteResponse, RouteTable } from '../../http/context.ts';
import { json, noContent, redirect } from '../../http/respond.ts';
import { AppError } from '../../lib/AppError.ts';
import { parseBoundedInteger } from '../../lib/validate.ts';
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
 * Rejects a request when the unauthenticated administration routes are off.
 *
 * These routes have no ownership check until the identity module exists, so
 * while they are enabled anyone can list every link and delete any of them.
 * They answer 404 rather than 403 when disabled, because a 403 would confirm
 * the route exists.
 *
 * @throws {AppError} 404 when the flag is not set.
 */
function requireAdminRoutes(): void {
  if (!env().enableUnauthenticatedLinkAdmin) {
    throw AppError.notFound('NOT_FOUND', 'No such endpoint.');
  }
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
      const parsed = parseCreateLinkInput(context.body, {
        baseUrl: env().baseUrl,
        now: new Date(),
      });

      if (!parsed.ok) throw AppError.validation(parsed.issues);

      const link = await linkService.createLink(parsed.value);
      return json(201, toLinkResponse(link));
    },
  },
  {
    method: 'GET',
    path: '/api/links',
    async handle(context): Promise<RouteResponse> {
      requireAdminRoutes();

      const limit = parseBoundedInteger(
        context.query.get('limit') ?? undefined,
        'limit',
        { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT },
      );
      if (!limit.ok) throw AppError.validation(limit.issues);

      const rawCursor = context.query.get('cursor');
      const cursorId = rawCursor === null ? undefined : decodeCursor(rawCursor);

      const page = await linkService.listLinks({ limit: limit.value, cursorId });

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
      requireAdminRoutes();
      await linkService.deleteLink(context.params['slug'] ?? '');
      return noContent();
    },
  },
];
