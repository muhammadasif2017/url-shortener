/**
 * Structured logging to stdout.
 *
 * One JSON object per line, because that is what every log aggregator can read
 * and what a human can still grep. Nothing is written to stderr except at error
 * level, so ordinary traffic never looks like a failure to a platform that
 * treats stderr as one.
 *
 * There is a hard rule this module cannot enforce on its own: never log a
 * password, a password hash, a session id, or a `Cookie` header. A logger that
 * records the session id logs the credential itself.
 */

/** Severity levels, ordered from least to most severe. */
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** A log severity. Derived from a `const` array, since `enum` cannot be erased. */
export type LogLevel = (typeof LEVELS)[number];

/** Arbitrary structured fields attached to a log line. */
export type LogFields = Record<string, unknown>;

/**
 * Whether log output is suppressed.
 *
 * Tests that deliberately exercise a failure path write real error lines, which
 * bury the test runner's own output and make a passing run look like a broken
 * one. Suppressing them under `NODE_ENV=test` keeps the signal readable.
 *
 * `LOG_IN_TESTS=1` turns output back on, because the first thing wanted when
 * debugging a failing test is the logs it produced.
 *
 * This reads `process.env` directly, which no other module may do. Routing it
 * through `config/env.ts` would make every unit test need a fully valid
 * environment just to import a module that logs.
 */
function isSuppressed(): boolean {
  return process.env['NODE_ENV'] === 'test' && process.env['LOG_IN_TESTS'] !== '1';
}

/**
 * Writes one structured log line.
 *
 * @param level - Severity.
 * @param message - Short, stable description. Keep identifiers in `fields`
 *   rather than interpolating them, so lines about the same event group.
 * @param fields - Structured context.
 */
export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (isSuppressed()) return;

  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...fields,
  });

  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/**
 * Reduces an unknown thrown value to something safe to log.
 *
 * `catch` binds `unknown`, and a thrown value need not be an `Error`. Stringify
 * happens here so no call site has to guess.
 *
 * @param error - Whatever was caught.
 * @returns Fields describing it, including a stack when one exists.
 */
export function describeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    };
  }

  return { errorName: 'NonError', errorMessage: String(error) };
}
