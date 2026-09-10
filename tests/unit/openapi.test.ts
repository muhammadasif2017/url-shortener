import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { RouteTable } from '../../src/http/context.ts';
import { analyticsRoutes } from '../../src/modules/analytics/analytics.routes.ts';
import { identityRoutes } from '../../src/modules/identity/identity.routes.ts';
import { linkRoutes } from '../../src/modules/links/links.routes.ts';
import { healthRoutes } from '../../src/server.ts';

/**
 * The API description, checked against the routes the server actually serves.
 *
 * A hand-written OpenAPI document is worth having only while it is true, and the
 * way it stops being true is never a decision: it is a route added or a path
 * renamed by someone who did not know the file existed. This test is what makes
 * that a build failure rather than a discovery made by a client six months
 * later.
 *
 * It deliberately checks the route inventory and not response bodies. Asserting
 * every schema here would restate the integration tests in a second, weaker
 * form; asserting the inventory catches the drift that actually happens.
 */

/** The document under test. */
const spec = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')) as {
  readonly openapi: string;
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: { readonly schemas: Record<string, unknown> };
};

/** Every route the process registers, in the order the entry point assembles them. */
const routes: RouteTable = [...healthRoutes, ...linkRoutes, ...identityRoutes, ...analyticsRoutes];

/** HTTP methods a path item may describe. Everything else in it is metadata. */
const OPERATION_KEYS: ReadonlySet<string> = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

/**
 * Converts a router path to the OpenAPI template form.
 *
 * The router writes a parameter as `:slug` and OpenAPI writes it as `{slug}`.
 * That is the only difference between the two notations, and translating in one
 * direction here is what lets the two lists be compared as sets.
 *
 * @param path - A path as the router holds it.
 * @returns The same path in OpenAPI notation.
 */
function toTemplate(path: string): string {
  return path.replace(/:([^/]+)/g, '{$1}');
}

/** Every method-and-path pair the server serves, as `GET /api/links`. */
function servedOperations(): readonly string[] {
  return routes.map((route) => `${route.method.toUpperCase()} ${toTemplate(route.path)}`).sort();
}

/** Every method-and-path pair the document describes. */
function documentedOperations(): readonly string[] {
  const operations: string[] = [];

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const key of Object.keys(item)) {
      if (OPERATION_KEYS.has(key)) operations.push(`${key.toUpperCase()} ${path}`);
    }
  }

  return operations.sort();
}

describe('openapi.json', () => {
  it('is a 3.1 document', () => {
    assert.match(spec.openapi, /^3\.1\./);
  });

  it('describes every route the server serves', () => {
    const undocumented = servedOperations().filter(
      (operation) => !documentedOperations().includes(operation),
    );

    assert.deepEqual(
      undocumented,
      [],
      `Routes exist with no entry in openapi.json: ${undocumented.join(', ')}`,
    );
  });

  it('describes no route the server does not serve', () => {
    const orphaned = documentedOperations().filter(
      (operation) => !servedOperations().includes(operation),
    );

    assert.deepEqual(
      orphaned,
      [],
      `openapi.json describes routes that do not exist: ${orphaned.join(', ')}`,
    );
  });

  it('resolves every internal reference', () => {
    // A `$ref` to a component that was renamed or never written produces a
    // document that still parses as JSON and is useless to every generator that
    // reads it. Nothing else in the test suite would notice.
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"(#[^"]+)"/g)].map(
      (match) => match[1] ?? '',
    );

    assert.ok(refs.length > 0, 'expected the document to use components');

    for (const ref of refs) {
      const segments = ref.slice(2).split('/');
      let node: unknown = spec;

      for (const segment of segments) {
        assert.ok(
          typeof node === 'object' && node !== null && segment in node,
          `unresolved reference: ${ref}`,
        );
        node = (node as Record<string, unknown>)[segment];
      }
    }
  });

  it('gives every documented response the correlation header', () => {
    // The header is set for every response by `send`, so a response object that
    // omits it is the document understating what the service does, which is the
    // form of drift a reader cannot detect by reading.
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!OPERATION_KEYS.has(method)) continue;

        const responses = (operation as { responses: Record<string, Record<string, unknown>> })
          .responses;

        for (const [status, response] of Object.entries(responses)) {
          // A `$ref` response carries its headers in the component it names,
          // which this test checks where that component is defined.
          if ('$ref' in response) continue;

          const headers = (response['headers'] ?? {}) as Record<string, unknown>;
          assert.ok(
            'X-Request-Id' in headers,
            `${method.toUpperCase()} ${path} ${status} does not document X-Request-Id`,
          );
        }
      }
    }
  });

  it('gives every shared response component the correlation header', () => {
    const responses = (
      spec.components as unknown as {
        responses: Record<string, { headers?: Record<string, unknown> }>;
      }
    ).responses;

    for (const [name, response] of Object.entries(responses)) {
      assert.ok(
        'X-Request-Id' in (response.headers ?? {}),
        `component response ${name} does not document X-Request-Id`,
      );
    }
  });
});
