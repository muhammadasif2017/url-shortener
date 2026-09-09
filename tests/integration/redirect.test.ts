import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { closePool } from '../../src/db/pool.ts';
import { identityRoutes } from '../../src/modules/identity/identity.routes.ts';
import { linkRoutes } from '../../src/modules/links/links.routes.ts';
import {
  authHeaders,
  registerAccount,
  truncateUsers,
  type TestAccount,
} from '../helpers/auth.ts';
import { insertLink, truncateLinks } from '../helpers/db.ts';
import { startTestServer, type TestServer } from '../helpers/server.ts';

/**
 * The redirect route, the read route, listing, and deletion.
 *
 * Redirects are never followed by the test client. The assertion is about the
 * 302 itself, and a client that followed it would report the destination's
 * status instead.
 */

let server: TestServer;

before(async () => {
  // Several tests here register accounts to exercise ownership, which is more
  // than the production credential limit allows. That limit is tested on its own
  // server in rateLimit.test.ts.
  server = await startTestServer([...linkRoutes, ...identityRoutes], {
    authRateLimit: { max: 10_000, windowMs: 60_000 },
  });
});

beforeEach(async () => {
  await truncateUsers();
  await truncateLinks();
});

/**
 * Creates a link owned by an account, through the API.
 *
 * Ownership cannot be arranged with a direct insert here, because the point of
 * these tests is that the API attributes a link to the session that created it.
 */
async function createOwnedLink(
  account: TestAccount,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await server.fetch('/api/links', {
    method: 'POST',
    headers: authHeaders(account.cookie, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });

  if (response.status !== 201) {
    throw new Error(`Create failed with ${response.status}: ${await response.text()}`);
  }

  return ((await response.json()) as { slug: string }).slug;
}

after(async () => {
  await server.close();
  await closePool();
});

/** Shape of an error response. */
type ErrorBody = { error: { code: string } };

describe('GET /:slug', () => {
  it('redirects with 302 and the exact destination', async () => {
    await insertLink({ slug: 'target', url: 'https://example.com/deep/path?a=1' });

    const response = await server.fetch('/target');

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://example.com/deep/path?a=1');
  });

  it('tells browsers not to cache the redirect', async () => {
    // A cached redirect keeps working after the link is deleted, and hides
    // every later visit from the server.
    await insertLink({ slug: 'nocache' });
    const response = await server.fetch('/nocache');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('returns 404 for an unknown slug', async () => {
    const response = await server.fetch('/nothinghere');

    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as ErrorBody).error.code, 'LINK_NOT_FOUND');
  });

  it('returns 410 for an expired link, not 404', async () => {
    // The two mean different things to whoever followed the link: one says the
    // link never existed, the other that it did and has lapsed.
    await insertLink({ slug: 'expired', expiresAt: new Date(Date.now() - 1000) });

    const response = await server.fetch('/expired');

    assert.equal(response.status, 410);
    assert.equal(((await response.json()) as ErrorBody).error.code, 'LINK_EXPIRED');
  });

  it('still redirects a link whose expiry is in the future', async () => {
    await insertLink({ slug: 'future', expiresAt: new Date(Date.now() + 86_400_000) });
    assert.equal((await server.fetch('/future')).status, 302);
  });

  it('matches slugs case-sensitively, as URLs are', async () => {
    await insertLink({ slug: 'CaseSlug' });

    assert.equal((await server.fetch('/CaseSlug')).status, 302);
    assert.equal((await server.fetch('/caseslug')).status, 404);
  });

  it('answers HEAD with the same status and headers, and no body', async () => {
    // Link checkers, chat unfurlers, and uptime monitors all probe with HEAD.
    await insertLink({ slug: 'headable', url: 'https://example.com/x' });

    const response = await server.fetch('/headable', { method: 'HEAD' });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://example.com/x');
    assert.equal(await response.text(), '');
  });

  it('does not swallow the health route', async () => {
    // /:slug is registered before /health in the route table on purpose. A
    // router that respected registration order would fail here.
    assert.equal((await server.fetch('/health')).status, 200);
  });

  it('does not swallow a two-segment API path', async () => {
    assert.notEqual((await server.fetch('/api/links')).status, 302);
  });
});

describe('GET /api/links/:slug', () => {
  it('returns metadata', async () => {
    await insertLink({ slug: 'meta', url: 'https://example.com/meta' });

    const response = await server.fetch('/api/links/meta');

    assert.equal(response.status, 200);
    const body = (await response.json()) as { slug: string; url: string };
    assert.equal(body.slug, 'meta');
    assert.equal(body.url, 'https://example.com/meta');
  });

  it('describes an expired link rather than refusing it', async () => {
    // This endpoint describes a link; it does not follow one. The same slug
    // gives 410 on the redirect route and 200 here.
    await insertLink({ slug: 'gone', expiresAt: new Date(Date.now() - 1000) });

    assert.equal((await server.fetch('/gone')).status, 410);

    const response = await server.fetch('/api/links/gone');
    assert.equal(response.status, 200);
    const body = (await response.json()) as { expiresAt: string };
    assert.ok(new Date(body.expiresAt).getTime() < Date.now());
  });

  it('returns 404 for an unknown slug', async () => {
    assert.equal((await server.fetch('/api/links/missing')).status, 404);
  });
});

describe('GET /api/links', () => {
  it('requires a session', async () => {
    assert.equal((await server.fetch('/api/links')).status, 401);
  });

  it('returns only the caller\'s own links, newest first', async () => {
    const mine = await registerAccount(server);
    const theirs = await registerAccount(server);

    await createOwnedLink(mine, { url: 'https://example.com/1', customSlug: 'mine1' });
    await createOwnedLink(theirs, { url: 'https://example.com/x', customSlug: 'theirs' });
    await createOwnedLink(mine, { url: 'https://example.com/2', customSlug: 'mine2' });

    // An anonymous link belongs to nobody and must appear in no listing.
    await insertLink({ slug: 'orphan' });

    const response = await server.fetch('/api/links', {
      headers: authHeaders(mine.cookie),
    });
    const body = (await response.json()) as { data: { slug: string }[] };

    assert.deepEqual(
      body.data.map((link) => link.slug),
      ['mine2', 'mine1'],
    );
  });

  it('pages without duplicating or missing a row', async () => {
    const account = await registerAccount(server);

    for (const slug of ['pg1', 'pg2', 'pg3', 'pg4', 'pg5']) {
      await createOwnedLink(account, { url: 'https://example.com/p', customSlug: slug });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const path: string =
        cursor === null ? '/api/links?limit=2' : `/api/links?limit=2&cursor=${cursor}`;
      const body = (await (
        await server.fetch(path, { headers: authHeaders(account.cookie) })
      ).json()) as { data: { slug: string }[]; nextCursor: string | null };

      seen.push(...body.data.map((link) => link.slug));
      cursor = body.nextCursor;
      pages += 1;
      assert.ok(pages < 10, 'pagination did not terminate');
    } while (cursor !== null);

    assert.equal(pages, 3);
    assert.deepEqual(seen, ['pg5', 'pg4', 'pg3', 'pg2', 'pg1']);
    assert.equal(new Set(seen).size, 5);
  });

  it('returns a null cursor on the last page', async () => {
    const account = await registerAccount(server);
    await createOwnedLink(account, { url: 'https://example.com/o', customSlug: 'only' });

    const body = (await (
      await server.fetch('/api/links?limit=10', { headers: authHeaders(account.cookie) })
    ).json()) as { nextCursor: string | null };

    assert.equal(body.nextCursor, null);
  });

  it('rejects a malformed cursor', async () => {
    const account = await registerAccount(server);
    const response = await server.fetch('/api/links?cursor=not-a-real-cursor', {
      headers: authHeaders(account.cookie),
    });

    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as ErrorBody).error.code, 'INVALID_CURSOR');
  });

  it('rejects a limit outside the allowed range', async () => {
    const account = await registerAccount(server);
    const headers = authHeaders(account.cookie);

    assert.equal((await server.fetch('/api/links?limit=0', { headers })).status, 400);
    assert.equal((await server.fetch('/api/links?limit=101', { headers })).status, 400);
    assert.equal((await server.fetch('/api/links?limit=abc', { headers })).status, 400);
  });
});

describe('DELETE /api/links/:slug', () => {
  it('requires a session', async () => {
    await insertLink({ slug: 'doomed' });
    assert.equal(
      (await server.fetch('/api/links/doomed', { method: 'DELETE' })).status,
      401,
    );
  });

  it('deletes an owned link and then reports it gone on both routes', async () => {
    const account = await registerAccount(server);
    await createOwnedLink(account, { url: 'https://example.com/d', customSlug: 'doomed' });

    const deleted = await server.fetch('/api/links/doomed', {
      method: 'DELETE',
      headers: authHeaders(account.cookie),
    });

    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), '');

    assert.equal((await server.fetch('/doomed')).status, 404);
    assert.equal((await server.fetch('/api/links/doomed')).status, 404);
  });

  it('returns 403 when the link belongs to someone else', async () => {
    const owner = await registerAccount(server);
    const stranger = await registerAccount(server);

    await createOwnedLink(owner, { url: 'https://example.com/p', customSlug: 'private' });

    const response = await server.fetch('/api/links/private', {
      method: 'DELETE',
      headers: authHeaders(stranger.cookie),
    });

    // 403 rather than 404, and the difference is deliberate: the caller can
    // tell a typo from someone else's link.
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as ErrorBody).error.code, 'FORBIDDEN');

    // And the link survives.
    assert.equal((await server.fetch('/api/links/private')).status, 200);
  });

  it('refuses to delete an anonymous link, which nobody can prove they own', async () => {
    const account = await registerAccount(server);
    await insertLink({ slug: 'orphan' });

    const response = await server.fetch('/api/links/orphan', {
      method: 'DELETE',
      headers: authHeaders(account.cookie),
    });

    assert.equal(response.status, 403);
  });

  it('returns 404 when the slug never existed', async () => {
    const account = await registerAccount(server);
    const response = await server.fetch('/api/links/never', {
      method: 'DELETE',
      headers: authHeaders(account.cookie),
    });

    assert.equal(response.status, 404);
  });
});

describe('method handling', () => {
  it('returns 405 with Allow for a known path and unknown method', async () => {
    const response = await server.fetch('/api/links', { method: 'PUT' });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD, POST');
  });
});
