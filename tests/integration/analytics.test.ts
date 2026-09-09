import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { closePool, pool } from '../../src/db/pool.ts';
import {
  drainPendingWrites,
  pendingWriteCount,
  recordClick,
} from '../../src/modules/analytics/analytics.service.ts';
import { linkRoutes } from '../../src/modules/links/links.routes.ts';
import { insertLink, truncateLinks } from '../helpers/db.ts';
import { startTestServer, type TestServer } from '../helpers/server.ts';

/**
 * Click recording, end to end.
 *
 * Every assertion here runs after `drainPendingWrites()`. The write is started
 * without being awaited, so asserting straight after the redirect would pass or
 * fail on timing rather than on behaviour.
 */

let server: TestServer;

before(async () => {
  server = await startTestServer(linkRoutes);
});

beforeEach(async () => {
  // `truncate ... cascade` reaches click_events through its foreign key, so
  // counts cannot leak between files.
  await truncateLinks();
});

after(async () => {
  await server.close();
  await closePool();
});

/** A stored click row, in the shape these tests assert on. */
type ClickRow = {
  readonly link_id: string;
  readonly referrer: string | null;
  readonly user_agent: string | null;
  readonly ip_hash: string;
  readonly is_bot: boolean;
};

/**
 * Reads every click event for a link.
 *
 * @param linkId - The link.
 * @returns Its rows, oldest first.
 */
async function clicksFor(linkId: string): Promise<ClickRow[]> {
  const result = await pool().query<ClickRow>(
    `select link_id, referrer, user_agent, ip_hash, is_bot
       from click_events
      where link_id = $1
      order by id`,
    [linkId],
  );
  return result.rows;
}

describe('click recording', () => {
  it('writes one row per redirect', async () => {
    const link = await insertLink();

    for (let index = 0; index < 3; index += 1) {
      const response = await server.fetch(`/${link.slug}`);
      assert.equal(response.status, 302);
    }

    await drainPendingWrites();

    const rows = await clicksFor(link.id);
    assert.equal(rows.length, 3);
  });

  it('records the referrer, the user agent, and a hashed address', async () => {
    const link = await insertLink();

    await server.fetch(`/${link.slug}`, {
      headers: {
        Referer: 'https://news.example.com/story',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/141.0',
      },
    });
    await drainPendingWrites();

    const [row] = await clicksFor(link.id);
    assert.equal(row?.referrer, 'https://news.example.com/story');
    assert.equal(row?.user_agent, 'Mozilla/5.0 (X11; Linux x86_64) Firefox/141.0');
    assert.match(row?.ip_hash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(row?.is_bot, false);
  });

  it('never stores the raw address', async () => {
    const link = await insertLink();

    await server.fetch(`/${link.slug}`);
    await drainPendingWrites();

    const [row] = await clicksFor(link.id);
    assert.ok(!(row?.ip_hash ?? '').includes('127.0.0.1'));
  });

  it('stores a missing referrer as null, which is what direct traffic is', async () => {
    const link = await insertLink();

    await server.fetch(`/${link.slug}`);
    await drainPendingWrites();

    const [row] = await clicksFor(link.id);
    assert.equal(row?.referrer, null);
  });

  it('flags an announced bot and keeps the row', async () => {
    const link = await insertLink();

    await server.fetch(`/${link.slug}`, { headers: { 'User-Agent': 'curl/8.0' } });
    await drainPendingWrites();

    const [row] = await clicksFor(link.id);
    assert.equal(row?.is_bot, true);
  });

  it('truncates an over-length referrer instead of losing the click', async () => {
    const link = await insertLink();

    await server.fetch(`/${link.slug}`, {
      headers: { Referer: `https://example.com/${'x'.repeat(4000)}` },
    });
    await drainPendingWrites();

    const rows = await clicksFor(link.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.referrer?.length, 2048);
  });

  it('records nothing for a slug that does not exist', async () => {
    const response = await server.fetch('/nosuchslug');
    await drainPendingWrites();

    assert.equal(response.status, 404);

    const result = await pool().query<{ n: number }>('select count(*)::int as n from click_events');
    assert.equal(result.rows[0]?.n, 0);
  });

  it('survives a failing insert without breaking anything', async () => {
    // A link id that no longer exists violates the foreign key, which is the
    // realistic failure: a link deleted between the redirect and the write.
    recordClick({
      linkId: '999999999',
      clientIp: '203.0.113.9',
      referrer: undefined,
      userAgent: undefined,
    });

    await drainPendingWrites();

    // The failure is logged and swallowed. Reaching this line at all is the
    // assertion: an unhandled rejection would have taken the process down.
    assert.equal(pendingWriteCount(), 0);
  });

  it('keeps serving redirects after a write failure', async () => {
    const link = await insertLink();

    recordClick({
      linkId: '999999999',
      clientIp: '203.0.113.9',
      referrer: undefined,
      userAgent: undefined,
    });

    const response = await server.fetch(`/${link.slug}`);
    await drainPendingWrites();

    assert.equal(response.status, 302);
    assert.equal((await clicksFor(link.id)).length, 1);
  });
});
