import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EnvError, loadEnv } from '../../src/config/env.ts';

const SALT = 'a'.repeat(64);

/** A complete, valid environment. Each test overrides only what it exercises. */
function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'development',
    PORT: '3000',
    BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5433/urlshortener',
    TRUST_PROXY_HOPS: '0',
    IP_HASH_SALT: SALT,
    ...overrides,
  };
}

/** Asserts loadEnv throws, and returns the collected issue messages. */
function expectIssues(source: Record<string, string | undefined>): readonly string[] {
  try {
    loadEnv(source);
  } catch (error) {
    assert.ok(error instanceof EnvError, `expected EnvError, got ${String(error)}`);
    return error.issues;
  }
  throw new assert.AssertionError({ message: 'expected loadEnv to throw' });
}

describe('loadEnv', () => {
  it('accepts a complete environment', () => {
    const env = loadEnv(validEnv());
    assert.equal(env.nodeEnv, 'development');
    assert.equal(env.port, 3000);
    assert.equal(env.baseUrl, 'http://localhost:3000');
    assert.equal(env.trustProxyHops, 0);
    assert.equal(env.isProduction, false);
  });

  it('applies documented defaults for optional variables', () => {
    const env = loadEnv(validEnv());
    assert.equal(env.rateLimitMax, 60);
    assert.equal(env.rateLimitWindowMs, 60_000);
    assert.equal(env.sessionTtlSeconds, 604_800);
  });

  it('strips a trailing slash from BASE_URL', () => {
    // Left in place, every generated shortUrl would contain a double slash.
    assert.equal(loadEnv(validEnv({ BASE_URL: 'https://x.example/' })).baseUrl, 'https://x.example');
    assert.equal(loadEnv(validEnv({ BASE_URL: 'https://x.example//' })).baseUrl, 'https://x.example');
  });

  it('reports every problem at once, not just the first', () => {
    const issues = expectIssues({ NODE_ENV: 'staging' });

    // NODE_ENV, PORT, BASE_URL, DATABASE_URL, IP_HASH_SALT, TRUST_PROXY_HOPS.
    assert.equal(issues.length, 6);
  });

  it('requires each variable that has no safe default', () => {
    for (const key of ['PORT', 'BASE_URL', 'DATABASE_URL', 'IP_HASH_SALT', 'TRUST_PROXY_HOPS']) {
      const issues = expectIssues(validEnv({ [key]: undefined }));
      assert.ok(
        issues.some((message) => message.startsWith(key)),
        `expected an issue naming ${key}, got ${JSON.stringify(issues)}`,
      );
    }
  });

  it('rejects a PORT outside the valid range or shaped like a number', () => {
    for (const port of ['0', '65536', 'abc', '3000.5', '-1', '']) {
      const issues = expectIssues(validEnv({ PORT: port }));
      assert.ok(issues.some((message) => message.startsWith('PORT')));
    }
  });

  it('rejects an unknown NODE_ENV', () => {
    const issues = expectIssues(validEnv({ NODE_ENV: 'staging' }));
    assert.ok(issues.some((message) => message.startsWith('NODE_ENV')));
  });

  it('rejects a BASE_URL that is not an absolute http or https URL', () => {
    for (const base of ['localhost:3000', 'ftp://x.example', 'not a url']) {
      const issues = expectIssues(validEnv({ BASE_URL: base }));
      assert.ok(issues.some((message) => message.startsWith('BASE_URL')));
    }
  });

  it('defaults database TLS to on in production and off elsewhere', () => {
    assert.equal(loadEnv(validEnv()).databaseSsl, false);
    assert.equal(
      loadEnv(validEnv({ NODE_ENV: 'production', BASE_URL: 'https://x.example' })).databaseSsl,
      true,
    );
  });

  it('allows database TLS to be set independently of NODE_ENV', () => {
    // Tying TLS to the environment name made the production image impossible to
    // run against a local database: it demanded TLS from a server with none,
    // and the health check reported the database as down.
    const env = loadEnv(
      validEnv({ NODE_ENV: 'production', BASE_URL: 'https://x.example', DATABASE_SSL: 'false' }),
    );

    assert.equal(env.isProduction, true);
    assert.equal(env.databaseSsl, false);
  });

  it('rejects a DATABASE_SSL value that is neither true nor false', () => {
    const issues = expectIssues(validEnv({ DATABASE_SSL: 'yes' }));
    assert.ok(issues.some((message) => message.startsWith('DATABASE_SSL')));
  });

  it('rejects a short IP_HASH_SALT, which would be brute-forceable', () => {
    const issues = expectIssues(validEnv({ IP_HASH_SALT: 'too-short' }));
    assert.ok(issues.some((message) => message.startsWith('IP_HASH_SALT')));
  });

  it('rejects the placeholder salt copied from .env.example', () => {
    const placeholder = 'replace-me-with-32-random-bytes-in-hex';
    const issues = expectIssues(validEnv({ IP_HASH_SALT: placeholder }));
    assert.ok(issues.some((message) => message.includes('placeholder')));
  });

  it('ignores ENABLE_UNAUTHENTICATED_LINK_ADMIN, which no longer exists', () => {
    // The flag gated listing and deletion while those routes had no ownership
    // check. Identity authenticates them now, so the flag was removed rather
    // than left switched off: a flag that can be switched back on eventually is.
    assert.doesNotThrow(() =>
      loadEnv(validEnv({ ENABLE_UNAUTHENTICATED_LINK_ADMIN: '1' })),
    );
  });
});
