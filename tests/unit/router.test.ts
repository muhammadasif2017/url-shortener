import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Route, RouteTable } from '../../src/http/context.ts';
import { createRouter, type MatchResult } from '../../src/http/router.ts';

/** Builds a route whose handler is never called; these tests match only. */
function route(method: string, path: string): Route {
  return { method, path, handle: () => ({ status: 200 }) };
}

/**
 * The real shape of this service's table, with `/:slug` registered FIRST.
 *
 * The order is deliberate. If precedence depended on registration order, this
 * table would send `/health` to the redirect route, which is the exact bug
 * these tests exist to prevent.
 */
const TABLE: RouteTable = [
  route('GET', '/:slug'),
  route('GET', '/health'),
  route('POST', '/api/links'),
  route('GET', '/api/links'),
  route('GET', '/api/links/:slug'),
  route('DELETE', '/api/links/:slug'),
];

const router = createRouter(TABLE);

/** Asserts a match and returns it, so tests read as assertions. */
function expectMatch(result: MatchResult): Extract<MatchResult, { type: 'matched' }> {
  // `assert.ok` narrows the union where `assert.equal` does not, so the return
  // needs no cast and a wrong shape fails here rather than at the use site.
  assert.ok(result.type === 'matched', `expected a match, got ${result.type}`);
  return result;
}

describe('route precedence', () => {
  it('prefers a literal route over the catch-all, whatever the registration order', () => {
    const matched = expectMatch(router.match('GET', '/health'));
    assert.equal(matched.route.path, '/health');
  });

  it('never lets the catch-all match a two-segment path', () => {
    const matched = expectMatch(router.match('GET', '/api/links'));
    assert.equal(matched.route.path, '/api/links');
  });

  it('still serves the catch-all for a genuine slug', () => {
    const matched = expectMatch(router.match('GET', '/aB3xK9p'));
    assert.equal(matched.route.path, '/:slug');
    assert.equal(matched.params['slug'], 'aB3xK9p');
  });

  it('prefers a literal at the first differing segment', () => {
    const table: RouteTable = [route('GET', '/:a/:b'), route('GET', '/api/:b')];
    const matched = expectMatch(createRouter(table).match('GET', '/api/x'));
    assert.equal(matched.route.path, '/api/:b');
  });

  it('does not confuse a slug with a reserved word', () => {
    // The reserved list stops someone CREATING a link named "health".
    // It has nothing to do with routing, and routing must not rely on it.
    const matched = expectMatch(router.match('GET', '/healthy'));
    assert.equal(matched.route.path, '/:slug');
    assert.equal(matched.params['slug'], 'healthy');
  });
});

describe('segment counting', () => {
  it('requires an exact segment count', () => {
    assert.equal(router.match('GET', '/api/links/abc/extra').type, 'not-found');
    assert.equal(router.match('GET', '/a/b/c/d').type, 'not-found');
  });

  it('captures a parameter in a nested path', () => {
    const matched = expectMatch(router.match('GET', '/api/links/aB3xK9p'));
    assert.equal(matched.params['slug'], 'aB3xK9p');
  });

  it('treats a trailing slash as the same route', () => {
    assert.equal(expectMatch(router.match('GET', '/health/')).route.path, '/health');
    assert.equal(expectMatch(router.match('GET', '/api/links/')).route.path, '/api/links');
  });

  it('ignores the query string and fragment', () => {
    assert.equal(expectMatch(router.match('GET', '/health?verbose=1')).route.path, '/health');
    assert.equal(expectMatch(router.match('GET', '/health#frag')).route.path, '/health');
  });
});

describe('methods', () => {
  it('matches the method exactly', () => {
    assert.equal(expectMatch(router.match('POST', '/api/links')).route.method, 'POST');
    assert.equal(expectMatch(router.match('GET', '/api/links')).route.method, 'GET');
  });

  it('accepts a lowercase method', () => {
    assert.equal(expectMatch(router.match('get', '/health')).route.path, '/health');
  });

  it('serves HEAD from the GET route', () => {
    // Without this, every link checker, chat unfurler, and uptime monitor that
    // probes a short link with HEAD gets a 404.
    const matched = expectMatch(router.match('HEAD', '/aB3xK9p'));
    assert.equal(matched.route.method, 'GET');
    assert.equal(matched.route.path, '/:slug');
    assert.equal(matched.params['slug'], 'aB3xK9p');
  });

  it('serves HEAD for literal routes too', () => {
    assert.equal(expectMatch(router.match('HEAD', '/health')).route.path, '/health');
  });

  it('returns 405 with Allow when the path exists but the method does not', () => {
    const result = router.match('PUT', '/api/links');
    assert.ok(result.type === 'method-not-allowed');
    assert.deepEqual(result.allow, ['GET', 'HEAD', 'POST']);
  });

  it('lists HEAD in Allow whenever GET is allowed', () => {
    const result = router.match('PATCH', '/api/links/abc');
    assert.ok(result.type === 'method-not-allowed');
    assert.deepEqual(result.allow, ['DELETE', 'GET', 'HEAD']);
  });

  it('returns 404, not 405, when no route matches the path at all', () => {
    assert.equal(router.match('PUT', '/api/nothing/here/at/all').type, 'not-found');
  });
});

describe('table validation', () => {
  it('rejects two routes for the same method and path', () => {
    assert.throws(
      () => createRouter([route('GET', '/health'), route('GET', '/health')]),
      /Duplicate route registered: GET \/health/,
    );
  });

  it('rejects duplicates that differ only in parameter name', () => {
    // /api/links/:slug and /api/links/:id match exactly the same requests, so
    // the second handler would be silently unreachable.
    assert.throws(
      () => createRouter([route('GET', '/api/links/:slug'), route('GET', '/api/links/:id')]),
      /Duplicate route registered/,
    );
  });

  it('allows the same path under different methods', () => {
    assert.doesNotThrow(() =>
      createRouter([route('GET', '/api/links'), route('POST', '/api/links')]),
    );
  });
});

describe('root path', () => {
  it('matches a route registered at the root', () => {
    const rooted = createRouter([route('GET', '/'), route('GET', '/:slug')]);
    assert.equal(expectMatch(rooted.match('GET', '/')).route.path, '/');
  });

  it('does not let the catch-all swallow the root', () => {
    const rooted = createRouter([route('GET', '/:slug'), route('GET', '/')]);
    assert.equal(expectMatch(rooted.match('GET', '/')).route.path, '/');
  });

  it('returns 404 for the root when nothing is registered there', () => {
    // "/" has zero segments and "/:slug" has one, so they must not match.
    assert.equal(router.match('GET', '/').type, 'not-found');
  });
});
