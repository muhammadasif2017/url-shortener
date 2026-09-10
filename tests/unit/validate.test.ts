import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isRecord,
  MAX_URL_LENGTH,
  parseBoundedInteger,
  parseCustomSlug,
  parseDestinationUrl,
  parseFutureInstant,
  type ParseResult,
} from '../../src/lib/validate.ts';
import { parseCreateLinkInput } from '../../src/modules/links/links.schema.ts';

const BASE_URL = 'http://localhost:3000';
const NOW = new Date('2026-09-09T10:00:00.000Z');

/**
 * Asserts a parse succeeded and returns the value, so tests read as assertions
 * rather than as nested conditionals.
 */
function expectOk<T>(result: ParseResult<T>): T {
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return result.value;
}

/** Asserts a parse failed on the given field, and returns the message. */
function expectIssue<T>(result: ParseResult<T>, field: string): string {
  assert.ok(!result.ok, 'expected failure, got success');
  const found = result.issues.find((candidate) => candidate.field === field);
  assert.ok(found, `expected an issue on "${field}", got ${JSON.stringify(result.issues)}`);
  return found.message;
}

describe('isRecord', () => {
  it('accepts plain objects', () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord({ a: 1 }), true);
  });

  it('rejects null and arrays, which are both typeof object', () => {
    assert.equal(isRecord(null), false);
    assert.equal(isRecord([]), false);
    assert.equal(isRecord([{ a: 1 }]), false);
  });

  it('rejects primitives', () => {
    assert.equal(isRecord('x'), false);
    assert.equal(isRecord(1), false);
    assert.equal(isRecord(undefined), false);
  });
});

describe('parseDestinationUrl', () => {
  const options = { field: 'url', baseUrl: BASE_URL };

  it('accepts http and https', () => {
    assert.equal(
      expectOk(parseDestinationUrl('http://example.com', options)),
      'http://example.com/',
    );
    assert.equal(
      expectOk(parseDestinationUrl('https://example.com/a/b?c=d#e', options)),
      'https://example.com/a/b?c=d#e',
    );
  });

  it('rejects every scheme outside the allowlist', () => {
    for (const dangerous of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://example.com',
      'mailto:someone@example.com',
    ]) {
      expectIssue(parseDestinationUrl(dangerous, options), 'url');
    }
  });

  it('returns the parser serialization, not the caller string', () => {
    // The parser strips tab, carriage return and newline while parsing, so this
    // value validates. Returning the caller's string would persist the control
    // characters, and they would later be written into a Location header.
    const smuggled = 'https://example.com/a\r\nX-Injected:\tyes';
    const result = expectOk(parseDestinationUrl(smuggled, options));

    assert.equal(result, 'https://example.com/aX-Injected:yes');
    assert.ok(!/[\r\n\t]/.test(result), `control characters survived: ${JSON.stringify(result)}`);
  });

  it('rejects a URL that only exceeds the length limit once normalized', () => {
    // A raw space is one character in, three out, so a value under the cap on
    // the way in can be over it in the form that reaches the column. The
    // trailing character matters: the parser trims whitespace at either end of
    // the input, so the spaces have to sit inside the path.
    const spaced = `https://example.com/${' '.repeat(1000)}x`;

    assert.ok(spaced.length <= MAX_URL_LENGTH, 'input should be under the cap');
    expectIssue(parseDestinationUrl(spaced, options), 'url');
  });

  it('rejects a relative URL, which has no host', () => {
    expectIssue(parseDestinationUrl('/just/a/path', options), 'url');
  });

  it('rejects a missing, empty, or non-string value', () => {
    expectIssue(parseDestinationUrl(undefined, options), 'url');
    expectIssue(parseDestinationUrl('', options), 'url');
    expectIssue(parseDestinationUrl('   ', options), 'url');
    expectIssue(parseDestinationUrl(42, options), 'url');
  });

  it('rejects a URL longer than the column allows', () => {
    const tooLong = `https://example.com/${'a'.repeat(2100)}`;
    expectIssue(parseDestinationUrl(tooLong, options), 'url');
  });

  it('rejects a destination on this service, which would chain or loop', () => {
    expectIssue(parseDestinationUrl('http://localhost:3000/abc', options), 'url');
    // Different port and scheme, same host: still a chain.
    expectIssue(parseDestinationUrl('https://localhost:9999/abc', options), 'url');
  });

  it('ignores a malformed baseUrl rather than blocking every link', () => {
    const broken = { field: 'url', baseUrl: 'not a url' };
    assert.equal(
      expectOk(parseDestinationUrl('https://example.com', broken)),
      'https://example.com/',
    );
  });
});

describe('parseCustomSlug', () => {
  it('accepts the documented character set', () => {
    assert.equal(expectOk(parseCustomSlug('my-link', 'customSlug')), 'my-link');
    assert.equal(expectOk(parseCustomSlug('My_Link_9', 'customSlug')), 'My_Link_9');
  });

  it('rejects characters the column constraint would reject', () => {
    for (const bad of ['has space', 'dot.ted', 'sl/ash', 'emoji🙂', 'semi;colon']) {
      expectIssue(parseCustomSlug(bad, 'customSlug'), 'customSlug');
    }
  });

  it('enforces the length bounds', () => {
    expectIssue(parseCustomSlug('ab', 'customSlug'), 'customSlug');
    assert.equal(expectOk(parseCustomSlug('abc', 'customSlug')), 'abc');
    assert.equal(expectOk(parseCustomSlug('a'.repeat(32), 'customSlug')), 'a'.repeat(32));
    expectIssue(parseCustomSlug('a'.repeat(33), 'customSlug'), 'customSlug');
  });

  it('rejects a non-string', () => {
    expectIssue(parseCustomSlug(123, 'customSlug'), 'customSlug');
  });
});

describe('parseFutureInstant', () => {
  it('accepts a future ISO 8601 instant', () => {
    const value = expectOk(parseFutureInstant('2026-12-31T23:59:59.000Z', 'expiresAt', NOW));
    assert.equal(value.toISOString(), '2026-12-31T23:59:59.000Z');
  });

  it('rejects an instant in the past', () => {
    expectIssue(parseFutureInstant('2020-01-01T00:00:00.000Z', 'expiresAt', NOW), 'expiresAt');
  });

  it('rejects the present instant, since it is already expired', () => {
    expectIssue(parseFutureInstant(NOW.toISOString(), 'expiresAt', NOW), 'expiresAt');
  });

  it('rejects a malformed date', () => {
    expectIssue(parseFutureInstant('not-a-date', 'expiresAt', NOW), 'expiresAt');
    expectIssue(parseFutureInstant('2026-13-45T99:99:99Z', 'expiresAt', NOW), 'expiresAt');
  });

  it('rejects a non-string', () => {
    expectIssue(parseFutureInstant(1767225599000, 'expiresAt', NOW), 'expiresAt');
  });
});

describe('parseBoundedInteger', () => {
  const options = { min: 1, max: 100, fallback: 20 };

  it('falls back when the parameter is absent', () => {
    assert.equal(expectOk(parseBoundedInteger(undefined, 'limit', options)), 20);
  });

  it('accepts values inside the range', () => {
    assert.equal(expectOk(parseBoundedInteger('1', 'limit', options)), 1);
    assert.equal(expectOk(parseBoundedInteger('100', 'limit', options)), 100);
  });

  it('rejects values outside the range', () => {
    expectIssue(parseBoundedInteger('0', 'limit', options), 'limit');
    expectIssue(parseBoundedInteger('101', 'limit', options), 'limit');
  });

  it('rejects what a naive Number() conversion would silently accept', () => {
    // Number('') is 0, Number(' 5 ') is 5, Number('1e2') is 100.
    expectIssue(parseBoundedInteger('', 'limit', options), 'limit');
    expectIssue(parseBoundedInteger(' 5 ', 'limit', options), 'limit');
    expectIssue(parseBoundedInteger('1e2', 'limit', options), 'limit');
    expectIssue(parseBoundedInteger('-5', 'limit', options), 'limit');
    expectIssue(parseBoundedInteger('2.5', 'limit', options), 'limit');
  });
});

describe('parseCreateLinkInput', () => {
  const options = { baseUrl: BASE_URL, now: NOW };

  it('accepts a minimal body', () => {
    const input = expectOk(parseCreateLinkInput({ url: 'https://example.com' }, options));
    assert.equal(input.url, 'https://example.com/');
    assert.equal(input.customSlug, undefined);
    assert.equal(input.expiresAt, undefined);
  });

  it('accepts a full body', () => {
    const input = expectOk(
      parseCreateLinkInput(
        {
          url: 'https://example.com',
          customSlug: 'my-link',
          expiresAt: '2026-12-31T23:59:59.000Z',
        },
        options,
      ),
    );
    assert.equal(input.customSlug, 'my-link');
    assert.equal(input.expiresAt?.toISOString(), '2026-12-31T23:59:59.000Z');
  });

  it('treats null the same as absent for optional fields', () => {
    const input = expectOk(
      parseCreateLinkInput(
        { url: 'https://example.com', customSlug: null, expiresAt: null },
        options,
      ),
    );
    assert.equal(input.customSlug, undefined);
    assert.equal(input.expiresAt, undefined);
  });

  it('rejects a body that is not a JSON object', () => {
    expectIssue(parseCreateLinkInput(null, options), 'body');
    expectIssue(parseCreateLinkInput([], options), 'body');
    expectIssue(parseCreateLinkInput('url=x', options), 'body');
  });

  it('reports every bad field at once, not just the first', () => {
    const result = parseCreateLinkInput(
      { url: 'javascript:alert(1)', customSlug: 'no spaces', expiresAt: '2020-01-01T00:00:00Z' },
      options,
    );

    assert.ok(!result.ok);
    assert.equal(result.issues.length, 3);
    for (const field of ['url', 'customSlug', 'expiresAt']) {
      expectIssue(result, field);
    }
  });

  it('never reflects the offending value back in the message', () => {
    const result = parseCreateLinkInput({ url: 'javascript:alert(1)' }, options);
    const message = expectIssue(result, 'url');
    assert.ok(!message.includes('javascript'), 'message must not echo user input');
  });
});
