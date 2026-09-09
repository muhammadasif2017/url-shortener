import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getDummyHash, hashPassword, verifyPassword } from '../../src/lib/password.ts';

/**
 * These tests are slower than the rest of the suite, and unavoidably so: each
 * hash is deliberately expensive. That cost is the point of the algorithm.
 */

describe('hashPassword', () => {
  it('produces a verifiable hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('Correct horse battery staple', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  it('produces a different hash every time, because the salt is random', async () => {
    // Without a per-user salt, identical passwords produce identical hashes, and
    // one leaked table immediately reveals which accounts share a password.
    const first = await hashPassword('same password');
    const second = await hashPassword('same password');

    assert.notEqual(first, second);
    assert.equal(await verifyPassword('same password', first), true);
    assert.equal(await verifyPassword('same password', second), true);
  });

  it('stores its parameters alongside the hash', async () => {
    // Without them, the cost can never be raised: an old hash would become
    // unverifiable the moment the parameters changed.
    const hash = await hashPassword('a password of sufficient length');
    assert.match(hash, /^scrypt\$N=\d+,r=\d+,p=\d+\$[\w-]+\$[\w-]+$/);
  });

  it('does not exceed the default scrypt memory ceiling', async () => {
    // N=32768,r=8 needs about 33 MiB against Node's 32 MiB default, which throws
    // ERR_CRYPTO_INVALID_SCRYPT_PARAMS unless maxmem is raised alongside it.
    await assert.doesNotReject(() => hashPassword('memory ceiling check'));
  });

  it('handles a very long password without failing', async () => {
    const long = 'x'.repeat(128);
    const hash = await hashPassword(long);
    assert.equal(await verifyPassword(long, hash), true);
  });

  it('handles non-ASCII passwords', async () => {
    const hash = await hashPassword('пароль-🙂-密码');
    assert.equal(await verifyPassword('пароль-🙂-密码', hash), true);
  });
});

describe('verifyPassword with a malformed stored hash', () => {
  it('returns false rather than throwing', async () => {
    // A corrupted row should fail the sign-in, not produce a 500 that tells the
    // caller something unusual happened to that particular account.
    for (const broken of [
      '',
      'not-a-hash',
      'scrypt$N=32768,r=8,p=1$onlythreeparts',
      'argon2$N=32768,r=8,p=1$c2FsdA$aGFzaA',
      'scrypt$garbage$c2FsdA$aGFzaA',
      'scrypt$N=32768,r=8,p=1$$',
    ]) {
      assert.equal(await verifyPassword('anything', broken), false);
    }
  });

  it('rejects absurd parameters instead of trying to honour them', async () => {
    // A poisoned row claiming a huge cost would otherwise turn one sign-in
    // attempt into a denial of service.
    const poisoned = 'scrypt$N=1048576,r=64,p=16$c2FsdA$aGFzaA';
    assert.equal(await verifyPassword('anything', poisoned), false);
  });

  it('rejects an empty salt and digest, which would authenticate anything', async () => {
    // timingSafeEqual on two zero-length buffers returns true. Without an
    // explicit length check, a row storing `scrypt$N=...$$` would accept every
    // password for that account.
    assert.equal(await verifyPassword('any password at all', 'scrypt$N=32768,r=8,p=1$$'), false);
    assert.equal(await verifyPassword('', 'scrypt$N=32768,r=8,p=1$$'), false);
  });

  it('returns false on a length mismatch rather than throwing', async () => {
    // timingSafeEqual throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH when the two
    // buffers differ in length, so lengths must be compared first.
    const truncated = 'scrypt$N=32768,r=8,p=1$c2FsdA$YQ';
    assert.equal(await verifyPassword('anything', truncated), false);
  });
});

describe('getDummyHash', () => {
  it('returns a hash no password matches', async () => {
    const dummy = await getDummyHash();
    assert.equal(await verifyPassword('', dummy), false);
    assert.equal(await verifyPassword('guess', dummy), false);
  });

  it('is built once and reused', async () => {
    // Rebuilding it per request would cost a full hash on every failed sign-in,
    // which is the opposite of what it is for.
    assert.equal(await getDummyHash(), await getDummyHash());
  });
});
