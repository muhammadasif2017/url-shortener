import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { closePool } from '../../src/db/pool.ts';
import type { RouteTable } from '../../src/http/context.ts';
import { startTestServer, type TestServer } from '../helpers/server.ts';

/**
 * Health check and request pipeline, exercised over real HTTP against the real
 * test database. Nothing here is mocked: a mocked query proves nothing about
 * whether the service can reach Postgres.
 */

let server: TestServer;

/**
 * A route that accepts a body, mounted only for these tests.
 *
 * Body reading happens after routing, so posting to a GET-only route returns
 * 405 and never reaches the body limit at all. Testing the limit needs a route
 * that actually accepts POST, and no module route exists yet.
 */
const echoRoutes: RouteTable = [
  {
    method: 'POST',
    path: '/test-echo',
    handle: (context) => ({ status: 200, body: { received: context.body } }),
  },
];

before(async () => {
  server = await startTestServer(echoRoutes);
});

after(async () => {
  await server.close();
  await closePool();
});

describe('GET /health', () => {
  it('reports the database as reachable', async () => {
    const response = await server.fetch('/health');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', database: 'ok' });
  });

  it('sets a JSON content type', async () => {
    const response = await server.fetch('/health');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  });

  it('answers HEAD with the same status and no body', async () => {
    const response = await server.fetch('/health', { method: 'HEAD' });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
    // The length a GET would have returned, which is what a HEAD caller wants.
    assert.ok(Number(response.headers.get('content-length')) > 0);
  });
});

describe('request pipeline', () => {
  it('returns 404 in the standard error shape for an unknown path', async () => {
    const response = await server.fetch('/api/nothing/here');

    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('returns 405 with Allow when the method is wrong for a known path', async () => {
    const response = await server.fetch('/health', { method: 'POST' });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');

    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
  });

  it('ignores the query string when matching', async () => {
    const response = await server.fetch('/health?verbose=1');
    assert.equal(response.status, 200);
  });

  it('treats a trailing slash as the same route', async () => {
    const response = await server.fetch('/health/');
    assert.equal(response.status, 200);
  });

  it('rejects a body over the limit with 413 rather than a connection reset', async () => {
    // The status has to actually reach the client. Responding mid-upload and
    // leaving the stream unread is what makes clients report ECONNRESET here.
    const response = await server.fetch('/test-echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(20 * 1024),
    });

    assert.equal(response.status, 413);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'BODY_TOO_LARGE');
  });

  it('still delivers a readable 413 for a body far over the limit', async () => {
    // 20 KB fits in socket and OS buffers, so it can pass even when the server
    // mishandles the stream. Two megabytes cannot, which is what makes this the
    // test that actually catches a premature socket teardown.
    const response = await server.fetch('/test-echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(2 * 1024 * 1024),
    });

    assert.equal(response.status, 413);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'BODY_TOO_LARGE');
  });

  it('parses a JSON body and hands it to the handler', async () => {
    const response = await server.fetch('/test-echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: { hello: 'world' } });
  });

  it('rejects malformed JSON with 400', async () => {
    const response = await server.fetch('/test-echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken":',
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'BODY_INVALID_JSON');
  });
});
