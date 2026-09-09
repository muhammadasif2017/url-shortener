/**
 * Fixed-window rate limiting, in process memory.
 *
 * In-memory is correct here only because the service runs as exactly one
 * process. Two instances would keep two independent counters and the effective
 * limit would double. That trade is recorded in `SPEC.md`; if a second instance
 * ever appears, this module is one of the things that must change first.
 *
 * Eviction is not a refinement, it is the point. A map keyed by client address
 * with no eviction grows without bound, and any distributed scan against a
 * public URL fills it. That would be a memory-exhaustion vector reachable
 * without authentication, which is worse than the abuse the limiter prevents.
 */

/** What a limiter decides about one request. */
export type RateLimitDecision = {
  /** Whether the request may proceed. */
  readonly allowed: boolean;
  /** Requests still available in the current window. */
  readonly remaining: number;
  /** Seconds until the window resets, for the `Retry-After` header. */
  readonly retryAfterSeconds: number;
};

/** How a limiter is configured. */
export type RateLimitOptions = {
  /** Requests permitted per window. */
  readonly max: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /**
   * Hard cap on tracked keys. Reaching it evicts the oldest entry.
   *
   * The cap matters more than it looks. Without one, an attacker rotating
   * addresses fills memory faster than any window expires them.
   */
  readonly maxEntries?: number;
};

/** A rate limiter. */
export type RateLimiter = {
  /**
   * Records a request and decides whether it may proceed.
   *
   * @param key - Client identity, normally a resolved IP address.
   * @param now - Current time in milliseconds. A parameter so tests can advance
   *   the clock without waiting; a function reading the clock internally cannot
   *   be tested at a boundary.
   * @returns The decision.
   */
  check(key: string, now?: number): RateLimitDecision;
  /** Number of tracked keys. Exposed so eviction can be tested. */
  size(): number;
};

/** One window's state for one key. */
type Window = {
  count: number;
  /** When the window ends, in milliseconds. */
  expiresAt: number;
};

/** Default cap on tracked keys. */
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * Creates a rate limiter.
 *
 * @param options - Limit, window, and entry cap.
 * @returns The limiter.
 */
export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const windows = new Map<string, Window>();

  /**
   * Removes expired entries.
   *
   * Runs on write rather than on a timer. A timer would keep the process alive
   * and would run even when the service is idle and has nothing to sweep.
   *
   * @param now - Current time.
   */
  function sweep(now: number): void {
    for (const [key, window] of windows) {
      if (window.expiresAt <= now) windows.delete(key);
    }
  }

  return {
    check(key, now = Date.now()) {
      const existing = windows.get(key);

      if (existing === undefined || existing.expiresAt <= now) {
        // A new key, or a window that has rolled over. Sweep first so the size
        // check below counts only live entries.
        sweep(now);

        if (windows.size >= maxEntries) {
          // Map iteration order is insertion order, so the first key is the
          // oldest. Dropping it means that client gets a fresh window, which is
          // the correct failure direction: over-permissive beats running out of
          // memory.
          const oldest = windows.keys().next();
          if (oldest.done !== true) windows.delete(oldest.value);
        }

        windows.set(key, { count: 1, expiresAt: now + options.windowMs });

        return {
          allowed: true,
          remaining: options.max - 1,
          retryAfterSeconds: Math.ceil(options.windowMs / 1000),
        };
      }

      existing.count += 1;

      const retryAfterSeconds = Math.max(1, Math.ceil((existing.expiresAt - now) / 1000));

      return {
        allowed: existing.count <= options.max,
        remaining: Math.max(0, options.max - existing.count),
        retryAfterSeconds,
      };
    },

    size() {
      return windows.size;
    },
  };
}
