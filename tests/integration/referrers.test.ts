import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { closePool, pool } from '../../src/db/pool.ts';
import { analyticsRoutes } from '../../src/modules/analytics/analytics.routes.ts';
import { drainPendingWrites } from '../../src/modules/analytics/analytics.service.ts';
import { identityRoutes } from '../../src/modules/identity/identity.routes.ts';
import { linkRoutes } from '../../src/modules/links/links.routes.ts';
import { authHeaders, registerAccount, truncateUsers, type TestAccount } from '../helpers/auth.ts';
import { insertLink, truncateLinks } from '../helpers/db.ts';
import { startTestServer, type TestServer } from '../helpers/server.ts';

/**
 * The top-referrers endpoint.
 *
 * Referrers are attacker-supplied header values, so these tests send them as
 * such: arbitrary strings, absent headers, and repeated values.
 */

let server: TestServer;
let account: TestAccount;

/** The shape the endpoint returns. */
type ReferrersBody = {
  readonly slug: string;
  readonly windowDays: number;
  readonly referrers: readonly { readonly referrer: string | null; readonly clicks: number }[];
};

before(async () => {
  server = await startTestServer([...linkRoutes, ...identityRoutes, ...analyticsRoutes], {
    authRateLimit: { max: 10_000, windowMs: 60_000 },
  });
});

beforeEach(async () => {
  await truncateUsers();
  await truncateLinks();
  account = await registerAccount(server);
});

after(async () => {
  await server.close();
  await closePool();
});

/**
 * Creates a link owned by the test account.
 *
 * @returns The link's slug and id.
 */
async function ownedLink(): Promise<{ readonly id: string; readonly slug: string }> {
  const link = await insertLink();
  await pool().query('update links set owner_id = $1 where id = $2', [account.userId, link.id]);
  return link;
}

/**
 * Follows a link, optionally with a referrer.
 *
 * @param slug - The link.
 * @param referrer - The `Referer` header, or absent for direct traffic.
 */
async function visit(slug: string, referrer?: string): Promise<void> {
  await server.fetch(`/${slug}`, {
    headers: referrer === undefined ? {} : { Referer: referrer },
  });
}

/**
 * Reads referrers as the owner.
 *
 * @param slug - The link.
 * @param query - Query string, including the leading `?`, or empty.
 * @returns The response.
 */
function readReferrers(slug: string, query = ''): Promise<Response> {
  return server.fetch(`/api/links/${slug}/referrers${query}`, {
    headers: authHeaders(account.cookie),
  });
}

describe('GET /api/links/:slug/referrers', () => {
  it('ranks sources from most to least', async () => {
    const link = await ownedLink();

    await visit(link.slug, 'https://news.example.com/');
    await visit(link.slug, 'https://news.example.com/');
    await visit(link.slug, 'https://forum.example.org/');
    await drainPendingWrites();

    const body = (await (await readReferrers(link.slug)).json()) as ReferrersBody;

    assert.deepEqual(body.referrers, [
      { referrer: 'https://news.example.com/', clicks: 2 },
      { referrer: 'https://forum.example.org/', clicks: 1 },
    ]);
  });

  it('reports direct traffic as null rather than a label', async () => {
    const link = await ownedLink();

    await visit(link.slug);
    await drainPendingWrites();

    const body = (await (await readReferrers(link.slug)).json()) as ReferrersBody;

    // A site could call itself "direct" and become indistinguishable from
    // visitors who arrived with no referrer at all.
    assert.deepEqual(body.referrers, [{ referrer: null, clicks: 1 }]);
  });

  it('breaks ties in a stable order across calls', async () => {
    const link = await ownedLink();

    await visit(link.slug, 'https://b.example.com/');
    await visit(link.slug, 'https://a.example.com/');
    await drainPendingWrites();

    const first = (await (await readReferrers(link.slug)).json()) as ReferrersBody;
    const second = (await (await readReferrers(link.slug)).json()) as ReferrersBody;

    assert.deepEqual(first.referrers, second.referrers);
    assert.equal(first.referrers[0]?.referrer, 'https://a.example.com/');
  });

  it('returns counts as numbers, not the strings pg gives for bigint', async () => {
    const link = await ownedLink();

    await visit(link.slug, 'https://news.example.com/');
    await drainPendingWrites();

    const body = (await (await readReferrers(link.slug)).json()) as ReferrersBody;

    assert.equal(typeof body.referrers[0]?.clicks, 'number');
  });

  it('excludes announced bots', async () => {
    const link = await ownedLink();

    await server.fetch(`/${link.slug}`, {
      headers: { Referer: 'https://crawler.example.net/', 'User-Agent': 'Googlebot/2.1' },
    });
    await visit(link.slug, 'https://news.example.com/');
    await drainPendingWrites();

    const body = (await (await readReferrers(link.slug)).json()) as ReferrersBody;

    assert.deepEqual(body.referrers, [{ referrer: 'https://news.example.com/', clicks: 1 }]);
  });

  it('honours the limit and defaults to ten', async () => {
    const link = await ownedLink();

    for (let index = 0; index < 12; index += 1) {
      await visit(link.slug, `https://site-${index}.example.com/`);
    }
    await drainPendingWrites();

    const defaulted = (await (await readReferrers(link.slug)).json()) as ReferrersBody;
    const limited = (await (await readReferrers(link.slug, '?limit=3')).json()) as ReferrersBody;

    assert.equal(defaulted.referrers.length, 10);
    assert.equal(limited.referrers.length, 3);
  });

  it('excludes clicks older than the window', async () => {
    const link = await ownedLink();

    await visit(link.slug, 'https://news.example.com/');
    await drainPendingWrites();

    await pool().query(
      `update click_events set occurred_at = now() - interval '10 days' where link_id = $1`,
      [link.id],
    );

    const body = (await (await readReferrers(link.slug, '?days=3')).json()) as ReferrersBody;

    assert.equal(body.windowDays, 3);
    assert.deepEqual(body.referrers, []);
  });

  it('rejects a limit outside the permitted range', async () => {
    const link = await ownedLink();

    for (const limit of ['0', '51', 'ten']) {
      const response = await readReferrers(link.slug, `?limit=${limit}`);
      const body = (await response.json()) as { readonly error: { readonly code: string } };

      assert.equal(response.status, 400);
      assert.equal(body.error.code, 'VALIDATION_FAILED');
    }
  });

  it('rejects a window outside the permitted range', async () => {
    const link = await ownedLink();

    assert.equal((await readReferrers(link.slug, '?days=91')).status, 400);
  });

  it('applies the same authorisation as the statistics endpoint', async () => {
    const owned = await ownedLink();
    const anonymous = await insertLink();
    const other = await registerAccount(server);

    assert.equal((await server.fetch(`/api/links/${owned.slug}/referrers`)).status, 401);
    assert.equal(
      (
        await server.fetch(`/api/links/${owned.slug}/referrers`, {
          headers: authHeaders(other.cookie),
        })
      ).status,
      403,
    );
    assert.equal((await readReferrers(anonymous.slug)).status, 403);
    assert.equal((await readReferrers('nosuchslug')).status, 404);
  });

  it('stores a long referrer truncated rather than losing the click', async () => {
    const link = await ownedLink();

    await visit(link.slug, `https://example.com/${'x'.repeat(4000)}`);
    await drainPendingWrites();

    const body = (await (await readReferrers(link.slug)).json()) as ReferrersBody;

    assert.equal(body.referrers.length, 1);
    assert.equal(body.referrers[0]?.referrer?.length, 2048);
  });
});
