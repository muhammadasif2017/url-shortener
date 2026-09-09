import type { ServerResponse } from 'node:http';

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
  const headers: Record<string, string> = { ...result.headers };

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
