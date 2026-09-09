import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { closePool } from '../../src/db/pool.ts';
import { linkRoutes } from '../../src/modules/links/links.routes.ts';
import { insertLink, truncateLinks } from '../helpers/db.ts';
import { startTestServer, type TestServer } from '../helpers/server.ts';

/**
 * Rate limiting, over real HTTP.
 *
 * The test environment sets a small limit so this file does not have to send
 * sixty requests to prove one behaviour.
 */

let server: TestServer;

/**
 * A deliberately small limit, set for this server only.
 *
 * Lowering it process-wide would make every other integration file trip the
 * limiter, and those failures would look like endpoint bugs.
 */
const LIMIT = 5;

before(async () => {
  server = await startTestServer(linkRoutes, {
    rateLimit: { max: LIMIT, windowMs: 60_000 },
  });
});

beforeEach(async () => {
  await truncateLinks();
});

after(async () => {
  await server.close();
  await closePool();
});

describe('rate limiting', () => {
  it('refuses with 429 and Retry-After once the limit is passed', async () => {
    let refused: Response | undefined;

    // One past the limit. Every request here targets /api, which is limited.
    for (let attempt = 0; attempt < LIMIT + 1; attempt += 1) {
      const response = await server.fetch('/api/links/does-not-exist');
      if (response.status === 429) {
        refused = response;
        break;
      }
      await response.body?.cancel();
    }

    assert.ok(refused, `expected a 429 within ${LIMIT + 1} requests`);
    assert.equal(refused.status, 429);

    const retryAfter = Number(refused.headers.get('retry-after'));
    assert.ok(retryAfter >= 1, 'Retry-After must be at least one second');

    const body = (await refused.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'RATE_LIMITED');
  });

  it('leaves the redirect route reachable while the API is limited', async () => {
    // The redirect is the product. One shared office behind a single address
    // must not be able to exhaust it for everyone there.
    await insertLink({ slug: 'stillworks', url: 'https://example.com/ok' });

    for (let attempt = 0; attempt < LIMIT + 5; attempt += 1) {
      const response = await server.fetch('/api/links/does-not-exist');
      await response.body?.cancel();
    }

    const redirected = await server.fetch('/stillworks');
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get('location'), 'https://example.com/ok');
  });

  it('leaves the health check reachable while the API is limited', async () => {
    // A rate-limited health check reports the service as unhealthy under the
    // platform's own monitoring, which polls far more often than any human.
    for (let attempt = 0; attempt < LIMIT + 5; attempt += 1) {
      const response = await server.fetch('/api/links/does-not-exist');
      await response.body?.cancel();
    }

    assert.equal((await server.fetch('/health')).status, 200);
  });
});
