import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveClientIp, UNKNOWN_CLIENT_IP, type ClientIpSource } from '../../src/lib/clientIp.ts';

/**
 * Builds a request source, so each test states only what it cares about.
 *
 * Presence is checked with `in` rather than `??`, because a test that passes
 * `remoteAddress: undefined` is deliberately exercising a destroyed socket and
 * must not have the default substituted back in.
 */
function source(partial: Partial<ClientIpSource> = {}): ClientIpSource {
  return {
    forwardedFor: partial.forwardedFor,
    remoteAddress: 'remoteAddress' in partial ? partial.remoteAddress : '203.0.113.9',
  };
}

describe('resolveClientIp with no trusted proxies', () => {
  it('uses the socket address', () => {
    assert.equal(resolveClientIp(source({ remoteAddress: '198.51.100.7' }), 0), '198.51.100.7');
  });

  it('ignores X-Forwarded-For entirely', () => {
    const result = resolveClientIp(
      source({ forwardedFor: '1.2.3.4', remoteAddress: '198.51.100.7' }),
      0,
    );

    // With nothing trusted in front, the header is caller-supplied and must not
    // influence the answer at all.
    assert.equal(result, '198.51.100.7');
  });

  it('returns the unknown marker for a destroyed socket', () => {
    assert.equal(resolveClientIp(source({ remoteAddress: undefined }), 0), UNKNOWN_CLIENT_IP);
    assert.equal(resolveClientIp(source({ remoteAddress: '' }), 0), UNKNOWN_CLIENT_IP);
  });
});

describe('resolveClientIp behind trusted proxies', () => {
  it('takes the entry one from the right with one trusted proxy', () => {
    const result = resolveClientIp(source({ forwardedFor: '198.51.100.7' }), 1);
    assert.equal(result, '198.51.100.7');
  });

  it('ignores forged entries on the left', () => {
    // The caller claims to be 1.2.3.4. One trusted proxy appended the address it
    // actually saw, 198.51.100.7, on the right. Only that entry is believable.
    const result = resolveClientIp(source({ forwardedFor: '1.2.3.4, 198.51.100.7' }), 1);
    assert.equal(result, '198.51.100.7');
  });

  it('counts from the right with several trusted proxies', () => {
    const header = '1.2.3.4, 198.51.100.7, 10.0.0.1, 10.0.0.2';
    assert.equal(resolveClientIp(source({ forwardedFor: header }), 1), '10.0.0.2');
    assert.equal(resolveClientIp(source({ forwardedFor: header }), 2), '10.0.0.1');
    assert.equal(resolveClientIp(source({ forwardedFor: header }), 3), '198.51.100.7');
  });

  it('never lets a long forged header reach past the trusted entries', () => {
    // Twenty forged entries, one real one appended by the single trusted proxy.
    const forged = Array.from({ length: 20 }, (_, index) => `1.2.3.${index}`).join(', ');
    const result = resolveClientIp(source({ forwardedFor: `${forged}, 198.51.100.7` }), 1);
    assert.equal(result, '198.51.100.7');
  });

  it('falls back to the socket address when the header is missing or too short', () => {
    assert.equal(
      resolveClientIp(source({ forwardedFor: undefined, remoteAddress: '10.0.0.5' }), 1),
      '10.0.0.5',
    );
    assert.equal(
      resolveClientIp(source({ forwardedFor: '1.2.3.4', remoteAddress: '10.0.0.5' }), 2),
      '10.0.0.5',
    );
  });

  it('treats a repeated header the same as one comma-separated header', () => {
    const result = resolveClientIp(source({ forwardedFor: ['1.2.3.4', '198.51.100.7'] }), 1);
    assert.equal(result, '198.51.100.7');
  });

  it('ignores empty entries produced by sloppy proxies', () => {
    const result = resolveClientIp(source({ forwardedFor: '1.2.3.4, , 198.51.100.7, ' }), 1);
    assert.equal(result, '198.51.100.7');
  });
});

describe('address normalisation', () => {
  it('unwraps IPv4-mapped IPv6, so one client is one bucket', () => {
    const mapped = resolveClientIp(source({ remoteAddress: '::ffff:127.0.0.1' }), 0);
    const plain = resolveClientIp(source({ remoteAddress: '127.0.0.1' }), 0);
    assert.equal(mapped, '127.0.0.1');
    assert.equal(mapped, plain);
  });

  it('lowercases IPv6 so case alone cannot split a bucket', () => {
    const upper = resolveClientIp(source({ remoteAddress: '2001:DB8::1' }), 0);
    const lower = resolveClientIp(source({ remoteAddress: '2001:db8::1' }), 0);
    assert.equal(upper, '2001:db8::1');
    assert.equal(upper, lower);
  });

  it('strips a port from an IPv4 address', () => {
    assert.equal(resolveClientIp(source({ remoteAddress: '203.0.113.5:8080' }), 0), '203.0.113.5');
  });

  it('strips brackets and a port from an IPv6 address', () => {
    assert.equal(resolveClientIp(source({ remoteAddress: '[2001:db8::1]:443' }), 0), '2001:db8::1');
  });

  it('does not mangle a bare IPv6 address, which contains its own colons', () => {
    assert.equal(resolveClientIp(source({ remoteAddress: '2001:db8::1' }), 0), '2001:db8::1');
    assert.equal(resolveClientIp(source({ remoteAddress: '::1' }), 0), '::1');
  });
});
