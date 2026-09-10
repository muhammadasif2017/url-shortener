/**
 * Cookie parsing and serialisation.
 *
 * `node:http` hands over a raw `Cookie` header string and expects a raw
 * `Set-Cookie` array back. There is no built-in parser, and none is being
 * added, so this module is the whole of it.
 *
 * The failure mode here is quiet: a parser that mishandles a value containing
 * `=`, or a second cookie on the same header, attributes a session to the wrong
 * value rather than throwing.
 */

/** Attributes that scope a cookie. */
export type CookieOptions = {
  /** Path the cookie applies to. Always set, so deletion can match it. */
  readonly path?: string;
  /** Lifetime in seconds. `0` deletes the cookie. */
  readonly maxAge?: number;
  /** Blocks JavaScript access. Always true for a session cookie. */
  readonly httpOnly?: boolean;
  /** Restricts the cookie to HTTPS. Required by the `__Host-` prefix. */
  readonly secure?: boolean;
  /** Cross-site policy. `Lax` blocks the cookie on cross-site state changes. */
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
};

/**
 * Parses a `Cookie` request header.
 *
 * Splits on `;` for pairs and on the **first** `=` only. A base64 or JWT value
 * can contain `=` as padding, and splitting on every `=` would truncate it.
 *
 * A repeated name keeps the first occurrence, matching how browsers resolve the
 * ambiguity, so a later injected duplicate cannot override the real value.
 *
 * @param header - Raw header value, or `undefined` when absent.
 * @returns Name to value. Empty when the header is missing or unusable.
 */
export function parseCookies(
  header: string | string[] | undefined,
): Readonly<Record<string, string>> {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (raw === undefined || raw.trim() === '') return {};

  const cookies: Record<string, string> = {};

  for (const pair of raw.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;

    const name = pair.slice(0, separator).trim();
    if (name === '' || name in cookies) continue;

    let value = pair.slice(separator + 1).trim();

    // A value containing a comma, space, or semicolon must be sent quoted.
    // Strip the quotes so callers see what was stored.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    cookies[name] = decodeValue(value);
  }

  return cookies;
}

/**
 * Decodes a percent-encoded cookie value.
 *
 * @param value - The raw value.
 * @returns The decoded value, or the original when it is not valid encoding.
 *   A malformed value is data, not a reason to fail a request.
 */
function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Characters a cookie name may not contain, per RFC 6265's token rule. */
const INVALID_NAME = /[\s()<>@,;:\\"/[\]?={}]/;

/**
 * Builds a `Set-Cookie` header value.
 *
 * The value is percent-encoded, which is also what keeps a caller-controlled
 * value from injecting `;` and inventing its own attributes.
 *
 * @param name - Cookie name.
 * @param value - Cookie value.
 * @param options - Scoping attributes.
 * @returns A complete `Set-Cookie` header value.
 * @throws {Error} When the name contains a character a cookie name may not
 *   contain. That is always a programming mistake, never caller input.
 */
export function serialiseCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (name === '' || INVALID_NAME.test(name)) {
    throw new Error(`Invalid cookie name: ${JSON.stringify(name)}`);
  }

  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.path !== undefined) parts.push(`Path=${options.path}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly === true) parts.push('HttpOnly');
  if (options.secure === true) parts.push('Secure');
  if (options.sameSite !== undefined) parts.push(`SameSite=${options.sameSite}`);

  return parts.join('; ');
}

/**
 * Builds a `Set-Cookie` header that deletes a cookie.
 *
 * The scoping attributes must match the ones the cookie was set with. A
 * deletion whose `Path` differs does nothing, and the endpoint still reports
 * success, which is a silent authentication failure.
 *
 * @param name - Cookie name, including any `__Host-` prefix used when setting.
 * @param options - The same scoping attributes used when the cookie was set.
 * @returns A `Set-Cookie` value that expires the cookie immediately.
 */
export function clearCookie(name: string, options: CookieOptions = {}): string {
  return serialiseCookie(name, '', { ...options, maxAge: 0 });
}
