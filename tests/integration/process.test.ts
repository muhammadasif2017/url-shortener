import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

/**
 * Behaviour that can only be observed from a separate process.
 *
 * Configuration is read once per process and cached, so a test cannot toggle a
 * setting and observe the effect in the same process. Anything gated on
 * configuration has to be verified by starting the real entry point with a real
 * environment, which is what this file does.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Finds a free TCP port.
 *
 * Binding to port 0 and reading back the assigned port is race-prone in theory,
 * because the port is released before the child claims it. In practice the
 * window is microseconds and the alternative is a hard-coded port that collides
 * with whatever else is running.
 *
 * @returns A port that was free a moment ago.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** A running child server. */
type Child = {
  readonly url: string;
  readonly process: ChildProcess;
  stop(): Promise<void>;
};

/**
 * Starts the real entry point in a child process.
 *
 * @param env - Environment for the child. Merged over a working baseline.
 * @returns The running child, once its health check answers.
 */
async function startChild(env: Record<string, string>): Promise<Child> {
  const port = await freePort();

  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', 'src/index.ts'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        BASE_URL: `http://127.0.0.1:${port}`,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const url = `http://127.0.0.1:${port}`;

  // Poll rather than sleep. A fixed sleep is either too short on a loaded
  // machine or wasted time on an idle one.
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('Child server did not become healthy in time.');
    }
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return {
    url,
    process: child,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}

describe('link administration requires authentication', () => {
  let child: Child;

  before(async () => {
    child = await startChild({});
  });

  after(async () => {
    await child.stop();
  });

  it('returns 401 for listing without a session', async () => {
    const response = await fetch(`${child.url}/api/links`);
    assert.equal(response.status, 401);
  });

  it('returns 401 for deletion without a session', async () => {
    const response = await fetch(`${child.url}/api/links/anything`, { method: 'DELETE' });
    assert.equal(response.status, 401);
  });

  it('gives the same answer for a forged session id as for none at all', async () => {
    // Distinguishing "unknown session" from "no session" would tell a caller
    // which session ids once existed.
    const response = await fetch(`${child.url}/api/links`, {
      headers: { cookie: 'session=aW52ZW50ZWQtc2Vzc2lvbi1pZGVudGlmaWVy' },
    });

    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  });

  it('requires a session to create a link, and none to follow one', async () => {
    // Authentication gates who can mint a link, never who can follow one.
    // Following is the product, and a redirect that asked for a session would be
    // useless to everyone the link was sent to.
    const anonymous = await fetch(`${child.url}/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/anonymous' }),
    });

    assert.equal(anonymous.status, 401);
    await anonymous.body?.cancel();

    const email = `process-${Date.now()}@example.com`;
    const password = 'a sufficiently long passphrase';

    const registered = await fetch(`${child.url}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    // 202 and no session: registration answers the same whether or not the
    // address was free, so signing in is a separate call.
    assert.equal(registered.status, 202);
    assert.equal(registered.headers.getSetCookie().length, 0);
    await registered.body?.cancel();

    const signedIn = await fetch(`${child.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    assert.equal(signedIn.status, 200);
    const setCookie = signedIn.headers
      .getSetCookie()
      .find((header) => header.startsWith('session='));
    const cookie = (setCookie ?? '').split(';')[0] ?? '';
    await signedIn.body?.cancel();

    const created = await fetch(`${child.url}/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ url: 'https://example.com/anonymous' }),
    });

    assert.equal(created.status, 201);
    const { slug } = (await created.json()) as { slug: string };

    const followed = await fetch(`${child.url}/${slug}`, { redirect: 'manual' });
    assert.equal(followed.status, 302);
    assert.equal(followed.headers.get('location'), 'https://example.com/anonymous');
  });
});

describe('startup refuses an unsafe configuration', () => {
  it('will not start with a missing required variable', async () => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', 'src/index.ts'],
      {
        cwd: ROOT,
        env: {
          PATH: process.env['PATH'] ?? '',
          NODE_ENV: 'development',
          // Everything else deliberately absent.
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', resolve);
    });

    assert.notEqual(code, 0);
    // Every problem is reported at once, so a misconfigured deployment is fixed
    // in one pass rather than one variable per restart.
    assert.match(stderr, /DATABASE_URL/);
    assert.match(stderr, /BASE_URL/);
  });
});
