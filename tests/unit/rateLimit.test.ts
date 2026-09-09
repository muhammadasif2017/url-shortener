import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRateLimiter } from '../../src/http/rateLimit.ts';

const START = 1_000_000;

describe('createRateLimiter', () => {
  it('allows requests up to the limit', () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 1000 });

    assert.equal(limiter.check('a', START).allowed, true);
    assert.equal(limiter.check('a', START).allowed, true);
    assert.equal(limiter.check('a', START).allowed, true);
  });

  it('refuses the request after the limit', () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 1000 });

    limiter.check('a', START);
    limiter.check('a', START);

    assert.equal(limiter.check('a', START).allowed, false);
  });

  it('counts each key separately', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });

    assert.equal(limiter.check('a', START).allowed, true);
    assert.equal(limiter.check('b', START).allowed, true);
    assert.equal(limiter.check('a', START).allowed, false);
  });

  it('starts a fresh window once the old one expires', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });

    assert.equal(limiter.check('a', START).allowed, true);
    assert.equal(limiter.check('a', START + 500).allowed, false);
    assert.equal(limiter.check('a', START + 1001).allowed, true);
  });

  it('reports how long until the window resets', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });

    limiter.check('a', START);
    const decision = limiter.check('a', START + 30_000);

    assert.equal(decision.allowed, false);
    assert.equal(decision.retryAfterSeconds, 30);
  });

  it('never reports a Retry-After below one second', () => {
    // Zero would tell a client to retry immediately, which is worse than
    // useless: it turns a refused request into a tight loop.
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });

    limiter.check('a', START);
    const decision = limiter.check('a', START + 999);

    assert.ok(decision.retryAfterSeconds >= 1);
  });

  it('reports the remaining allowance', () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 1000 });

    assert.equal(limiter.check('a', START).remaining, 2);
    assert.equal(limiter.check('a', START).remaining, 1);
    assert.equal(limiter.check('a', START).remaining, 0);
    assert.equal(limiter.check('a', START).remaining, 0);
  });
});

describe('eviction', () => {
  it('sweeps expired entries rather than growing without bound', () => {
    const limiter = createRateLimiter({ max: 10, windowMs: 1000 });

    for (let index = 0; index < 100; index += 1) {
      limiter.check(`key-${index}`, START);
    }
    assert.equal(limiter.size(), 100);

    // One request after every window has expired sweeps the rest.
    limiter.check('trigger', START + 2000);
    assert.equal(limiter.size(), 1);
  });

  it('enforces a hard cap, so rotating keys cannot exhaust memory', () => {
    // This is the failure the cap exists for: an attacker rotating addresses
    // fills the map faster than any window expires entries.
    const limiter = createRateLimiter({ max: 10, windowMs: 60_000, maxEntries: 50 });

    for (let index = 0; index < 500; index += 1) {
      limiter.check(`key-${index}`, START);
    }

    assert.ok(
      limiter.size() <= 50,
      `tracked ${limiter.size()} keys, expected the cap of 50 to hold`,
    );
  });

  it('evicts the oldest entry when the cap is reached', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, maxEntries: 2 });

    limiter.check('oldest', START);
    limiter.check('middle', START);
    limiter.check('newest', START);

    assert.equal(limiter.size(), 2);

    // "oldest" was dropped when "newest" arrived, so it gets a fresh window.
    // Being over-permissive is the correct failure direction here; running out
    // of memory is not.
    assert.equal(limiter.check('oldest', START).allowed, true);

    // "newest" was never evicted and is still over its limit. Asserting on
    // "middle" instead would be wrong: readmitting "oldest" evicted it in turn,
    // so it would look unlimited for a reason unrelated to the cap.
    assert.equal(limiter.check('newest', START).allowed, false);
  });
});
