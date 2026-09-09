import { readSessionId } from '../../http/auth.ts';
import type { RequestContext, RouteResponse, RouteTable } from '../../http/context.ts';
import { json } from '../../http/respond.ts';
import { AppError } from '../../lib/AppError.ts';
import { parseBoundedInteger } from '../../lib/validate.ts';
import * as identityService from '../identity/identity.service.ts';
import * as analyticsService from './analytics.service.ts';
import {
  DEFAULT_REFERRER_LIMIT,
  DEFAULT_WINDOW_DAYS,
  MAX_REFERRER_LIMIT,
  MAX_WINDOW_DAYS,
  MIN_REFERRER_LIMIT,
  MIN_WINDOW_DAYS,
} from './analytics.schema.ts';

/**
 * HTTP surface for the analytics module.
 *
 * Both routes are four segments long, and the router matches only on an equal
 * segment count, so neither the one-segment redirect nor the three-segment
 * `/api/links/:slug` can answer them whatever order routes are registered in.
 */

/**
 * Reads the `days` query parameter.
 *
 * @param context - The request.
 * @returns The window length in days.
 * @throws {AppError} 400 `VALIDATION_FAILED` when it is not a whole number in
 *   range, with a field-level detail.
 */
function windowDays(context: RequestContext): number {
  const parsed = parseBoundedInteger(context.query.get('days') ?? undefined, 'days', {
    min: MIN_WINDOW_DAYS,
    max: MAX_WINDOW_DAYS,
    fallback: DEFAULT_WINDOW_DAYS,
  });

  if (!parsed.ok) throw AppError.validation(parsed.issues);
  return parsed.value;
}

/**
 * Reads the `limit` query parameter.
 *
 * @param context - The request.
 * @returns How many referrers to return.
 * @throws {AppError} 400 `VALIDATION_FAILED` when it is not a whole number in
 *   range, with a field-level detail.
 */
function referrerLimit(context: RequestContext): number {
  const parsed = parseBoundedInteger(context.query.get('limit') ?? undefined, 'limit', {
    min: MIN_REFERRER_LIMIT,
    max: MAX_REFERRER_LIMIT,
    fallback: DEFAULT_REFERRER_LIMIT,
  });

  if (!parsed.ok) throw AppError.validation(parsed.issues);
  return parsed.value;
}

/** Every route this module serves. */
export const analyticsRoutes: RouteTable = [
  {
    method: 'GET',
    path: '/api/links/:slug/stats',
    async handle(context): Promise<RouteResponse> {
      const userId = await identityService.requireUserId(readSessionId(context));
      const stats = await analyticsService.readLinkStats(
        context.params['slug'] ?? '',
        userId,
        windowDays(context),
      );

      return json(200, stats);
    },
  },
  {
    method: 'GET',
    path: '/api/links/:slug/referrers',
    async handle(context): Promise<RouteResponse> {
      const userId = await identityService.requireUserId(readSessionId(context));
      const referrers = await analyticsService.readLinkReferrers(
        context.params['slug'] ?? '',
        userId,
        windowDays(context),
        referrerLimit(context),
      );

      return json(200, referrers);
    },
  },
];
