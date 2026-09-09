import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { closePool } from '../../src/db/pool.ts';
import { identityRoutes } from '../../src/modules/identity/identity.routes.ts';
import { registerAccount, truncateUsers } from '../helpers/auth.ts';
import { startTestServer, type TestServer } from '../helpers/server.ts';

/** Accounts and sessions, over real HTTP against a real database. */

let server: TestServer;

before(async () => {
  // The credential endpoints allow ten attempts per fifteen minutes in
  // production, and this file makes more than that. The limit itself is tested
  // in rateLimit.test.ts, with a server built for it; raising it here keeps
  // these tests about authentication rather than about throttling.
  server = await startTestServer(identityRoutes, {
    authRateLimit: { max: 10_000, windowMs: 60_000 },
  });
});

beforeEach(async () => {
  await truncateUsers();
});

after(async () => {
  await server.close();
  await closePool();
});

/** Shape of an error response. */
type ErrorBody = { error: { code: string } };

const PASSWORD = 'a sufficiently long passphrase';

/**
 * Posts credentials to an auth endpoint.
 *
 * @param path - Endpoint path.
 * @param body - Request body.
 * @returns The response.
 */
function post(path: string, body: unknown): Promise<Response> {
  return server.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/register', () => {
  it('creates an account and signs it in immediately', async () => {
    const response = await post('/api/auth/register', {
      email: 'someone@example.com',
      password: PASSWORD,
    });

    assert.equal(response.status, 201);

    const body = (await response.json()) as { email: string; id: string };
    assert.equal(body.email, 'someone@example.com');
    assert.ok(body.id);

    // Registering and then having to sign in separately is friction with no
    // security benefit: the caller just proved they know the password.
    assert.ok(response.headers.getSetCookie().length > 0);
  });

  it('sets a cookie JavaScript cannot read', async () => {
    const response = await post('/api/auth/register', {
      email: 'cookie@example.com',
      password: PASSWORD,
    });

    const cookie = response.headers.getSetCookie()[0] ?? '';

    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
  });

  it('never returns the password or its hash', async () => {
    const response = await post('/api/auth/register', {
      email: 'quiet@example.com',
      password: PASSWORD,
    });

    const raw = await response.text();
    assert.ok(!raw.includes(PASSWORD));
    assert.ok(!raw.includes('scrypt'));
    assert.ok(!raw.toLowerCase().includes('hash'));
  });

  it('normalises the email, so one address is one account', async () => {
    const first = await post('/api/auth/register', {
      email: '  MixedCase@Example.COM ',
      password: PASSWORD,
    });
    assert.equal(first.status, 201);
    assert.equal(((await first.json()) as { email: string }).email, 'mixedcase@example.com');

    const second = await post('/api/auth/register', {
      email: 'mixedcase@example.com',
      password: PASSWORD,
    });
    assert.equal(second.status, 409);
  });

  it('returns 409 for a duplicate address', async () => {
    await post('/api/auth/register', { email: 'dup@example.com', password: PASSWORD });
    const second = await post('/api/auth/register', {
      email: 'dup@example.com',
      password: PASSWORD,
    });

    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as ErrorBody).error.code, 'EMAIL_TAKEN');
  });

  it('rejects a short password', async () => {
    const response = await post('/api/auth/register', {
      email: 'short@example.com',
      password: 'tooshort',
    });

    assert.equal(response.status, 400);
  });

  it('rejects a password long enough to be a denial of service', async () => {
    // Hashing unbounded input is CPU amplification against a single-threaded
    // service: one request could occupy the event loop indefinitely.
    const response = await post('/api/auth/register', {
      email: 'long@example.com',
      password: 'x'.repeat(10_000),
    });

    assert.equal(response.status, 400);
  });

  it('rejects a malformed email', async () => {
    for (const email of ['not-an-email', 'missing@domain', '@example.com', 'two@@example.com']) {
      const response = await post('/api/auth/register', { email, password: PASSWORD });
      assert.equal(response.status, 400, `expected 400 for ${email}`);
    }
  });

  it('requires a JSON content type', async () => {
    const response = await server.fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ email: 'form@example.com', password: PASSWORD }),
    });

    assert.equal(response.status, 415);
  });

  it('accepts a content type carrying a charset parameter', async () => {
    // `application/json; charset=utf-8` is legitimate and would fail a naive
    // string equality check.
    const response = await server.fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ email: 'charset@example.com', password: PASSWORD }),
    });

    assert.equal(response.status, 201);
  });
});

describe('POST /api/auth/login', () => {
  it('signs in with correct credentials', async () => {
    await post('/api/auth/register', { email: 'in@example.com', password: PASSWORD });

    const response = await post('/api/auth/login', {
      email: 'in@example.com',
      password: PASSWORD,
    });

    assert.equal(response.status, 200);
    assert.ok(response.headers.getSetCookie().length > 0);
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    // Distinguishing them tells an attacker which addresses have accounts.
    await post('/api/auth/register', { email: 'known@example.com', password: PASSWORD });

    const wrongPassword = await post('/api/auth/login', {
      email: 'known@example.com',
      password: 'a completely different passphrase',
    });
    const unknownEmail = await post('/api/auth/login', {
      email: 'nobody@example.com',
      password: PASSWORD,
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);

    const first = (await wrongPassword.json()) as ErrorBody;
    const second = (await unknownEmail.json()) as ErrorBody;
    assert.deepEqual(first, second);
  });

  it('answers 401, not 400, for a malformed body', async () => {
    // A validation error here would confirm the address exists, or reveal the
    // password policy to someone guessing.
    const response = await post('/api/auth/login', { email: 'x', password: '' });
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as ErrorBody).error.code, 'INVALID_CREDENTIALS');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the signed-in user', async () => {
    const account = await registerAccount(server);

    const response = await server.fetch('/api/auth/me', {
      headers: { cookie: account.cookie },
    });

    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { email: string }).email, account.email);
  });

  it('returns 401 without a cookie', async () => {
    assert.equal((await server.fetch('/api/auth/me')).status, 401);
  });

  it('returns 401 for an invented session id', async () => {
    const response = await server.fetch('/api/auth/me', {
      headers: { cookie: 'session=aW52ZW50ZWQtc2Vzc2lvbi1pZA' },
    });

    assert.equal(response.status, 401);
  });

  it('returns 401 for a tampered session id', async () => {
    const account = await registerAccount(server);
    const tampered = `${account.cookie.slice(0, -4)}AAAA`;

    const response = await server.fetch('/api/auth/me', { headers: { cookie: tampered } });
    assert.equal(response.status, 401);
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the session, so the old cookie stops working', async () => {
    const account = await registerAccount(server);

    const loggedOut = await server.fetch('/api/auth/logout', {
      method: 'POST',
      headers: { cookie: account.cookie },
    });

    assert.equal(loggedOut.status, 204);

    // The row is gone, so the captured cookie is dead immediately. This is the
    // concrete benefit of an opaque session id over a signed token, which would
    // stay valid until it expired no matter what the server wanted.
    const after = await server.fetch('/api/auth/me', { headers: { cookie: account.cookie } });
    assert.equal(after.status, 401);
  });

  it('clears the cookie with attributes matching the ones it was set with', async () => {
    const account = await registerAccount(server);

    const response = await server.fetch('/api/auth/logout', {
      method: 'POST',
      headers: { cookie: account.cookie },
    });

    const cleared = response.headers.getSetCookie()[0] ?? '';

    // A deletion cookie whose Path differs matches nothing, and the endpoint
    // still reports success: a silent authentication failure.
    assert.match(cleared, /Path=\//);
    assert.match(cleared, /Max-Age=0/);
  });

  it('succeeds even with no session at all', async () => {
    const response = await server.fetch('/api/auth/logout', { method: 'POST' });
    assert.equal(response.status, 204);
  });
});
