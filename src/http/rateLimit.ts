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
   * Hard cap on tracked keys. Reaching it evicts an entry.
   *
   * The cap matters more than it looks. Without one, an attacker rotating
   * addresses fills memory faster than any window expires them. Which entry the
   * cap sacrifices matters just as much: see `createRateLimiter`.
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
 * Entries are held in two maps rather than one, and the split is what makes the
 * cap safe. A key that has not yet reached the limit is evictable; a key that
 * has reached it is not, until nothing evictable is left.
 *
 * A single map evicted in insertion order can be emptied of the entry that
 * matters. An attacker sending one request from each of `maxEntries` addresses
 * to the login route pushes out the window belonging to the account they are
 * attacking, because that window was inserted earlier than the flood. The
 * victim's next attempt then opens a fresh window and starts counting from one,
 * so the limit never fires however many attempts are made. Every request in the
 * flood is itself allowed, since each one opens a new window, which makes the
 * flood cheap.
 *
 * Evicting by soonest expiry has the same hole and is easier to mistake for a
 * fix: with one window length, the oldest window is also the one expiring
 * first, so it is still the victim's.
 *
 * Protecting keys that are at the limit raises the price. Clearing a protected
 * entry costs `max` requests per key across the whole cap rather than one, and
 * every one of those requests is refused. Memory is still bounded, because a
 * protected entry is evicted once nothing else can be.
 *
 * This is a cost increase, not an impossibility proof. An attacker willing to
 * spend `maxEntries × max` refused requests still fills the protected map and
 * reaches a real window. The fix that removes the class rather than pricing it
 * is a shared counter store, which this module is deliberately not.
 *
 * @param options - Limit, window, and entry cap.
 * @returns The limiter.
 */
export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  /** Keys still under the limit. Evicted first, oldest inserted first. */
  const underLimit = new Map<string, Window>();

  /** Keys that have reached the limit. Evicted only when nothing else can be. */
  const atLimit = new Map<string, Window>();

  /**
   * Removes expired entries from both maps.
   *
   * Runs on write rather than on a timer. A timer would keep the process alive
   * and would run even when the service is idle and has nothing to sweep.
   *
   * @param now - Current time.
   */
  function sweep(now: number): void {
    for (const map of [underLimit, atLimit]) {
      for (const [key, window] of map) {
        if (window.expiresAt <= now) map.delete(key);
      }
    }
  }

  /**
   * Drops one entry so a new key fits, preferring one that is under the limit.
   *
   * Map iteration order is insertion order, so the first key of `underLimit` is
   * its oldest. Dropping an entry gives that client a fresh window, which is the
   * correct failure direction for a key under the limit: over-permissive beats
   * running out of memory.
   *
   * When every tracked key is at the limit, the choice matters again, and
   * insertion order is the wrong answer for the same reason it was in the map
   * this replaced: the longest-standing block is the one worth keeping. The
   * entry expiring soonest is dropped instead, since it is closest to
   * disappearing on its own. Reaching this branch costs an attacker `max`
   * refused requests for every key they have to fill, rather than one.
   *
   * The scan is linear, and runs only when nothing evictable is left.
   */
  function evictOne(): void {
    if (underLimit.size > 0) {
      const oldest = underLimit.keys().next();
      if (oldest.done !== true) underLimit.delete(oldest.value);
      return;
    }

    let soonestKey: string | undefined;
    let soonestExpiry = Number.POSITIVE_INFINITY;
    for (const [key, window] of atLimit) {
      if (window.expiresAt < soonestExpiry) {
        soonestExpiry = window.expiresAt;
        soonestKey = key;
      }
    }
    if (soonestKey !== undefined) atLimit.delete(soonestKey);
  }

  return {
    check(key, now = Date.now()) {
      const existing = atLimit.get(key) ?? underLimit.get(key);

      if (existing === undefined || existing.expiresAt <= now) {
        // A new key, or a window that has rolled over. Delete both copies before
        // reinserting: a rolled-over window may be sitting in either map, and a
        // key present in both would be counted twice and never expire.
        underLimit.delete(key);
        atLimit.delete(key);

        // Sweep first so the size check below counts only live entries.
        sweep(now);

        if (underLimit.size + atLimit.size >= maxEntries) evictOne();

        // A limit of one is reached by the request that opens the window, so
        // that window is protected from the moment it exists.
        const window: Window = { count: 1, expiresAt: now + options.windowMs };
        if (window.count >= options.max) atLimit.set(key, window);
        else underLimit.set(key, window);

        return {
          allowed: true,
          remaining: options.max - 1,
          retryAfterSeconds: Math.ceil(options.windowMs / 1000),
        };
      }

      existing.count += 1;

      // Promote on reaching the limit, not on exceeding it. The request that
      // spends the last of the allowance is the one that makes this key worth
      // protecting; waiting one more request leaves a gap an attacker can aim at.
      if (existing.count >= options.max && !atLimit.has(key)) {
        underLimit.delete(key);
        atLimit.set(key, existing);
      }

      const retryAfterSeconds = Math.max(1, Math.ceil((existing.expiresAt - now) / 1000));

      return {
        allowed: existing.count <= options.max,
        remaining: Math.max(0, options.max - existing.count),
        retryAfterSeconds,
      };
    },

    size() {
      return underLimit.size + atLimit.size;
    },
  };
}
