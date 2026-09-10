/**
 * Request body reading, with a hard size limit.
 *
 * A size limit without a streaming check is not a limit. Buffering a request in
 * full and then measuring it means an attacker has already spent the memory by
 * the time the check runs. This module stops reading the moment the limit is
 * exceeded, before the rest of the body has been accepted.
 */

/** Largest request body this service accepts, in bytes. */
export const MAX_BODY_BYTES = 16 * 1024;

/** The outcome of reading a request body. */
export type ReadBodyResult =
  | { readonly ok: true; readonly value: string }
  | {
      readonly ok: false;
      readonly status: 413 | 400;
      readonly code: 'BODY_TOO_LARGE' | 'BODY_INVALID_JSON';
      readonly message: string;
    };

/**
 * The parts of an incoming request this module needs.
 *
 * Narrower than `IncomingMessage`, so tests can supply a plain readable stream
 * instead of standing up a server.
 */
export type BodySource = AsyncIterable<Buffer | string> & {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
};

/**
 * Reads a request body as text, refusing anything over {@link MAX_BODY_BYTES}.
 *
 * Two checks, in this order, because each catches what the other misses:
 *
 * 1. `Content-Length`, when present and already too large. This rejects an
 *    oversized upload before a single byte of it is read.
 * 2. A running total while streaming. `Content-Length` is caller-supplied and
 *    may be absent, wrong, or a lie, and a chunked request has none at all.
 *
 * Size is counted in bytes, not characters. A multi-byte character would
 * otherwise let a caller send several times the intended limit.
 *
 * @param request - The incoming request.
 * @returns The body as UTF-8 text, or a description of why it was refused.
 *   Never throws for an oversized body: that is an expected outcome, not an
 *   exceptional one.
 */
export async function readBody(request: BodySource): Promise<ReadBodyResult> {
  const declared = declaredLength(request.headers['content-length']);
  if (declared !== undefined && declared > MAX_BODY_BYTES) {
    return tooLarge();
  }

  const chunks: Buffer[] = [];
  let total = 0;

  // An explicit iterator, rather than `for await`, and the reason is not style.
  //
  // Leaving a `for await` loop early calls `return()` on the iterator, which
  // destroys the underlying stream. Destroying it kills the socket while the
  // client is still uploading, and the client then reports a connection reset
  // instead of reading the 413 that was about to be sent. Verified: an
  // integration test failed with `fetch failed` rather than a readable status.
  //
  // Stopping by simply not calling `next()` again leaves the stream paused and
  // intact. The server writes the response and drains the remainder afterwards,
  // because only the server knows when the response has gone out.
  const iterator = request[Symbol.asyncIterator]();

  for (;;) {
    const step = await iterator.next();
    if (step.done === true) break;

    const buffer = typeof step.value === 'string' ? Buffer.from(step.value, 'utf8') : step.value;
    total += buffer.byteLength;

    if (total > MAX_BODY_BYTES) return tooLarge();

    chunks.push(buffer);
  }

  return { ok: true, value: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Reads a request body and parses it as JSON.
 *
 * An empty body yields `undefined` rather than a parse failure, so a route that
 * takes no body needs no special case.
 *
 * @param request - The incoming request.
 * @returns The parsed value, or a description of why the body was refused.
 */
export async function readJsonBody(
  request: BodySource,
): Promise<
  { readonly ok: true; readonly value: unknown } | Extract<ReadBodyResult, { ok: false }>
> {
  const text = await readBody(request);
  if (!text.ok) return text;

  if (text.value.trim() === '') return { ok: true, value: undefined };

  try {
    return { ok: true, value: JSON.parse(text.value) };
  } catch {
    // The parser's own message names an offset in the caller's input, which is
    // noise to them and detail we would rather not echo back.
    return {
      ok: false,
      status: 400,
      code: 'BODY_INVALID_JSON',
      message: 'Request body must be valid JSON.',
    };
  }
}

/**
 * Reads a `Content-Length` header.
 *
 * @param value - The raw header, which Node may supply as an array when the
 *   header was repeated.
 * @returns The declared length, or `undefined` when absent or unusable. An
 *   unusable value is not an error here: the streaming check still applies.
 */
function declaredLength(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/**
 * Builds the oversized-body result.
 *
 * @returns A 413 result naming the limit, so the caller knows what to aim for.
 */
function tooLarge(): Extract<ReadBodyResult, { ok: false }> {
  return {
    ok: false,
    status: 413,
    code: 'BODY_TOO_LARGE',
    message: `Request body must be ${MAX_BODY_BYTES} bytes or fewer.`,
  };
}
