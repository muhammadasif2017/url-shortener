import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { env } from './config/env.ts';
import { pool } from './db/pool.ts';
import type { RequestContext, RouteResponse, RouteTable } from './http/context.ts';
import {
  methodNotAllowedResponse,
  notFoundResponse,
  toErrorResponse,
} from './http/errorHandler.ts';
import { readJsonBody } from './http/readBody.ts';
import { json, send } from './http/respond.ts';
import { createRouter } from './http/router.ts';
import { AppError } from './lib/AppError.ts';

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

/**
 * Builds the HTTP server.
 *
 * @param moduleRoutes - Routes contributed by feature modules. The health route
 *   is always included.
 * @returns A server that is not listening yet.
 */
export function createAppServer(moduleRoutes: RouteTable = []): Server {
  const router = createRouter([...healthRoutes, ...moduleRoutes]);
  const config = env();

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
