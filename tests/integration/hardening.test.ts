import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { closePool, pool } from '../../src/db/pool.ts';
import { hashSessionId } from '../../src/lib/sessionId.ts';
import { sweepExpiredClicks } from '../../src/modules/analytics/analytics.retention.ts';
import {
  ACCOUNT_FAILURE_MAX,
  identityRoutes,
} from '../../src/modules/identity/identity.routes.ts';
import { linkRoutes } from '../../src/modules/links/links.routes.ts';
import { registerAccount, truncateUsers } from '../helpers/auth.ts';
import { insertLink, truncateLinks } from '../helpers/db.ts';
import { startTestServer, type TestServer } from '../helpers/server.ts';

/**
 * The controls added after the threat model, checked end to end.
 *
 * Each of these replaced something that looked like a control and was not one:
 * a limiter that counted per process, a session table that held the credential
 * itself, a click table with no expiry. A unit test cannot tell those apart from
 * their replacements, because the difference only shows across two servers, in
 * what a row actually contains, or after time has passed.
 */

let server: TestServer;

before(async () => {
  server = await startTestServer([...linkRoutes, ...identityRoutes]);
});

beforeEach(async () => {
  await truncateUsers();
  await truncateLinks();
  await pool().query('truncate table rate_limit_windows');
});

after(async () => {
  await server.close();
  await closePool();
});

describe('session storage', () => {
  it('stores a hash of the session id, never the id itself', async () => {
    const account = await registerAccount(server);

    // The cookie is `session=<id>`; the row should hold the digest of that id
    // and nothing that could be replayed as a cookie.
    const sessionId = account.cookie.slice('session='.length);

    const rows = await pool().query<{ id: string }>('select id from sessions');
    assert.equal(rows.rowCount, 1);

    const stored = rows.rows[0]?.id;
    assert.equal(stored, hashSessionId(sessionId));
    assert.notEqual(stored, sessionId);
    assert.match(stored ?? '', /^[0-9a-f]{64}$/);
  });

  it('still authenticates with the cookie it issued', async () => {
    const account = await registerAccount(server);

    const response = await server.fetch('/api/auth/me', {
      headers: { cookie: account.cookie },
    });

    assert.equal(response.status, 200);
  });

  it('refuses a cookie carrying the stored hash rather than the id', async () => {
    // Anyone who reads the table gets the hash. Sending it back must not work,
    // or hashing would have moved the credential rather than removed it.
    const account = await registerAccount(server);
    const stored = hashSessionId(account.cookie.slice('session='.length));

    const response = await server.fetch('/api/auth/me', {
      headers: { cookie: `session=${stored}` },
    });

    assert.equal(response.status, 401);
  });
});

describe('shared rate limiting', () => {
  it('counts one client across two servers, as two instances would', async () => {
    // The property the in-process limiter could not have. Both servers share a
    // namespace, which is what two instances of one deployment look like.
    const namespace = `shared-${randomUUID()}:`;
    const limit = { max: 2, windowMs: 60_000 };

    const first = await startTestServer(linkRoutes, {
      rateLimitNamespace: namespace,
      rateLimit: limit,
    });
    const second = await startTestServer(linkRoutes, {
      rateLimitNamespace: namespace,
      rateLimit: limit,
    });

    try {
      const statuses: number[] = [];
      for (const instance of [first, second, first, second]) {
        const response = await instance.fetch('/api/links/does-not-exist');
        statuses.push(response.status);
        await response.body?.cancel();
      }

      // Two allowed in total, not two each. The allowed pair answers 401,
      // because reading a link's metadata now requires a session; what this
      // test cares about is which two requests reached a route at all.
      assert.deepEqual(statuses, [401, 401, 429, 429]);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('keeps the redirect path reachable when the API limit is spent', async () => {
    const namespace = `redirect-${randomUUID()}:`;
    const instance = await startTestServer(linkRoutes, {
      rateLimitNamespace: namespace,
      rateLimit: { max: 1, windowMs: 60_000 },
    });

    try {
      const link = await insertLink({ url: 'https://example.com/reachable' });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await instance.fetch('/api/links/does-not-exist');
        await response.body?.cancel();
      }

      const followed = await instance.fetch(`/${link.slug}`);
      assert.equal(followed.status, 302);
    } finally {
      await instance.close();
    }
  });
});

describe('per-account sign-in throttle', () => {
  const PASSWORD = 'a sufficiently long passphrase';

  /**
   * Attempts a sign-in.
   *
   * @param instance - The server to use.
   * @param email - Address to sign in as.
   * @param password - Password to send.
   * @returns The response status, with the body drained.
   */
  async function login(
    instance: TestServer,
    email: string,
    password: string,
  ): Promise<number> {
    const response = await instance.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    await response.body?.cancel();
    return response.status;
  }

  it('refuses further attempts on an account that has failed too often', async () => {
    // The per-address limit does nothing here: credential stuffing spreads
    // across addresses and converges on one account.
    const instance = await startTestServer(identityRoutes, {
      rateLimitNamespace: `account-${randomUUID()}:`,
    });

    try {
      const account = await registerAccount(instance);

      for (let attempt = 0; attempt < ACCOUNT_FAILURE_MAX; attempt += 1) {
        assert.equal(await login(instance, account.email, 'the wrong passphrase'), 401);
      }

      assert.equal(await login(instance, account.email, 'the wrong passphrase'), 429);

      // The correct password is refused too, which is the cost of the control
      // and the reason the window is short and the budget generous.
      assert.equal(await login(instance, account.email, PASSWORD), 429);
    } finally {
      await instance.close();
    }
  });

  it('does not let a successful sign-in spend the account budget', async () => {
    // A bucket that counted every attempt would be a lockout weapon: anyone who
    // knows an address could exhaust it without ever guessing the password.
    const instance = await startTestServer(identityRoutes, {
      rateLimitNamespace: `success-${randomUUID()}:`,
    });

    try {
      const account = await registerAccount(instance);

      // Comfortably past the failure budget. None of these count, because none
      // of them failed.
      for (let attempt = 0; attempt < ACCOUNT_FAILURE_MAX + 2; attempt += 1) {
        assert.equal(await login(instance, account.email, PASSWORD), 200);
      }
    } finally {
      await instance.close();
    }
  });
});

describe('response headers', () => {
  it('sends a referrer policy that hides the slug from the destination', async () => {
    const link = await insertLink();

    const response = await server.fetch(`/${link.slug}`);

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('referrer-policy'),
      'strict-origin-when-cross-origin',
    );
  });

  it('marks authenticated JSON as uncacheable', async () => {
    const account = await registerAccount(server);

    const response = await server.fetch('/api/auth/me', {
      headers: { cookie: account.cookie },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('omits HSTS outside production, where the promise would be false', async () => {
    // A cached HSTS entry for localhost breaks plain HTTP for every other
    // project on the machine, and clearing it is a browser settings expedition.
    const response = await server.fetch('/health');

    assert.equal(response.headers.get('strict-transport-security'), null);
  });
});

describe('click retention', () => {
  it('deletes click events older than the retention window', async () => {
    const link = await insertLink();

    const retentionDays = 90;
    await pool().query(
      `insert into click_events (link_id, occurred_at, ip_hash)
       values ($1, now() - make_interval(days => $2::int), $3),
              ($1, now(), $3)`,
      [link.id, retentionDays + 1, 'a'.repeat(64)],
    );

    const deleted = await sweepExpiredClicks();
    assert.equal(deleted, 1);

    const remaining = await pool().query<{ count: string }>(
      'select count(*) as count from click_events where link_id = $1',
      [link.id],
    );
    assert.equal(Number(remaining.rows[0]?.count), 1);
  });
});
