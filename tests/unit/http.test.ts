import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clearCookie, parseCookies, serialiseCookie } from '../../src/http/cookies.ts';
import {
  methodNotAllowedResponse,
  notFoundResponse,
  toErrorResponse,
  type ErrorBody,
} from '../../src/http/errorHandler.ts';
import { json, noContent, redirect } from '../../src/http/respond.ts';
import { AppError } from '../../src/lib/AppError.ts';

const CONTEXT = { method: 'GET', path: '/test' };

/** Narrows a response body to the error shape, failing the test if it is not. */
function errorBody(body: unknown): ErrorBody['error'] {
  assert.ok(typeof body === 'object' && body !== null && 'error' in body);
  return (body as ErrorBody).error;
}

describe('parseCookies', () => {
  it('parses a single cookie', () => {
    assert.deepEqual(parseCookies('session=abc123'), { session: 'abc123' });
  });

  it('parses several cookies from one header', () => {
    assert.deepEqual(parseCookies('a=1; b=2; c=3'), { a: '1', b: '2', c: '3' });
  });

  it('keeps a value containing "=", such as base64 padding', () => {
    // Splitting on every "=" instead of the first would truncate this to "dg",
    // and the session would silently fail to authenticate.
    assert.deepEqual(parseCookies('session=dGVzdA=='), { session: 'dGVzdA==' });
  });

  it('keeps a JWT-shaped value intact', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_123';
    assert.deepEqual(parseCookies(`session=${token}`), { session: token });
  });

  it('tolerates whitespace around names and values', () => {
    assert.deepEqual(parseCookies('  a = 1 ;b=2  '), { a: '1', b: '2' });
  });

  it('keeps the first occurrence of a repeated name', () => {
    // A later duplicate must not be able to override the real session.
    assert.deepEqual(parseCookies('session=real; session=injected'), { session: 'real' });
  });

  it('returns an empty object for a missing or empty header', () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies(''), {});
    assert.deepEqual(parseCookies('   '), {});
  });

  it('skips malformed pairs rather than throwing', () => {
    assert.deepEqual(parseCookies('novalue; =noname; a=1'), { a: '1' });
  });

  it('decodes percent-encoded values', () => {
    assert.deepEqual(parseCookies('a=hello%20world'), { a: 'hello world' });
  });

  it('returns a malformed encoding unchanged instead of failing', () => {
    assert.deepEqual(parseCookies('a=%E0%A4%A'), { a: '%E0%A4%A' });
  });

  it('strips surrounding quotes', () => {
    assert.deepEqual(parseCookies('a="quoted value"'), { a: 'quoted value' });
  });

  it('joins a repeated Cookie header', () => {
    assert.deepEqual(parseCookies(['a=1', 'b=2']), { a: '1', b: '2' });
  });
});

describe('serialiseCookie', () => {
  it('writes every attribute in a usable order', () => {
    const header = serialiseCookie('__Host-session', 'abc', {
      path: '/',
      maxAge: 604_800,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });

    assert.equal(
      header,
      '__Host-session=abc; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('omits attributes that were not requested', () => {
    assert.equal(serialiseCookie('a', 'b'), 'a=b');
  });

  it('percent-encodes the value, which also blocks attribute injection', () => {
    // Without encoding, a value containing "; Path=/" would invent its own
    // attributes on the Set-Cookie line.
    const header = serialiseCookie('a', 'x; Path=/admin');
    assert.ok(!header.includes('Path=/admin'));
    assert.equal(parseCookies(header.split(';')[0])['a'], 'x; Path=/admin');
  });

  it('rejects an invalid cookie name', () => {
    assert.throws(() => serialiseCookie('bad name', 'x'), /Invalid cookie name/);
    assert.throws(() => serialiseCookie('bad;name', 'x'), /Invalid cookie name/);
    assert.throws(() => serialiseCookie('', 'x'), /Invalid cookie name/);
  });

  it('floors a fractional Max-Age', () => {
    assert.ok(serialiseCookie('a', 'b', { maxAge: 1.9 }).includes('Max-Age=1'));
  });
});

describe('clearCookie', () => {
  it('expires the cookie immediately', () => {
    assert.ok(clearCookie('session').includes('Max-Age=0'));
  });

  it('repeats the scoping attributes, without which deletion silently fails', () => {
    const header = clearCookie('__Host-session', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });

    assert.ok(header.includes('Path=/'));
    assert.ok(header.includes('Max-Age=0'));
    assert.ok(header.startsWith('__Host-session='));
  });
});

describe('response builders', () => {
  it('builds a JSON response', () => {
    const response = json(201, { slug: 'abc' });
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { slug: 'abc' });
  });

  it('builds a redirect that browsers must not cache', () => {
    const response = redirect(302, 'https://example.com');
    assert.equal(response.status, 302);
    assert.equal(response.headers?.['Location'], 'https://example.com');

    // A cached redirect keeps working after the link is deleted, and hides
    // every later visit from the server.
    assert.equal(response.headers['Cache-Control'], 'no-store');
  });

  it('builds an empty 204', () => {
    const response = noContent();
    assert.equal(response.status, 204);
    assert.equal(response.body, undefined);
  });
});

describe('toErrorResponse', () => {
  it('uses the code, message, and status of an AppError', () => {
    const response = toErrorResponse(
      new AppError('SLUG_TAKEN', 'That slug is already in use.', 409),
      CONTEXT,
    );

    assert.equal(response.status, 409);
    const body = errorBody(response.body);
    assert.equal(body.code, 'SLUG_TAKEN');
    assert.equal(body.message, 'That slug is already in use.');
    assert.equal(body.details, undefined);
  });

  it('includes details on a validation failure', () => {
    const response = toErrorResponse(
      AppError.validation([{ field: 'url', message: 'Must be an http or https URL.' }]),
      CONTEXT,
    );

    assert.equal(response.status, 400);
    const body = errorBody(response.body);
    assert.equal(body.code, 'VALIDATION_FAILED');
    assert.deepEqual(body.details, [{ field: 'url', message: 'Must be an http or https URL.' }]);
  });

  it('carries headers a status requires, such as Retry-After', () => {
    const response = toErrorResponse(
      new AppError('RATE_LIMITED', 'Too many requests.', 429, {
        headers: { 'Retry-After': '30' },
      }),
      CONTEXT,
    );

    assert.equal(response.headers?.['Retry-After'], '30');
  });

  it('never leaks the message of an unexpected error', () => {
    const leaky = new Error('connection to postgres://user:hunter2@db failed');
    const response = toErrorResponse(leaky, CONTEXT);

    assert.equal(response.status, 500);
    const body = errorBody(response.body);
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(body.message, 'Something went wrong.');
    assert.ok(!JSON.stringify(response.body).includes('hunter2'));
  });

  it('handles a thrown value that is not an Error at all', () => {
    const response = toErrorResponse('just a string', CONTEXT);
    assert.equal(response.status, 500);
    assert.equal(errorBody(response.body).code, 'INTERNAL_ERROR');
  });
});

describe('router failure responses', () => {
  it('builds a 404 in the standard shape', () => {
    const response = notFoundResponse();
    assert.equal(response.status, 404);
    assert.equal(errorBody(response.body).code, 'NOT_FOUND');
  });

  it('builds a 405 carrying the Allow header the status requires', () => {
    const response = methodNotAllowedResponse(['GET', 'HEAD', 'POST']);
    assert.equal(response.status, 405);
    assert.equal(response.headers?.['Allow'], 'GET, HEAD, POST');
  });
});
