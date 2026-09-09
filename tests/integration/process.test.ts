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
        ENABLE_UNAUTHENTICATED_LINK_ADMIN: '',
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

describe('unauthenticated admin routes are closed by default', () => {
  let child: Child;

  before(async () => {
    // The flag is deliberately absent. Until the identity module exists, these
    // routes let anyone list every link and delete any of them.
    child = await startChild({});
  });

  after(async () => {
    await child.stop();
  });

  it('returns 404 for listing', async () => {
    const response = await fetch(`${child.url}/api/links`);
    assert.equal(response.status, 404);
  });

  it('returns 404 for deletion', async () => {
    const response = await fetch(`${child.url}/api/links/anything`, { method: 'DELETE' });
    assert.equal(response.status, 404);
  });

  it('answers 404 rather than 403, so the route is not confirmed to exist', async () => {
    const response = await fetch(`${child.url}/api/links`);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('still allows link creation and redirection', async () => {
    // The gate closes administration, not the product.
    const created = await fetch(`${child.url}/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/gated' }),
    });

    assert.equal(created.status, 201);
    const { slug } = (await created.json()) as { slug: string };

    const followed = await fetch(`${child.url}/${slug}`, { redirect: 'manual' });
    assert.equal(followed.status, 302);
    assert.equal(followed.headers.get('location'), 'https://example.com/gated');
  });
});

describe('startup refuses an unsafe configuration', () => {
  it('will not start in production with the admin flag set', async () => {
    // A copied environment file is exactly how a local convenience reaches
    // production. Refusing to start is the only reliable way to stop it.
    const port = await freePort();

    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', 'src/index.ts'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          PORT: String(port),
          BASE_URL: 'https://example.com',
          ENABLE_UNAUTHENTICATED_LINK_ADMIN: '1',
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

    assert.notEqual(code, 0, 'expected a non-zero exit');
    assert.match(stderr, /ENABLE_UNAUTHENTICATED_LINK_ADMIN/);
  });

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
