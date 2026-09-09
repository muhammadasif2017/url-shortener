/**
 * Client IP resolution.
 *
 * Two features depend on knowing who sent a request: rate limiting and
 * unique-visitor counting. Both fail in the same direction when this is wrong,
 * and both fail silently. If every request resolves to the same address, the
 * rate limiter becomes one global bucket that the first few visitors exhaust
 * for everyone, and unique visitors collapses to one.
 *
 * Every caller uses this module. Reading `socket.remoteAddress` or
 * `X-Forwarded-For` anywhere else is how the two features drift apart.
 */

/** Returned when no address can be determined, rather than throwing or skipping. */
export const UNKNOWN_CLIENT_IP = 'unknown';

/** The parts of an incoming request this module needs, and nothing more. */
export type ClientIpSource = {
  /** Raw `X-Forwarded-For` header, if present. */
  readonly forwardedFor: string | string[] | undefined;
  /** Address of the immediate peer, which may be a proxy. */
  readonly remoteAddress: string | undefined;
};

/**
 * Resolves the address to attribute a request to.
 *
 * With `trustProxyHops` at `0`, the socket address is the client. Above `0`,
 * the client is taken that many entries from the **right-hand end** of
 * `X-Forwarded-For`.
 *
 * Counting from the right is the entire point. Each trusted proxy appends the
 * address it received the request from, so the rightmost entries are the ones
 * we appended and can believe. Everything further left was supplied by the
 * caller and may be invented. Reading the leftmost entry, which is the usual
 * mistake, lets any caller choose their own identity, defeating both the rate
 * limiter and unique-visitor counting.
 *
 * @param source - The request's forwarding header and socket address.
 * @param trustProxyHops - Number of proxies in front of this service.
 * @returns A normalised address, or {@link UNKNOWN_CLIENT_IP} when none can be
 *   determined. Never throws: a request with no usable address is still rate
 *   limited, under the shared unknown bucket.
 */
export function resolveClientIp(source: ClientIpSource, trustProxyHops: number): string {
  if (trustProxyHops <= 0) {
    return normaliseIp(source.remoteAddress);
  }

  const entries = parseForwardedFor(source.forwardedFor);

  // With N trusted proxies, the Nth entry from the right is the address the
  // outermost trusted proxy saw. Fewer entries than expected means the header
  // was not appended as configured, so the socket address is the safer answer:
  // it cannot be forged, even if it names a proxy.
  const index = entries.length - trustProxyHops;
  if (index < 0 || index >= entries.length) {
    return normaliseIp(source.remoteAddress);
  }

  return normaliseIp(entries[index]);
}

/**
 * Splits an `X-Forwarded-For` header into its entries.
 *
 * Node exposes a repeated header as an array. Joining before splitting keeps
 * both forms on one code path, since a repeated header means the same thing as
 * one comma-separated header.
 *
 * @param value - The raw header value.
 * @returns Non-empty, trimmed entries in original order.
 */
function parseForwardedFor(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const joined = Array.isArray(value) ? value.join(',') : value;
  return joined
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Normalises an address so one client cannot occupy two buckets.
 *
 * Two forms of the same address would otherwise count separately. A dual-stack
 * socket reports IPv4 clients as IPv4-mapped IPv6, so `127.0.0.1` and
 * `::ffff:127.0.0.1` are the same client. IPv6 is case-insensitive, so `::1`
 * and `::FFFF:A` differ only in presentation.
 *
 * A bracketed or port-suffixed form is also unwrapped, because some proxies
 * append `:port` to forwarded entries.
 *
 * @param value - A raw address, possibly undefined.
 * @returns The normalised address, or {@link UNKNOWN_CLIENT_IP}.
 */
function normaliseIp(value: string | undefined): string {
  if (value === undefined) return UNKNOWN_CLIENT_IP;

  let address = value.trim();
  if (address === '') return UNKNOWN_CLIENT_IP;

  // "[::1]:443" -> "::1"
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(address);
  if (bracketed?.[1] !== undefined) {
    address = bracketed[1];
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(address)) {
    // "203.0.113.5:8080" -> "203.0.113.5". Only applied to IPv4, because a bare
    // IPv6 address contains colons of its own and must not be split on them.
    address = address.slice(0, address.lastIndexOf(':'));
  }

  address = address.toLowerCase();

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped?.[1] !== undefined) return mapped[1];

  return address;
}
