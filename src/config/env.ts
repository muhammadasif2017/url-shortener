/**
 * Environment parsing and validation.
 *
 * Every variable is read and checked exactly once, at startup. A missing or
 * malformed value stops the process immediately rather than producing a
 * confusing failure on the first request that happens to need it. A service
 * that starts in a broken state is worse than one that refuses to start,
 * because the broken one looks healthy.
 *
 * Nothing outside this module reads `process.env`.
 */

/** Environments this service recognises. */
const ENVIRONMENTS = ['development', 'test', 'production'] as const;

/**
 * The environment name.
 *
 * Declared as a union derived from a `const` array rather than an `enum`,
 * because `enum` emits runtime code and Node's type stripping rejects it.
 */
export type Environment = (typeof ENVIRONMENTS)[number];

/** Every setting this service needs, validated and typed. */
export type Env = {
  readonly nodeEnv: Environment;
  readonly isProduction: boolean;
  readonly port: number;
  /** Public base URL, never with a trailing slash. */
  readonly baseUrl: string;
  readonly databaseUrl: string;
  /**
   * How many trusted proxies sit in front of this service.
   *
   * `0` means the socket address is the client. Above `0`, the client address
   * is taken this many entries from the right-hand end of `X-Forwarded-For`.
   */
  readonly trustProxyHops: number;
  /** Salt for hashing visitor IP addresses. Never logged. */
  readonly ipHashSalt: string;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly sessionTtlSeconds: number;
  /**
   * Whether the unauthenticated link administration routes are exposed.
   *
   * Off everywhere except local development and integration tests. While it is
   * on, anyone can list every link and delete any of them.
   */
  readonly enableUnauthenticatedLinkAdmin: boolean;
};

/** Raised when the environment cannot produce a usable configuration. */
export class EnvError extends Error {
  /** Every problem found, so one failure reports all of them. */
  readonly issues: readonly string[];

  /**
   * @param issues - One message per invalid or missing variable.
   */
  constructor(issues: readonly string[]) {
    super(`Invalid environment:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvError';
    this.issues = issues;
  }
}

/** A mutable source of environment values, such as `process.env`. */
type Source = Record<string, string | undefined>;

/**
 * Reads a required string.
 *
 * @param source - Where to read from.
 * @param key - Variable name.
 * @param issues - Collector appended to on failure.
 * @returns The trimmed value, or an empty string when missing.
 */
function requireString(source: Source, key: string, issues: string[]): string {
  const raw = source[key]?.trim();
  if (raw === undefined || raw === '') {
    issues.push(`${key} is required.`);
    return '';
  }
  return raw;
}

/**
 * Reads an integer, applying a default when absent.
 *
 * @param source - Where to read from.
 * @param key - Variable name.
 * @param issues - Collector appended to on failure.
 * @param options.min - Smallest acceptable value, inclusive.
 * @param options.max - Largest acceptable value, inclusive.
 * @param options.fallback - Used when the variable is absent. Omit to require it.
 * @returns The parsed integer, or the fallback, or `0` when invalid.
 */
function requireInteger(
  source: Source,
  key: string,
  issues: string[],
  options: { readonly min: number; readonly max: number; readonly fallback?: number },
): number {
  const raw = source[key]?.trim();

  if (raw === undefined || raw === '') {
    if (options.fallback !== undefined) return options.fallback;
    issues.push(`${key} is required.`);
    return 0;
  }

  if (!/^\d+$/.test(raw)) {
    issues.push(`${key} must be a whole number.`);
    return 0;
  }

  const value = Number(raw);
  if (value < options.min || value > options.max) {
    issues.push(`${key} must be between ${options.min} and ${options.max}.`);
    return 0;
  }

  return value;
}

/**
 * Builds a validated configuration from a source of environment values.
 *
 * The source is a parameter rather than a direct read of `process.env` so that
 * this function is testable at its boundary. A function that reaches for global
 * state cannot be tested without mutating that global state.
 *
 * @param source - Environment values, normally `process.env`.
 * @returns The validated configuration.
 * @throws {EnvError} When any variable is missing or malformed. The error lists
 *   every problem, so a misconfigured deployment is fixed in one pass.
 */
export function loadEnv(source: Source): Env {
  const issues: string[] = [];

  const nodeEnvRaw = source['NODE_ENV']?.trim() ?? 'development';
  if (!(ENVIRONMENTS as readonly string[]).includes(nodeEnvRaw)) {
    issues.push(`NODE_ENV must be one of: ${ENVIRONMENTS.join(', ')}.`);
  }
  const nodeEnv = nodeEnvRaw as Environment;

  const port = requireInteger(source, 'PORT', issues, { min: 1, max: 65535 });
  const baseUrlRaw = requireString(source, 'BASE_URL', issues);
  const databaseUrl = requireString(source, 'DATABASE_URL', issues);
  const ipHashSalt = requireString(source, 'IP_HASH_SALT', issues);

  const trustProxyHops = requireInteger(source, 'TRUST_PROXY_HOPS', issues, {
    min: 0,
    max: 10,
  });

  const rateLimitMax = requireInteger(source, 'RATE_LIMIT_MAX', issues, {
    min: 1,
    max: 1_000_000,
    fallback: 60,
  });

  const rateLimitWindowMs = requireInteger(source, 'RATE_LIMIT_WINDOW_MS', issues, {
    min: 1000,
    max: 86_400_000,
    fallback: 60_000,
  });

  const sessionTtlSeconds = requireInteger(source, 'SESSION_TTL_SECONDS', issues, {
    min: 60,
    max: 31_536_000,
    fallback: 604_800,
  });

  if (baseUrlRaw !== '') {
    try {
      const parsed = new URL(baseUrlRaw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        issues.push('BASE_URL must be an http or https URL.');
      }
    } catch {
      issues.push('BASE_URL must be a valid absolute URL.');
    }
  }

  // A weak salt makes the visitor-IP hash reversible by brute force over the
  // whole IPv4 space, which is only about four billion candidates.
  if (ipHashSalt !== '' && ipHashSalt.length < 32) {
    issues.push('IP_HASH_SALT must be at least 32 characters.');
  }
  if (ipHashSalt.startsWith('replace-me')) {
    issues.push('IP_HASH_SALT still holds the placeholder from .env.example.');
  }

  const enableUnauthenticatedLinkAdmin = source['ENABLE_UNAUTHENTICATED_LINK_ADMIN'] === '1';

  // The flag exposes routes that let anyone enumerate every link and delete any
  // of them. Refusing to start is the only reliable way to keep a local
  // convenience from reaching production by way of a copied env file.
  if (enableUnauthenticatedLinkAdmin && nodeEnv === 'production') {
    issues.push('ENABLE_UNAUTHENTICATED_LINK_ADMIN must not be set in production.');
  }

  if (issues.length > 0) throw new EnvError(issues);

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port,
    baseUrl: baseUrlRaw.replace(/\/+$/, ''),
    databaseUrl,
    trustProxyHops,
    ipHashSalt,
    rateLimitMax,
    rateLimitWindowMs,
    sessionTtlSeconds,
    enableUnauthenticatedLinkAdmin,
  };
}

/**
 * The process-wide configuration, built from `process.env` on first access.
 *
 * Deferred rather than built at import time so that importing a module for a
 * unit test does not require a fully populated environment.
 *
 * @returns The validated configuration.
 * @throws {EnvError} When the environment is invalid.
 */
let cached: Env | undefined;
export function env(): Env {
  cached ??= loadEnv(process.env);
  return cached;
}
