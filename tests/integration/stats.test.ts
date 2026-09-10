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
 * The statistics endpoint.
 *
 * Every count assertion runs after `drainPendingWrites()`, because the click
 * write is deliberately not awaited and asserting sooner would test timing
 * rather than behaviour.
 */

let server: TestServer;
let account: TestAccount;

/** The shape the endpoint returns. */
type StatsBody = {
  readonly slug: string;
  readonly windowDays: number;
  readonly total: number;
  readonly uniqueVisitors: number;
  readonly botClicks: number;
  readonly byDay: readonly { readonly date: string; readonly clicks: number }[];
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
 * Inserted directly rather than through the API, so a failure in link creation
 * cannot fail a test about statistics.
 *
 * @returns The link's slug and id.
 */
async function ownedLink(): Promise<{ readonly id: string; readonly slug: string }> {
  const link = await insertLink();
  await pool().query('update links set owner_id = $1 where id = $2', [account.userId, link.id]);
  return link;
}

/**
 * Reads statistics as the owner.
 *
 * @param slug - The link.
 * @param query - Query string, including the leading `?`, or empty.
 * @returns The response.
 */
function readStats(slug: string, query = ''): Promise<Response> {
  return server.fetch(`/api/links/${slug}/stats${query}`, { headers: authHeaders(account.cookie) });
}

describe('GET /api/links/:slug/stats', () => {
  it('reports a total equal to the number of redirects performed', async () => {
    const link = await ownedLink();

    for (let index = 0; index < 3; index += 1) {
      await server.fetch(`/${link.slug}`);
    }
    await drainPendingWrites();

    const response = await readStats(link.slug);
    const body = (await response.json()) as StatsBody;

    assert.equal(response.status, 200);
    assert.equal(body.total, 3);
    assert.equal(body.slug, link.slug);
  });

  it('returns counts as numbers, not the strings pg gives for bigint', async () => {
    const link = await ownedLink();

    await server.fetch(`/${link.slug}`);
    await drainPendingWrites();

    const body = (await (await readStats(link.slug)).json()) as StatsBody;

    // `assert.equal(total, 1)` under assert/strict fails against '1', which is
    // exactly what an unconverted count would be.
    assert.equal(typeof body.total, 'number');
    assert.equal(typeof body.uniqueVisitors, 'number');
    assert.equal(typeof body.botClicks, 'number');
    assert.equal(typeof body.byDay[0]?.clicks, 'number');
  });

  it('counts one visitor once, however many times they click', async () => {
    const link = await ownedLink();

    await server.fetch(`/${link.slug}`);
    await server.fetch(`/${link.slug}`);
    await drainPendingWrites();

    const body = (await (await readStats(link.slug)).json()) as StatsBody;

    assert.equal(body.total, 2);
    assert.equal(body.uniqueVisitors, 1);
  });

  it('excludes announced bots from the total and reports them separately', async () => {
    const link = await ownedLink();

    await server.fetch(`/${link.slug}`);
    await server.fetch(`/${link.slug}`, { headers: { 'User-Agent': 'curl/8.0' } });
    await drainPendingWrites();

    const body = (await (await readStats(link.slug)).json()) as StatsBody;

    assert.equal(body.total, 1);
    assert.equal(body.botClicks, 1);
  });

  it('returns a dense series with one entry per day in the window', async () => {
    const link = await ownedLink();

    await server.fetch(`/${link.slug}`);
    await drainPendingWrites();

    const body = (await (await readStats(link.slug, '?days=7')).json()) as StatsBody;

    assert.equal(body.windowDays, 7);
    assert.equal(body.byDay.length, 7);

    // Days with no traffic are zeros rather than absent, so a consumer never
    // has to rebuild the calendar and a gap cannot read as continuity.
    assert.equal(body.byDay.filter((day) => day.clicks === 0).length, 6);
    assert.equal(body.byDay.at(-1)?.clicks, 1);
  });

  it('orders the series oldest first, as UTC calendar days', async () => {
    const link = await ownedLink();

    const body = (await (await readStats(link.slug, '?days=3')).json()) as StatsBody;
    const dates = body.byDay.map((day) => day.date);

    assert.deepEqual(dates, [...dates].sort());
    for (const date of dates) assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('defaults to a thirty day window', async () => {
    const link = await ownedLink();

    const body = (await (await readStats(link.slug)).json()) as StatsBody;

    assert.equal(body.windowDays, 30);
    assert.equal(body.byDay.length, 30);
  });

  it('excludes clicks older than the window', async () => {
    const link = await ownedLink();

    await server.fetch(`/${link.slug}`);
    await drainPendingWrites();

    // Backdated past the window rather than deleted, so this proves the window
    // filters rather than the row being absent.
    await pool().query(
      `update click_events set occurred_at = now() - interval '10 days' where link_id = $1`,
      [link.id],
    );

    const body = (await (await readStats(link.slug, '?days=3')).json()) as StatsBody;

    assert.equal(body.total, 0);
    assert.equal(
      body.byDay.every((day) => day.clicks === 0),
      true,
    );
  });

  it('rejects a window outside the permitted range', async () => {
    const link = await ownedLink();

    for (const days of ['0', '91', 'seven', '-1']) {
      const response = await readStats(link.slug, `?days=${days}`);
      const body = (await response.json()) as { readonly error: { readonly code: string } };

      assert.equal(response.status, 400);
      assert.equal(body.error.code, 'VALIDATION_FAILED');
    }
  });

  it('accepts the window bounds themselves', async () => {
    const link = await ownedLink();

    assert.equal((await readStats(link.slug, '?days=1')).status, 200);
    assert.equal((await readStats(link.slug, '?days=90')).status, 200);
  });
});

describe('statistics authorisation', () => {
  it('refuses a caller with no session', async () => {
    const link = await ownedLink();

    const response = await server.fetch(`/api/links/${link.slug}/stats`);
    const body = (await response.json()) as { readonly error: { readonly code: string } };

    assert.equal(response.status, 401);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  });

  it('refuses another user, because a slug is public and cannot be a credential', async () => {
    const link = await ownedLink();
    const other = await registerAccount(server);

    const response = await server.fetch(`/api/links/${link.slug}/stats`, {
      headers: authHeaders(other.cookie),
    });
    const body = (await response.json()) as { readonly error: { readonly code: string } };

    assert.equal(response.status, 403);
    assert.equal(body.error.code, 'FORBIDDEN');
  });

  it('refuses an anonymous link, which nobody can prove they created', async () => {
    const link = await insertLink();

    const response = await readStats(link.slug);

    assert.equal(response.status, 403);
  });

  it('answers 404 for a slug that does not exist', async () => {
    const response = await readStats('nosuchslug');
    const body = (await response.json()) as { readonly error: { readonly code: string } };

    assert.equal(response.status, 404);
    assert.equal(body.error.code, 'LINK_NOT_FOUND');
  });

  it('does not let the redirect route answer the stats path', async () => {
    // Four segments, and the router matches only on an equal count, so `/:slug`
    // cannot reach this path however routes were registered.
    const response = await server.fetch('/api/links/whatever/stats');
    assert.equal(response.status, 401);
  });
});
