import type { Route, RouteTable } from './context.ts';

/**
 * Method and path matching.
 *
 * The service exposes a catch-all redirect route at `/:slug`, which makes
 * precedence the difference between a working service and one where `/health`
 * silently becomes a link lookup. Two rules prevent that, and both are enforced
 * here rather than left to the order routes happen to be registered in:
 *
 * 1. A route whose segments are all literal wins over one with a parameter, at
 *    the first position where they differ.
 * 2. Segment counts must match exactly, so `/:slug` never matches
 *    `/api/links`.
 *
 * The reserved-slug list is a different mechanism solving a different problem.
 * It stops someone *creating* a link called `health`. It has no effect on which
 * route matches an incoming request.
 */

/** A path split into segments, each either a literal or a named parameter. */
type Segment =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'param'; readonly name: string };

/** A route with its path pre-parsed, so matching does no string splitting. */
type CompiledRoute = {
  readonly route: Route;
  readonly segments: readonly Segment[];
};

/** The outcome of matching a request against the table. */
export type MatchResult =
  | {
      readonly type: 'matched';
      readonly route: Route;
      readonly params: Readonly<Record<string, string>>;
    }
  /**
   * The path exists but not for this method. Carries the methods that path does
   * accept, for the `Allow` header that a 405 is required to include.
   */
  | { readonly type: 'method-not-allowed'; readonly allow: readonly string[] }
  | { readonly type: 'not-found' };

/** A table with its routes compiled and ordered by precedence. */
export type Router = {
  /**
   * Matches one request.
   *
   * @param method - HTTP method, in any case.
   * @param path - Request path, with or without a query string.
   * @returns What to do: serve a route, refuse the method, or 404.
   */
  match(method: string, path: string): MatchResult;
};

/**
 * Splits a path pattern into segments.
 *
 * @param path - A pattern such as `/api/links/:slug`.
 * @returns One segment per path component. The root path yields none.
 */
function compile(path: string): Segment[] {
  return splitPath(path).map((raw) =>
    raw.startsWith(':') ? { kind: 'param', name: raw.slice(1) } : { kind: 'literal', value: raw },
  );
}

/**
 * Splits a path into its non-empty components.
 *
 * Empty components are dropped, which collapses a trailing slash and any
 * doubled slash. Without that, `/health` and `/health/` would be different
 * routes, and only one of them would work.
 *
 * @param path - A request path or a route pattern.
 * @returns The path's components, in order.
 */
function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * Orders two routes by specificity, most specific first.
 *
 * Compares segment by segment. At the first position where one route has a
 * literal and the other a parameter, the literal wins. This is what keeps
 * `/health` ahead of `/:slug` no matter which was registered first, so a route
 * table's correctness does not depend on the order someone happened to type.
 *
 * @param a - First route.
 * @param b - Second route.
 * @returns Negative when `a` is more specific, positive when `b` is.
 */
function bySpecificity(a: CompiledRoute, b: CompiledRoute): number {
  const shared = Math.min(a.segments.length, b.segments.length);

  for (let index = 0; index < shared; index += 1) {
    const left = a.segments[index];
    const right = b.segments[index];
    if (left === undefined || right === undefined) break;
    if (left.kind === right.kind) continue;
    return left.kind === 'literal' ? -1 : 1;
  }

  // Equally specific across the shared prefix. Longer paths first, so a more
  // detailed route is considered before a shorter one.
  return b.segments.length - a.segments.length;
}

/**
 * Attempts to match one compiled route against a request's segments.
 *
 * @param candidate - The route to try.
 * @param segments - The request path's components.
 * @returns Captured parameters, or `undefined` when the route does not match.
 */
function tryMatch(
  candidate: CompiledRoute,
  segments: readonly string[],
): Record<string, string> | undefined {
  if (candidate.segments.length !== segments.length) return undefined;

  const params: Record<string, string> = {};

  for (let index = 0; index < segments.length; index += 1) {
    const pattern = candidate.segments[index];
    const actual = segments[index];
    if (pattern === undefined || actual === undefined) return undefined;

    if (pattern.kind === 'literal') {
      if (pattern.value !== actual) return undefined;
    } else {
      params[pattern.name] = actual;
    }
  }

  return params;
}

/**
 * Builds a router from a route table.
 *
 * Routes are compiled and sorted once, at startup, so matching a request does
 * no parsing and no allocation beyond the captured parameters.
 *
 * @param table - Every route the service serves.
 * @returns A router ready to match requests.
 * @throws {Error} When two routes share a method and an equivalent path
 *   pattern. Two handlers for one request is always a mistake, and a duplicate
 *   registered later would otherwise be silently unreachable.
 */
export function createRouter(table: RouteTable): Router {
  const compiled: CompiledRoute[] = table.map((route) => ({
    route,
    segments: compile(route.path),
  }));

  assertNoDuplicates(compiled);

  // A stable sort by specificity. Registration order still breaks ties, which
  // keeps the table readable, but it can no longer cause `/:slug` to shadow a
  // literal route.
  const ordered = [...compiled].sort(bySpecificity);

  return {
    match(method, path) {
      const normalisedMethod = method.toUpperCase();
      const segments = splitPath(stripQuery(path));

      // HEAD is served by the GET route. RFC 9110 requires HEAD wherever GET is
      // supported, and node:http suppresses the body itself, so the only work
      // is matching. Without this, every link checker and chat unfurler that
      // probes a short link with HEAD receives a 404.
      const effectiveMethod = normalisedMethod === 'HEAD' ? 'GET' : normalisedMethod;

      const allow = new Set<string>();

      for (const candidate of ordered) {
        const params = tryMatch(candidate, segments);
        if (params === undefined) continue;

        if (candidate.route.method === effectiveMethod) {
          return { type: 'matched', route: candidate.route, params };
        }

        allow.add(candidate.route.method);
        if (candidate.route.method === 'GET') allow.add('HEAD');
      }

      if (allow.size > 0) {
        return { type: 'method-not-allowed', allow: [...allow].sort() };
      }

      return { type: 'not-found' };
    },
  };
}

/**
 * Removes a query string and fragment from a request path.
 *
 * @param path - The raw request path.
 * @returns The path alone.
 */
function stripQuery(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

/**
 * Rejects a table containing two routes that could serve the same request.
 *
 * Patterns are compared by shape, not by text, because `/api/links/:slug` and
 * `/api/links/:id` differ only in a parameter name and would match identically.
 *
 * @param compiled - Every compiled route.
 * @throws {Error} On the first duplicate found.
 */
function assertNoDuplicates(compiled: readonly CompiledRoute[]): void {
  const seen = new Set<string>();

  for (const candidate of compiled) {
    const shape = candidate.segments
      .map((segment) => (segment.kind === 'literal' ? segment.value : ':'))
      .join('/');
    const key = `${candidate.route.method} /${shape}`;

    if (seen.has(key)) {
      throw new Error(`Duplicate route registered: ${key}`);
    }
    seen.add(key);
  }
}
