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
   * Whether to connect to PostgreSQL over TLS.
   *
   * Separate from `nodeEnv` on purpose. Managed providers require TLS and a
   * local container does not offer it, so tying the two together makes the
   * production image impossible to run locally: it would demand TLS from a
   * server that has none, and the health check would report the database as
   * down. Defaults to on in production, and can be turned off explicitly.
   */
  readonly databaseSsl: boolean;
  /**
   * PEM-encoded certificate authority bundle for the database connection.
   *
   * Undefined means Node's built-in trust store is used. Managed providers
   * usually sign their database certificates with their own authority, which is
   * not in that store, so the bundle they publish has to be supplied here.
   * Without it the connection to such a provider fails to verify, which is the
   * intended outcome: an unverified peer is not the database.
   */
  readonly databaseCaCert: string | undefined;
  /**
   * How many trusted proxies sit in front of this service.
   *
   * `0` means the socket address is the client. Above `0`, the client address
   * is taken this many entries from the right-hand end of `X-Forwarded-For`.
   */
  readonly trustProxyHops: number;
  /** Salt for hashing visitor IP addresses. Never logged. */
  readonly ipHashSalt: string;
  /**
   * How long click events are kept, in days.
   *
   * Retention is the deletion path for visitor data. A click row is a hashed
   * address, a referrer and a user agent, with nothing that identifies the
   * person it came from, so there is no request a visitor could make to have
   * their own rows found and removed. An expiry is what bounds that: data the
   * service no longer holds cannot be leaked, subpoenaed, or correlated later.
   */
  readonly clickRetentionDays: number;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly sessionTtlSeconds: number;
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

  const clickRetentionDays = requireInteger(source, 'CLICK_RETENTION_DAYS', issues, {
    min: 1,
    max: 3_650,
    fallback: 90,
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

  const sslRaw = source['DATABASE_SSL']?.trim();
  if (sslRaw !== undefined && sslRaw !== '' && sslRaw !== 'true' && sslRaw !== 'false') {
    issues.push("DATABASE_SSL must be 'true' or 'false'.");
  }
  const databaseSsl =
    sslRaw === undefined || sslRaw === '' ? nodeEnv === 'production' : sslRaw === 'true';

  // Read as a literal PEM rather than a path, because the platforms this runs on
  // inject secrets as environment values and have no filesystem to put a file
  // on. A newline-escaped value is accepted too: a single-line environment
  // variable is the only shape some dashboards allow, and a PEM whose newlines
  // did not survive that trip fails to parse for a reason nobody enjoys finding.
  const caRaw = source['DATABASE_CA_CERT']?.trim();
  const databaseCaCert =
    caRaw === undefined || caRaw === '' ? undefined : caRaw.replace(/\\n/g, '\n');
  if (databaseCaCert !== undefined && !databaseCaCert.includes('-----BEGIN CERTIFICATE-----')) {
    issues.push('DATABASE_CA_CERT must be a PEM-encoded certificate.');
  }
  // A bundle supplied while TLS is off is ignored rather than rejected. That
  // combination is what running the production image against the local database
  // looks like, with the platform's variables still in the environment, and it
  // is not unsafe: refusing to start there would be a footgun over a setting
  // nothing reads.

  // ENABLE_UNAUTHENTICATED_LINK_ADMIN used to be validated here. It gated the
  // listing and deletion routes while they had no ownership check. The identity
  // module now authenticates those routes properly, so the flag has been
  // removed rather than left switched off: a flag that can be switched back on
  // is a flag that eventually is.

  if (issues.length > 0) throw new EnvError(issues);

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port,
    baseUrl: baseUrlRaw.replace(/\/+$/, ''),
    databaseUrl,
    databaseSsl,
    databaseCaCert,
    trustProxyHops,
    ipHashSalt,
    clickRetentionDays,
    rateLimitMax,
    rateLimitWindowMs,
    sessionTtlSeconds,
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
