import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { closePool } from '../../src/db/pool.ts';
import { analyticsRoutes } from '../../src/modules/analytics/analytics.routes.ts';
import { identityRoutes } from '../../src/modules/identity/identity.routes.ts';
import { linkRoutes } from '../../src/modules/links/links.routes.ts';
import { insertLink, resetDatabase } from '../helpers/db.ts';
import { registerAccount } from '../helpers/auth.ts';
import { startTestServer, type TestServer } from '../helpers/server.ts';

/**
 * Properties that are security-relevant and cheap to break by accident.
 *
 * Each test here exists because the protection it checks is either a single
 * header that a refactor could drop, or a guarantee that comes from a library's
 * behaviour rather than from code anyone would think to preserve.
 */

let server: TestServer;

before(async () => {
  server = await startTestServer([...linkRoutes, ...identityRoutes, ...analyticsRoutes]);
});

beforeEach(async () => {
  await resetDatabase();
});

after(async () => {
  await server.close();
  await closePool();
});

describe('response headers', () => {
  it('sends nosniff on a JSON response', async () => {
    const response = await server.fetch('/health');

    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  it('sends nosniff on a redirect, which carries no body to inspect', async () => {
    const link = await insertLink();

    const response = await server.fetch(`/${link.slug}`);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  it('sends nosniff on an error response', async () => {
    const response = await server.fetch('/nosuchslug');

    assert.equal(response.status, 404);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  it('does not let a route override it by accident', async () => {
    // The redirect route sets its own headers, so this proves the default is
    // merged in rather than replaced by whatever a handler returns.
    const link = await insertLink();
    const response = await server.fetch(`/${link.slug}`);

    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('response splitting', () => {
  it('cannot be injected through a destination URL', async () => {
    // The Location header is built from caller-supplied text, which is the
    // classic response-splitting shape. The protection is incidental: the
    // WHATWG URL parser strips CR and LF while parsing, so the stored value can
    // never contain them. Incidental protections are exactly the ones worth a
    // regression test, because nothing in this repository would remind a future
    // reader that the parser is what is holding the line.
    const account = await registerAccount(server);
    const created = await server.fetch('/api/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: account.cookie },
      body: JSON.stringify({ url: 'https://example.com/a\r\nX-Injected: yes' }),
    });

    assert.equal(created.status, 201);
    const { slug } = (await created.json()) as { readonly slug: string };

    const response = await server.fetch(`/${slug}`);
    const location = response.headers.get('location') ?? '';

    assert.equal(response.headers.get('x-injected'), null);
    assert.ok(!location.includes('\r'));
    assert.ok(!location.includes('\n'));
  });
});

describe('account enumeration', () => {
  it('gives one answer for an unknown address and a wrong password', async () => {
    await server.fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'real@example.com', password: 'a long enough passphrase' }),
    });

    const wrongPassword = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'real@example.com', password: 'a different passphrase' }),
    });
    const unknownAddress = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'absent@example.com', password: 'a long enough passphrase' }),
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownAddress.status, 401);
    assert.deepEqual(await wrongPassword.json(), await unknownAddress.json());
  });

  it('rejects a malformed login body with 401, not a validation error', async () => {
    // A 400 listing which field was wrong would confirm the address exists, or
    // reveal the password policy to someone guessing.
    const response = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'short' }),
    });

    assert.equal(response.status, 401);
  });
});

describe('link metadata exposure', () => {
  it('never returns the owner or the row id of a link', async () => {
    const owner = await registerAccount(server);
    const link = await insertLink({ ownerId: owner.userId });

    const response = await server.fetch(`/api/links/${link.slug}`, {
      headers: { cookie: owner.cookie },
    });
    const body = (await response.json()) as Record<string, unknown>;

    // The reader is the owner, so the owner id would tell them nothing they do
    // not know. It is absent anyway, because this shape is shared with the
    // create and list responses and a field nobody needs is a field that leaks
    // the first time one of those routes changes audience.
    assert.equal(response.status, 200);
    assert.ok(!('ownerId' in body));
    assert.ok(!('id' in body));
  });
});
