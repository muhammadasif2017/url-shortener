import type { ServerResponse } from 'node:http';

import { env } from '../config/env.ts';

import type { RouteResponse } from './context.ts';

/**
 * Response construction and writing.
 *
 * Handlers build a {@link RouteResponse} and return it. This module is the only
 * place that touches a `ServerResponse`, which keeps every rule about headers,
 * content types, and empty bodies in one file instead of spread across routes.
 */

/**
 * Builds a JSON response.
 *
 * @param status - HTTP status.
 * @param body - Value to serialise.
 * @param headers - Extra headers beyond `Content-Type`.
 * @returns The response.
 */
export function json(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): RouteResponse {
  return { status, body, headers };
}

/**
 * Builds a redirect.
 *
 * `Cache-Control: no-store` is set here rather than left to callers. A cached
 * redirect keeps working after the link is deleted, and hides every subsequent
 * visit from the server, which would make click counting wrong.
 *
 * @param status - Redirect status. 302 for this service, never 301, because a
 *   permanently cached mistake cannot be corrected.
 * @param location - Destination URL.
 * @returns The response, with no body.
 */
export function redirect(status: number, location: string): RouteResponse {
  return {
    status,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  };
}

/**
 * Builds an empty success response.
 *
 * @param headers - Extra headers.
 * @returns A 204 with no body.
 */
export function noContent(headers: Readonly<Record<string, string>> = {}): RouteResponse {
  return { status: 204, headers };
}

/** Statuses that must never carry a body, per RFC 9110. */
const BODYLESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/** A year in seconds, the usual HSTS lifetime. */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * The HSTS header, in production only.
 *
 * The header is a promise that this host is reachable over TLS and should never
 * be tried over plaintext again. That promise is false in development, where the
 * service runs on plain HTTP, and a browser that has cached it for localhost
 * will refuse plain HTTP for every other project on that host until the entry is
 * cleared by hand. Production is also the only environment where a redirect
 * whose first request went over plaintext is a real exposure.
 *
 * @returns The header, or `undefined` outside production.
 */
function strictTransportSecurity(): Record<string, string> | undefined {
  if (!env().isProduction) return undefined;
  return {
    'Strict-Transport-Security': `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
  };
}

/**
 * Writes a route's response to the socket.
 *
 * Handles three cases where sending a body would be wrong: a `HEAD` request, a
 * status defined as bodyless, and a handler that returned no body at all. Node
 * suppresses a `HEAD` body on its own, but `Content-Length` is still set from
 * the body that would have been sent, which is what a `HEAD` caller is asking
 * for.
 *
 * @param response - Node's response object.
 * @param result - What the handler returned.
 * @param method - The request's method, needed to detect `HEAD`.
 */
export function send(
  response: ServerResponse,
  result: RouteResponse,
  method: string,
): void {
  // Set on every response, including redirects and errors. This service only
  // ever answers with JSON or an empty body, so there is nothing for a browser
  // to be right about when it guesses a type, and a wrong guess is how a
  // response body becomes executable. It costs one header and closes the
  // question.
  //
  // No CSP: it guards markup this API never returns.
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',

    // What the destination of a redirect learns about where the visitor came
    // from. Under this value it sees the origin and not the path, so the short
    // link's slug stays private while ordinary attribution still works. The
    // header is set on every response because the redirect is the one that
    // matters, and it is the response a route hands back like any other.
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    // Nothing here is meant to be framed, and the API returns no markup that
    // would make framing useful. Denying it is free.
    'X-Frame-Options': 'DENY',

    // No caching by default. Most responses here are either specific to one
    // session, such as the current user and their links, or a redirect whose
    // destination may be revoked. A shared cache holding either is a
    // cross-visitor leak in the first case and an unrevokable link in the
    // second. A route that wants caching says so in its own headers, which
    // override this.
    'Cache-Control': 'no-store',

    ...(strictTransportSecurity() ?? {}),
    ...result.headers,
  };

  const isHead = method.toUpperCase() === 'HEAD';
  const bodyless = BODYLESS_STATUSES.has(result.status) || result.body === undefined;

  let payload = '';
  if (!bodyless) {
    payload = JSON.stringify(result.body);
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = String(Buffer.byteLength(payload, 'utf8'));
  }

  response.writeHead(result.status, headers);

  // A HEAD response carries the headers a GET would, and no body.
  response.end(isHead || bodyless ? undefined : payload);
}
