/**
 * The one error type services throw.
 *
 * Every failure a caller is meant to see carries three things: a machine-
 * readable code the caller can branch on, a human-readable message, and the
 * HTTP status that expresses it. Bundling them here means the error handler
 * needs no table mapping exceptions to statuses, and no service needs to know
 * how a response is written.
 *
 * Anything else that reaches the error handler is a bug, and is reported as a
 * 500 with its details logged rather than returned.
 */

/** A field-level problem, attached to validation failures only. */
export type ErrorDetail = {
  readonly field: string;
  readonly message: string;
};

export class AppError extends Error {
  /** Stable, machine-readable code, such as `SLUG_TAKEN`. */
  readonly code: string;
  /** HTTP status to respond with. */
  readonly status: number;
  /** Field-level problems, present on validation failures. */
  readonly details: readonly ErrorDetail[] | undefined;
  /** Extra response headers this failure requires, such as `Retry-After`. */
  readonly headers: Readonly<Record<string, string>> | undefined;

  /**
   * @param code - Stable machine-readable code.
   * @param message - Explanation safe to return to the caller. Never include
   *   the caller's own input, a secret, or anything about internal state.
   * @param status - HTTP status.
   * @param options.details - Field-level problems, for a validation failure.
   * @param options.headers - Headers the response must carry. A 429 and a 503
   *   both need `Retry-After`, and a 405 needs `Allow`.
   */
  constructor(
    code: string,
    message: string,
    status: number,
    options: {
      readonly details?: readonly ErrorDetail[];
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.headers = options.headers;
  }

  /**
   * Builds a validation failure.
   *
   * @param details - Every field-level problem found, not just the first.
   * @returns A 400 error carrying those details.
   */
  static validation(details: readonly ErrorDetail[]): AppError {
    return new AppError('VALIDATION_FAILED', 'Request body is invalid.', 400, {
      details,
    });
  }

  /**
   * Builds a not-found failure.
   *
   * @param code - Which thing was not found, such as `LINK_NOT_FOUND`.
   * @param message - Explanation for the caller.
   * @returns A 404 error.
   */
  static notFound(code: string, message: string): AppError {
    return new AppError(code, message, 404);
  }
}
