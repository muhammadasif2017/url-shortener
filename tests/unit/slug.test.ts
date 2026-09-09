import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  generateSlug,
  isReservedSlug,
  SLUG_ALPHABET,
  SLUG_LENGTH,
} from '../../src/lib/slug.ts';

describe('generateSlug', () => {
  it('returns exactly SLUG_LENGTH characters', () => {
    for (let i = 0; i < 1000; i += 1) {
      assert.equal(generateSlug().length, SLUG_LENGTH);
    }
  });

  it('uses only the base62 alphabet', () => {
    const allowed = new Set(SLUG_ALPHABET);

    for (let i = 0; i < 1000; i += 1) {
      for (const character of generateSlug()) {
        assert.ok(
          allowed.has(character),
          `character ${JSON.stringify(character)} is outside the alphabet`,
        );
      }
    }
  });

  it('does not repeat itself over many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) seen.add(generateSlug());

    // 62^7 is about 3.5e12, so 5000 draws colliding even once would be
    // extraordinary. A collision here means the generator is not random.
    assert.equal(seen.size, 5000);
  });

  it('distributes characters uniformly, proving modulo bias was handled', () => {
    const counts = new Map<string, number>();
    for (const character of SLUG_ALPHABET) counts.set(character, 0);

    const draws = 20_000;
    for (let i = 0; i < draws; i += 1) {
      for (const character of generateSlug()) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }

    const total = draws * SLUG_LENGTH;
    const expected = total / SLUG_ALPHABET.length;
    const observed = [...counts.values()];

    // Naive `byte % 62` over the full byte range would make 8 of the 62
    // characters about 25% more frequent than the other 54. A 10% tolerance is
    // wide enough that random variation never trips it at this sample size, and
    // narrow enough that the 25% skew always would.
    for (const [character, count] of counts) {
      const drift = Math.abs(count - expected) / expected;
      assert.ok(
        drift < 0.1,
        `character ${character} appeared ${count} times, expected about ` +
          `${Math.round(expected)} (drift ${(drift * 100).toFixed(1)}%)`,
      );
    }

    // Every character must actually appear. A generator that silently skipped
    // part of the alphabet would still pass a loose drift check if the missing
    // characters were never counted.
    assert.equal(observed.length, SLUG_ALPHABET.length);
    assert.ok(Math.min(...observed) > 0);
  });
});

describe('isReservedSlug', () => {
  it('matches reserved words exactly', () => {
    assert.equal(isReservedSlug('api'), true);
    assert.equal(isReservedSlug('health'), true);
    assert.equal(isReservedSlug('_next'), true);
  });

  it('matches regardless of case', () => {
    assert.equal(isReservedSlug('API'), true);
    assert.equal(isReservedSlug('Health'), true);
    assert.equal(isReservedSlug('AdMiN'), true);
  });

  it('does not match ordinary slugs', () => {
    assert.equal(isReservedSlug('my-link'), false);
    assert.equal(isReservedSlug('aB3xK9p'), false);
    assert.equal(isReservedSlug('apix'), false);
    assert.equal(isReservedSlug(''), false);
  });

  it('does not reject a generated slug', () => {
    for (let i = 0; i < 500; i += 1) {
      assert.equal(isReservedSlug(generateSlug()), false);
    }
  });
});
