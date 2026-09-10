import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { env } from './config/env.ts';
import { pool } from './db/pool.ts';
import type { RequestContext, RouteResponse, RouteTable } from './http/context.ts';
import {
  methodNotAllowedResponse,
  notFoundResponse,
  toErrorResponse,
} from './http/errorHandler.ts';
import { createRateLimiter } from './http/rateLimit.ts';
import { checkSharedLimit } from './http/sharedRateLimit.ts';
import { readJsonBody } from './http/readBody.ts';
import { json, send } from './http/respond.ts';
import { createRouter } from './http/router.ts';
import { AppError } from './lib/AppError.ts';
import { resolveClientIp } from './lib/clientIp.ts';
import { describeError, log } from './lib/logger.ts';

/**
 * Server assembly.
 *
 * Builds the `node:http` server and wires the request pipeline. It never calls
 * `listen`, so a test can start it on an ephemeral port and the entry point can
 * own the process lifecycle. A module that listens on import cannot be tested.
 */

/** Methods that may carry a request body. */
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/** How long the health check waits for the database before giving up. */
const HEALTH_TIMEOUT_MS = 2_000;

/** Attempts permitted per window on the credential endpoints. */
const AUTH_RATE_LIMIT_MAX = 10;
/** Window for the credential endpoints: fifteen minutes. */
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Paths that hash a password and therefore need the stricter limit.
 *
 * Sign-out and the current-user route are absent: neither hashes anything, and
 * rate limiting sign-out would leave someone unable to end their own session.
 */
const CREDENTIAL_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/login',
  '/api/auth/register',
]);

/**
 * Requests permitted per window on the redirect path, per instance.
 *
 * Generous, because this is not a limit on people following links. It exists
 * because every redirect writes a click row, so an unmetered redirect route lets
 * one host with one valid slug drive unbounded write volume at the database.
 */
const REDIRECT_RATE_LIMIT_MAX = 600;

/** Window for the redirect path: one minute. */
const REDIRECT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * Builds the refusal sent when a limit is reached.
 *
 * @param retryAfterSeconds - Seconds until the window resets.
 * @returns The error to send.
 */
function tooManyRequests(retryAfterSeconds: number): AppError {
  return new AppError('RATE_LIMITED', 'Too many requests.', 429, {
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

/**
 * The health route.
 *
 * It queries the database on every call. A health check that only proves the
 * process is running answers a question nobody is asking: a service whose
 * database is unreachable is not healthy, and reporting otherwise keeps a
 * broken instance in rotation.
 */
const healthRoutes: RouteTable = [
  {
    method: 'GET',
    path: '/health',
    async handle() {
      try {
        await withTimeout(pool().query('select 1'), HEALTH_TIMEOUT_MS);
        return json(200, { status: 'ok', database: 'ok' });
      } catch {
        // Deliberately not a thrown error. A failing health check is an
        // expected state to report, not an exception to log on every poll.
        return json(503, { status: 'degraded', database: 'down' });
      }
    },
  },
];

/**
 * Decides whether a path is subject to rate limiting.
 *
 * The redirect route is exempt, and deliberately so. It is the product, and one
 * shared office behind a single address must not be able to exhaust it for
 * everyone there. The health route is exempt because a platform polls it far
 * more often than any human uses the API, and a rate-limited health check would
 * report the service as unhealthy under its own monitoring.
 *
 * @param pathname - The request path.
 * @returns `true` when the limiter applies.
 */
/**
 * Whether a path is counted against the shared, cross-instance limit.
 *
 * Only the API paths. The redirect path is limited too, but in process memory,
 * and the split is deliberate rather than an unfinished migration.
 *
 * The shared counter costs a database round trip on every request it decides.
 * The API paths are low volume and every one of them already talks to the
 * database, so the round trip is noise there and correctness across instances is
 * worth having: a credential limit that multiplies by instance count is not a
 * credential limit.
 *
 * The redirect path is the opposite case on both counts. It is the hot path, and
 * what its limit protects is the database itself from click-write amplification.
 * A per-instance cap still bounds that at instances times the cap, which is the
 * property that matters, and paying a synchronous round trip to a database in
 * order to protect that database from writes would be self-defeating.
 */
function isSharedRateLimited(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

/**
 * Rejects a promise that takes too long.
 *
 * A query against an unreachable database can hang for as long as the network
 * allows. Without a bound, the health check hangs with it and the platform
 * learns nothing.
 *
 * @param work - The promise to bound.
 * @param milliseconds - How long to wait.
 * @returns The promise's value.
 * @throws {Error} When the deadline passes first.
 */
async function withTimeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out')), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Options for assembling the server. */
export type ServerOptions = {
  /**
   * Rate limit overrides.
   *
   * Present so a test can build a server with a deliberately small limit
   * without lowering it for the whole process. The limiter holds state, and one
   * shared across every test file would make each file's request count depend
   * on which files ran first.
   */
  readonly rateLimit?: { readonly max: number; readonly windowMs: number };
  /** Overrides for the stricter credential-endpoint limit. */
  readonly authRateLimit?: { readonly max: number; readonly windowMs: number };
  /**
   * Prefix applied to every shared rate-limit bucket this server writes.
   *
   * The shared counters live in a table rather than in this process, so two
   * servers using the same key count each other's requests. That is the entire
   * point in production and a problem in tests, where every server binds to
   * loopback and would therefore share one bucket with every other test. A
   * namespace keeps each test's counters to itself; production leaves it unset.
   */
  readonly rateLimitNamespace?: string;
};

/**
 * Builds the HTTP server.
 *
 * @param moduleRoutes - Routes contributed by feature modules. The health route
 *   is always included.
 * @param options - Overrides, used by tests.
 * @returns A server that is not listening yet.
 */
export function createAppServer(
  moduleRoutes: RouteTable = [],
  options: ServerOptions = {},
): Server {
  const router = createRouter([...healthRoutes, ...moduleRoutes]);
  const config = env();

  const namespace = options.rateLimitNamespace ?? '';

  const apiLimit = {
    max: options.rateLimit?.max ?? config.rateLimitMax,
    windowMs: options.rateLimit?.windowMs ?? config.rateLimitWindowMs,
  };

  // Credential endpoints get their own, far stricter limit, and it is not a
  // nicety. Each attempt runs scrypt, which costs about 33 MiB and a tenth of a
  // second of thread-pool work. The general limit of sixty per minute would let
  // one address spend six seconds of hashing per minute, on a service that has
  // a single event loop to serve every redirect. It also slows credential
  // stuffing from thousands of guesses an hour to forty.
  const authLimit = {
    max: options.authRateLimit?.max ?? AUTH_RATE_LIMIT_MAX,
    windowMs: options.authRateLimit?.windowMs ?? AUTH_RATE_LIMIT_WINDOW_MS,
  };

  // The redirect path's limiter, and the only one still counting in memory. See
  // `isSharedRateLimited` for why this one does not belong in the database.
  const redirectRateLimiter = createRateLimiter({
    max: REDIRECT_RATE_LIMIT_MAX,
    windowMs: REDIRECT_RATE_LIMIT_WINDOW_MS,
  });

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      // The pipeline already converts errors into responses, so reaching here
      // means the failure happened while writing one. Nothing can be sent, so
      // record it and drop the connection rather than leaving it open.
      send(response, toErrorResponse(error, { method: '', path: '' }), 'GET');
    });
  });

  // A size limit without a time limit stops nothing. A client that opens a
  // connection and sends headers one byte at a time occupies this
  // single-process service indefinitely otherwise.
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;

  /**
   * Runs one request through match, body reading, handler, and response.
   *
   * @param request - Node's request.
   * @param response - Node's response.
   */
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const rawUrl = request.url ?? '/';
    const url = new URL(rawUrl, config.baseUrl);

    const match = router.match(method, url.pathname);

    if (match.type === 'not-found') {
      send(response, notFoundResponse(), method);
      return;
    }

    if (match.type === 'method-not-allowed') {
      send(response, methodNotAllowedResponse(match.allow), method);
      return;
    }

    // Resolved once, for every request, and then passed down. The limiter and
    // analytics both need it, and resolving it twice is how two features that
    // must agree on who a caller is start disagreeing.
    const clientIp = resolveClientIp(
      {
        forwardedFor: request.headers['x-forwarded-for'],
        remoteAddress: request.socket.remoteAddress,
      },
      config.trustProxyHops,
    );

    const limited = await applyRateLimit(url.pathname, clientIp);
    if (limited !== undefined) {
      send(response, toErrorResponse(limited, { method, path: url.pathname }), method);
      if (!request.readableEnded) request.resume();
      return;
    }

    /**
     * Counts this request against whichever limit governs its path.
     *
     * @param pathname - The request path.
     * @param address - The resolved client address.
     * @returns The error to send, or `undefined` when the request may proceed.
     */
    async function applyRateLimit(
      pathname: string,
      address: string,
    ): Promise<AppError | undefined> {
      if (isSharedRateLimited(pathname)) {
        const credential = CREDENTIAL_PATHS.has(pathname);
        const limit = credential ? authLimit : apiLimit;
        const bucket = `${namespace}${credential ? 'auth' : 'api'}:${address}`;

        let decision;
        try {
          decision = await checkSharedLimit(bucket, limit);
        } catch (error) {
          // Fail closed. The counter lives in the same database every route
          // behind this point needs, so a counter that cannot be read is a
          // database that cannot serve the request either. Answering 503 says
          // that plainly; allowing the request through would remove the limit at
          // exactly the moment the service is least able to absorb load.
          log('error', 'rate limit check failed', {
            path: pathname,
            ...describeError(error),
          });
          return new AppError('SERVICE_UNAVAILABLE', 'Try again shortly.', 503, {
            headers: { 'Retry-After': '1' },
          });
        }

        return decision.allowed ? undefined : tooManyRequests(decision.retryAfterSeconds);
      }

      // Everything else is the redirect path, counted in this process.
      const decision = redirectRateLimiter.check(address);
      return decision.allowed ? undefined : tooManyRequests(decision.retryAfterSeconds);
    }

    let body: unknown;
    if (BODY_METHODS.has(method.toUpperCase())) {
      const read = await readJsonBody(request);
      if (!read.ok) {
        send(
          response,
          toErrorResponse(new AppError(read.code, read.message, read.status), {
            method,
            path: url.pathname,
          }),
          method,
        );
        return;
      }
      body = read.value;
    }

    const context: RequestContext = {
      method: method.toUpperCase(),
      path: url.pathname,
      params: match.params,
      query: url.searchParams,
      headers: request.headers,
      clientIp,
      rateLimitNamespace: namespace,
      ...(body === undefined ? {} : { body }),
    };

    let result: RouteResponse;
    try {
      result = await match.route.handle(context);
    } catch (error) {
      result = toErrorResponse(error, { method, path: url.pathname });
    }

    send(response, result, method);

    // Drain anything the client is still sending, now that the response has
    // gone out. An oversized body stops being read at the limit, which leaves
    // the stream paused; leaving it that way makes the client report a
    // connection reset instead of reading the status just sent.
    //
    // The cost is accepting bytes already in flight for a request that was
    // refused. That is the correct trade: the alternative is a caller who
    // cannot tell a size limit from a network failure.
    if (!request.readableEnded) request.resume();
  }

  return server;
}
