import { AppError } from '../lib/AppError.ts';
import { describeError, log } from '../lib/logger.ts';
import type { RouteResponse } from './context.ts';

/**
 * Conversion of a thrown value into an HTTP response.
 *
 * This is the only place that decides what a caller sees when something fails.
 * Keeping it in one function is what makes the error shape consistent, and what
 * makes the rule below enforceable in a single place.
 *
 * The rule: an {@link AppError} was thrown deliberately and its message is
 * meant for the caller. Anything else is a bug, and its message may name an
 * internal path, a query, or a value the caller must not see. Those are logged
 * in full and answered with a generic 500.
 */

/** The single error response shape this service returns. */
export type ErrorBody = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly { readonly field: string; readonly message: string }[];
  };
};

/**
 * Converts any thrown value into a response.
 *
 * @param error - Whatever was thrown.
 * @param context.method - Request method, for the log line.
 * @param context.path - Request path, for the log line.
 * @returns The response to send.
 */
export function toErrorResponse(
  error: unknown,
  context: { readonly method: string; readonly path: string },
): RouteResponse {
  if (error instanceof AppError) {
    // Client errors are ordinary traffic and would drown the log. Server errors
    // are not, and are recorded even when deliberate.
    if (error.status >= 500) {
      log('error', 'request failed', {
        ...context,
        code: error.code,
        status: error.status,
        ...describeError(error),
      });
    }

    const body: ErrorBody = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };

    return { status: error.status, body, headers: error.headers ?? {} };
  }

  log('error', 'unhandled error', { ...context, ...describeError(error) });

  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong.',
      },
    } satisfies ErrorBody,
  };
}

/**
 * Builds the response for a path that matched no route.
 *
 * @returns A 404 in the standard error shape.
 */
export function notFoundResponse(): RouteResponse {
  return toErrorResponse(
    AppError.notFound('NOT_FOUND', 'No such endpoint.'),
    { method: '', path: '' },
  );
}

/**
 * Builds the response for a path that exists under other methods.
 *
 * @param allow - Methods the path accepts.
 * @returns A 405 carrying the `Allow` header the status requires.
 */
export function methodNotAllowedResponse(allow: readonly string[]): RouteResponse {
  return toErrorResponse(
    new AppError('METHOD_NOT_ALLOWED', 'That method is not supported here.', 405, {
      headers: { Allow: allow.join(', ') },
    }),
    { method: '', path: '' },
  );
}
