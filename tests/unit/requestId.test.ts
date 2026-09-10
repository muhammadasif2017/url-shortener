import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveRequestId } from '../../src/lib/requestId.ts';

/**
 * The correlation id resolver.
 *
 * Two properties matter and neither is about the happy path. An id reaches a
 * response header and a log line, so a value that could break either must never
 * survive; and a broken upstream must never be able to stop the service by
 * sending one.
 */

/** Matches the id minted when the inbound value is unusable. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('adopts a safe inbound id so a trace crosses the proxy boundary', () => {
    assert.equal(resolveRequestId('abc-123_XYZ.~'), 'abc-123_XYZ.~');
  });

  it('trims surrounding whitespace before deciding', () => {
    assert.equal(resolveRequestId('  abc123  '), 'abc123');
  });

  it('mints one when the header is absent', () => {
    assert.match(resolveRequestId(undefined), UUID);
  });

  it('mints one when the header is empty', () => {
    assert.match(resolveRequestId('   '), UUID);
  });

  it('mints one when the header repeats, rather than guessing which to believe', () => {
    assert.match(resolveRequestId(['one', 'two']), UUID);
  });

  it('replaces a value carrying CR or LF, which would split the response header', () => {
    assert.match(resolveRequestId('abc\r\nX-Admin: true'), UUID);
  });

  it('replaces a value with characters outside the unreserved set', () => {
    for (const candidate of ['a b', 'a/b', 'a"b', '<script>', 'a;b']) {
      assert.match(resolveRequestId(candidate), UUID, `accepted ${candidate}`);
    }
  });

  it('replaces an oversized value rather than logging it', () => {
    assert.match(resolveRequestId('a'.repeat(129)), UUID);
  });

  it('accepts a value at exactly the length limit', () => {
    const atLimit = 'a'.repeat(128);
    assert.equal(resolveRequestId(atLimit), atLimit);
  });

  it('never returns the same id twice when minting', () => {
    const ids = new Set(Array.from({ length: 100 }, () => resolveRequestId(undefined)));
    assert.equal(ids.size, 100);
  });
});
