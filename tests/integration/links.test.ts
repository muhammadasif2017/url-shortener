import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { closePool } from '../../src/db/pool.ts';
import { linkRoutes } from '../../src/modules/links/links.routes.ts';
import { truncateUsers } from '../helpers/auth.ts';
import { insertLink, truncateLinks } from '../helpers/db.ts';
import { startTestServer, type TestServer } from '../helpers/server.ts';

/**
 * The links module, over real HTTP against a real database.
 */

let server: TestServer;

before(async () => {
  server = await startTestServer(linkRoutes);
});

beforeEach(async () => {
  await truncateUsers();
  await truncateLinks();
});

after(async () => {
  await server.close();
  await closePool();
});

/** Shape of a link in a response. */
type LinkBody = {
  slug: string;
  shortUrl: string;
  url: string;
  expiresAt: string | null;
  createdAt: string;
};

/** Shape of an error response. */
type ErrorBody = {
  error: { code: string; message: string; details?: { field: string }[] };
};

/**
 * Creates a link through the API.
 *
 * @param body - Request body.
 * @returns The response, unread, so a test can assert on status first.
 */
function createLink(body: unknown): Promise<Response> {
  return server.fetch('/api/links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/links', () => {
  it('creates a link with a generated slug', async () => {
    const response = await createLink({ url: 'https://example.com/a/long/path' });

    assert.equal(response.status, 201);

    const body = (await response.json()) as LinkBody;
    assert.equal(body.url, 'https://example.com/a/long/path');
    assert.equal(body.slug.length, 7);
    assert.match(body.slug, /^[0-9A-Za-z]{7}$/);
    assert.equal(body.shortUrl, `http://localhost:3000/${body.slug}`);
    assert.equal(body.expiresAt, null);
  });

  it('never exposes the internal id', async () => {
    // A sequential id tells every caller how many links exist and lets them
    // walk the entire table.
    const response = await createLink({ url: 'https://example.com' });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body['id'], undefined);
  });

  it('honours a custom slug', async () => {
    const response = await createLink({
      url: 'https://example.com',
      customSlug: 'my-link',
    });

    assert.equal(response.status, 201);
    assert.equal(((await response.json()) as LinkBody).slug, 'my-link');
  });

  it('stores an expiry', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const response = await createLink({ url: 'https://example.com', expiresAt });

    assert.equal(response.status, 201);
    assert.equal(((await response.json()) as LinkBody).expiresAt, expiresAt);
  });

  it('returns 409 for a slug already taken', async () => {
    await insertLink({ slug: 'taken' });

    const response = await createLink({ url: 'https://example.com', customSlug: 'taken' });

    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as ErrorBody).error.code, 'SLUG_TAKEN');
  });

  it('surfaces a duplicate as 409 rather than 500', async () => {
    // The unique index raises SQLSTATE 23505. Failing to translate it would
    // turn an ordinary conflict into an internal error.
    await createLink({ url: 'https://example.com', customSlug: 'dup' });
    const second = await createLink({ url: 'https://example.com', customSlug: 'dup' });

    assert.equal(second.status, 409);
  });

  it('returns 400, not 409, for a reserved slug', async () => {
    // A reserved slug conflicts with no stored row and is knowable without
    // touching the database, which makes it validation rather than conflict.
    const response = await createLink({ url: 'https://example.com', customSlug: 'health' });

    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as ErrorBody).error.code, 'SLUG_RESERVED');
  });

  it('rejects a reserved slug in any case', async () => {
    const response = await createLink({ url: 'https://example.com', customSlug: 'HeAlTh' });
    assert.equal(response.status, 400);
  });

  it('rejects a dangerous scheme with a field-level error', async () => {
    const response = await createLink({ url: 'javascript:alert(1)' });

    assert.equal(response.status, 400);
    const body = (await response.json()) as ErrorBody;
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.equal(body.error.details?.[0]?.field, 'url');
  });

  it('rejects a destination on this service, which would chain or loop', async () => {
    const response = await createLink({ url: 'http://localhost:3000/abc' });
    assert.equal(response.status, 400);
  });

  it('rejects a slug the database constraint would reject', async () => {
    const response = await createLink({ url: 'https://example.com', customSlug: 'has space' });
    assert.equal(response.status, 400);
  });

  it('reports every bad field at once', async () => {
    const response = await createLink({
      url: 'file:///etc/passwd',
      customSlug: 'a',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as ErrorBody;
    assert.equal(body.error.details?.length, 3);
  });

  it('returns 413 for an oversized body', async () => {
    const response = await server.fetch('/api/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `https://example.com/${'a'.repeat(20 * 1024)}` }),
    });

    assert.equal(response.status, 413);
  });

  it('does not store anything when validation fails', async () => {
    await createLink({ url: 'javascript:alert(1)', customSlug: 'rejected' });

    // Checked through the read route rather than the listing, because listing
    // is scoped to an authenticated owner and this request had no session.
    const read = await server.fetch('/api/links/rejected');
    assert.equal(read.status, 404);
  });

  it('rejects a state-changing request that does not declare JSON', async () => {
    // An HTML form cannot express application/json as an enctype, so this check
    // is what stops a cross-site form post that carries the session cookie.
    const response = await server.fetch('/api/links', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });

    assert.equal(response.status, 415);
  });

  it('creates an anonymous link when no session is sent', async () => {
    const response = await createLink({ url: 'https://example.com/anon' });
    assert.equal(response.status, 201);
  });
});
