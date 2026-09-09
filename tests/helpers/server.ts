import type { AddressInfo } from 'node:net';

import type { RouteTable } from '../../src/http/context.ts';
import { createAppServer } from '../../src/server.ts';

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
 * @returns The running server.
 */
export async function startTestServer(routes: RouteTable = []): Promise<TestServer> {
  const server = createAppServer(routes);

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
