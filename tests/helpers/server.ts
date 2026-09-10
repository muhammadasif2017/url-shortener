import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { RouteTable } from '../../src/http/context.ts';
import { createAppServer, type ServerOptions } from '../../src/server.ts';

/**
 * Test helper for driving the real server over real HTTP.
 *
 * There is no Supertest here, and none is needed. The server listens on an
 * ephemeral port and tests call it with the global `fetch`. That exercises the
 * actual request pipeline, including header handling and status codes, rather
 * than a stand-in for it.
 */

/** A running test server, with the pieces a test needs to talk to it. */
export type TestServer = {
  /** Base URL, including the port the operating system assigned. */
  readonly url: string;
  /**
   * Sends a request to a path on this server.
   *
   * Redirects are never followed. Following them would make the redirect route
   * untestable, because the assertion is about the 302 itself.
   *
   * @param path - Path beginning with `/`.
   * @param init - Standard `fetch` options.
   * @returns The response.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Stops the server. */
  close(): Promise<void>;
};

/**
 * Starts the application on an ephemeral port.
 *
 * Port `0` asks the operating system for any free port, so tests never collide
 * with each other or with a development server already running on 3000.
 *
 * @param routes - Module routes to mount alongside the built-in health route.
 * @param options - Server overrides, such as a smaller rate limit. Each call
 *   builds its own limiter, so one test file's request count never affects
 *   another's.
 * @returns The running server.
 */
export async function startTestServer(
  routes: RouteTable = [],
  options: ServerOptions = {},
): Promise<TestServer> {
  // Shared rate-limit counters live in the database, keyed by client address,
  // and every test server binds to loopback. Without a namespace per server the
  // suite would count as one client and later tests would start pre-limited.
  // Limits are effectively off unless a test asks for them. Every test server
  // shares one client address, and several files register an account per test,
  // so the production credential limit of ten per fifteen minutes would fail
  // whichever test happened to run eleventh. A test that is about limiting
  // passes its own numbers.
  const server = createAppServer(routes, {
    rateLimitNamespace: `test-${randomUUID()}:`,
    rateLimit: { max: 100_000, windowMs: 60_000 },
    authRateLimit: { max: 100_000, windowMs: 60_000 },
    ...options,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    fetch: (path, init) => fetch(`${url}${path}`, { redirect: 'manual', ...init }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
