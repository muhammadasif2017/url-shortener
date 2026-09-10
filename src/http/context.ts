/**
 * The types that flow between the router and a route handler.
 *
 * A handler receives a {@link RequestContext} and returns a
 * {@link RouteResponse}. It never touches Node's `IncomingMessage` or
 * `ServerResponse`. That keeps handlers testable as plain functions and keeps
 * the one place that writes to a socket small enough to reason about.
 */

/** A route handler's answer, before anything is written to the socket. */
export type RouteResponse = {
  readonly status: number;
  /**
   * Response headers. `Content-Type` is added by the response helpers, so a
   * handler sets only headers specific to its own answer, such as `Location`.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Value to serialise as JSON. Absent means an empty body, which is what a
   * 204 and a 302 both need.
   */
  readonly body?: unknown;
};

/**
 * Everything a handler is allowed to see about a request.
 *
 * Deliberately narrow. A handler that needs the socket, the raw stream, or the
 * client address is reaching past its layer, and the fix is to pass what it
 * needs through this type rather than to widen its access.
 */
export type RequestContext = {
  /** Uppercase HTTP method, such as `GET`. */
  readonly method: string;
  /** Path only, with no query string and no trailing slash. */
  readonly path: string;
  /** Values captured from `:name` segments in the matched route's path. */
  readonly params: Readonly<Record<string, string>>;
  /** Parsed query string. Empty when the request had none. */
  readonly query: URLSearchParams;
  /** Lowercased request headers, as Node supplies them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /**
   * Address to attribute this request to, from the shared resolver.
   *
   * Resolved once per request and passed down, so a handler never reaches for
   * the socket or reads `X-Forwarded-For` itself. Rate limiting and
   * unique-visitor counting therefore cannot drift apart, which is the failure
   * the single-resolver rule in `SPEC.md` exists to prevent. May be the literal
   * `unknown` when no address could be determined.
   */
  readonly clientIp: string;
  /**
   * Prefix for any shared rate-limit bucket a handler writes.
   *
   * Shared counters live in a table, so two servers using one key count each
   * other's requests. Empty in production, where that is exactly the point, and
   * unique per server in tests, where it is not: without it every test server
   * would share one counter and later tests would start pre-limited.
   */
  readonly rateLimitNamespace: string;
  /**
   * Correlation id for this request, resolved once at the top of the pipeline.
   *
   * Present on every request, echoed to the caller, and carried on the log and
   * audit lines a handler writes. See `lib/requestId.ts` for why it is passed
   * rather than held in ambient context.
   */
  readonly requestId: string;
  /**
   * Parsed JSON request body, or `undefined` for a request that carries none.
   * Untrusted and of unknown shape: every handler validates before use.
   */
  readonly body?: unknown;
};

/**
 * A route handler.
 *
 * May be synchronous or asynchronous. Throwing is the normal way to signal a
 * failure; the error handler converts it into a response.
 */
export type RouteHandler = (context: RequestContext) => RouteResponse | Promise<RouteResponse>;

/** One route: a method, a path pattern, and the handler that serves it. */
export type Route = {
  /** Uppercase HTTP method. `GET` also serves `HEAD`. */
  readonly method: string;
  /** Path pattern, such as `/api/links/:slug`. Always starts with `/`. */
  readonly path: string;
  readonly handle: RouteHandler;
};

/** A module's routes, exported for the server to assemble. */
export type RouteTable = readonly Route[];
