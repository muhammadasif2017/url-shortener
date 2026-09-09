import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashClientIp, saltFingerprint } from '../../src/lib/ipHash.ts';
import {
  createWriteTracker,
  isBotUserAgent,
  toClickEvent,
} from '../../src/modules/analytics/analytics.service.ts';

/**
 * Analytics logic that needs neither a database nor a server.
 *
 * The write tracker is tested here rather than through HTTP because its two
 * mandatory properties are about timing, and timing is exactly what an
 * end-to-end test cannot pin down.
 */

/** A salt of the length the environment validator requires. */
const SALT = 'a'.repeat(64);

describe('hashClientIp', () => {
  it('produces 64 lowercase hex characters', () => {
    assert.match(hashClientIp('203.0.113.5', SALT), /^[0-9a-f]{64}$/);
  });

  it('is stable for the same address and salt', () => {
    assert.equal(hashClientIp('203.0.113.5', SALT), hashClientIp('203.0.113.5', SALT));
  });

  it('separates two addresses', () => {
    assert.notEqual(hashClientIp('203.0.113.5', SALT), hashClientIp('203.0.113.6', SALT));
  });

  it('changes when the salt changes, which is why rotation resets counts', () => {
    assert.notEqual(hashClientIp('203.0.113.5', SALT), hashClientIp('203.0.113.5', 'b'.repeat(64)));
  });

  it('hashes the unknown-address literal like any other value', () => {
    assert.match(hashClientIp('unknown', SALT), /^[0-9a-f]{64}$/);
  });
});

describe('saltFingerprint', () => {
  it('is eight hex characters', () => {
    assert.match(saltFingerprint(SALT), /^[0-9a-f]{8}$/);
  });

  it('changes when the salt changes, so a rotation is visible in the logs', () => {
    assert.notEqual(saltFingerprint(SALT), saltFingerprint('b'.repeat(64)));
  });

  it('does not reveal the salt', () => {
    assert.ok(!SALT.includes(saltFingerprint(SALT)));
  });
});

describe('isBotUserAgent', () => {
  for (const marker of ['bot', 'crawler', 'spider', 'preview', 'curl', 'wget', 'headless']) {
    it(`matches ${marker}`, () => {
      assert.equal(isBotUserAgent(`something-${marker}-1.0`), true);
    });
  }

  it('matches case-insensitively', () => {
    assert.equal(isBotUserAgent('Googlebot/2.1'), true);
  });

  it('does not match an ordinary browser', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
    assert.equal(isBotUserAgent(chrome), false);
  });

  it('treats a missing user agent as not a bot', () => {
    // Absence is not evidence of automation, and guessing here would delete
    // real traffic from every reported figure.
    assert.equal(isBotUserAgent(undefined), false);
  });
});

describe('toClickEvent', () => {
  const base = { linkId: '1', clientIp: '203.0.113.5' };

  it('stores absent headers as null rather than empty strings', () => {
    const event = toClickEvent({ ...base, referrer: undefined, userAgent: undefined }, SALT);

    assert.equal(event.referrer, null);
    assert.equal(event.userAgent, null);
  });

  it('truncates a referrer to the column length', () => {
    const event = toClickEvent(
      { ...base, referrer: `https://example.com/${'x'.repeat(3000)}`, userAgent: undefined },
      SALT,
    );

    // The constraint would have rejected the row, and the insert is not awaited,
    // so the click would have vanished with nothing to report.
    assert.equal(event.referrer?.length, 2048);
  });

  it('truncates a user agent to the column length', () => {
    const event = toClickEvent({ ...base, referrer: undefined, userAgent: 'u'.repeat(900) }, SALT);

    assert.equal(event.userAgent?.length, 512);
  });

  it('takes the first value of a repeated header', () => {
    const event = toClickEvent(
      { ...base, referrer: ['https://first.example', 'https://second.example'], userAgent: undefined },
      SALT,
    );

    assert.equal(event.referrer, 'https://first.example');
  });

  it('flags automation and keeps the row', () => {
    const event = toClickEvent({ ...base, referrer: undefined, userAgent: 'curl/8.0' }, SALT);

    assert.equal(event.isBot, true);
    assert.equal(event.userAgent, 'curl/8.0');
  });
});

describe('createWriteTracker', () => {
  it('resolves when a tracked write rejects, instead of rejecting with it', async () => {
    const tracker = createWriteTracker();

    // The promise stored must be one that already has a catch attached.
    // Registering the raw promise would make a single failed insert fail the
    // whole shutdown drain.
    tracker.track(Promise.reject(new Error('insert failed')));

    await tracker.drain();
    assert.equal(tracker.size(), 0);
  });

  it('waits for a write registered while the drain is already running', async () => {
    const tracker = createWriteTracker();
    let secondFinished = false;

    let releaseFirst: () => void = () => undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    tracker.track(first);

    const drained = tracker.drain();

    // Added after the drain started, which a single pass over a snapshot of the
    // set would miss entirely.
    tracker.track(
      first.then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        secondFinished = true;
      }),
    );

    releaseFirst();
    await drained;

    assert.equal(secondFinished, true);
    assert.equal(tracker.size(), 0);
  });

  it('reports nothing outstanding once writes settle', async () => {
    const tracker = createWriteTracker();

    tracker.track(Promise.resolve());
    assert.equal(tracker.size(), 1);

    await tracker.drain();
    assert.equal(tracker.size(), 0);
  });
});
