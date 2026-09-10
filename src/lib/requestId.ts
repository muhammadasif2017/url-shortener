import { randomUUID } from 'node:crypto';

/**
 * The per-request correlation id.
 *
 * A structured log is only useful if the lines belonging to one request can be
 * gathered back together. Without an id, a 500 in the log and the audit line
 * that preceded it are two unrelated facts, and reconstructing what one caller
 * did means guessing from timestamps on a service that handles many requests a
 * second.
 *
 * The id is generated once per request, at the top of the pipeline, and passed
 * down explicitly. Storing it in ambient async context would remove the
 * plumbing, and that is exactly what makes it the wrong choice here: this
 * service keeps what a handler may see in one narrow type, so that reaching for
 * something not passed in is a visible act rather than an invisible one.
 *
 * It is also echoed to the caller, which is what turns a bug report into a
 * lookup: a user quoting the header from a failed response names the exact
 * request in the log.
 */

/** The header carrying the id, in and out. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * The longest inbound id accepted.
 *
 * A UUID is 36 characters. This leaves room for the longer opaque ids other
 * tracing systems mint, while keeping the value short enough that it can never
 * be used to pad a log line into something expensive to store or slow to ship.
 */
const MAX_LENGTH = 128;

/**
 * Characters an inbound id may contain: unreserved URL characters only.
 *
 * The value is written to a response header and to a log line, so it is
 * untrusted input reaching two places that misread certain bytes. A newline in
 * a JSON log line is escaped by `JSON.stringify` and harmless, but a header
 * value carrying CR or LF is response splitting, and the restriction costs
 * nothing an id generator would miss.
 */
const SAFE_PATTERN = /^[A-Za-z0-9._~-]+$/;

/**
 * Resolves the id for one request.
 *
 * An id supplied by the caller is preferred when it is safe to use. That is
 * deliberate: behind a proxy or gateway that already stamps requests, adopting
 * its id is what lets a trace cross the boundary instead of restarting at this
 * service. A missing, oversized, or malformed value is replaced rather than
 * rejected, because refusing the request would let a broken upstream take the
 * service down over a header nothing depends on.
 *
 * @param header - The raw inbound header value, in whatever shape Node supplies
 *   it. An array means the header appeared more than once.
 * @returns An id safe to log and to echo.
 */
export function resolveRequestId(header: string | string[] | undefined): string {
  // A repeated header is ambiguous, and picking one of the values would be a
  // guess about which upstream to believe. Minting a fresh id is the honest
  // answer, and the correlation that is lost was never trustworthy.
  const candidate = typeof header === 'string' ? header.trim() : '';

  if (candidate.length > 0 && candidate.length <= MAX_LENGTH && SAFE_PATTERN.test(candidate)) {
    return candidate;
  }

  return randomUUID();
}
