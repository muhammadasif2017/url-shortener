import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import {
  MAX_BODY_BYTES,
  readBody,
  readJsonBody,
  type BodySource,
} from '../../src/http/readBody.ts';

/**
 * Builds a fake request from chunks.
 *
 * Records how many bytes were actually pulled from the stream, which is the
 * only way to prove the limit stops reading rather than measuring afterwards.
 */
function fakeRequest(
  chunks: readonly (Buffer | string)[],
  headers: Record<string, string | string[] | undefined> = {},
): BodySource & { bytesRead(): number } {
  let bytesRead = 0;

  const stream = Readable.from(
    (function* generate() {
      for (const chunk of chunks) {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        bytesRead += buffer.byteLength;
        yield buffer;
      }
    })(),
  );

  const source = stream as unknown as BodySource & { bytesRead(): number };

  Object.defineProperty(source, 'headers', { value: headers });
  Object.defineProperty(source, 'bytesRead', { value: () => bytesRead });

  return source;
}

describe('readBody', () => {
  it('reads a small body', async () => {
    const result = await readBody(fakeRequest(['{"url":"https://example.com"}']));
    assert.ok(result.ok);
    assert.equal(result.value, '{"url":"https://example.com"}');
  });

  it('joins several chunks', async () => {
    const result = await readBody(fakeRequest(['{"a":', '1}']));
    assert.ok(result.ok);
    assert.equal(result.value, '{"a":1}');
  });

  it('reads an empty body as an empty string', async () => {
    const result = await readBody(fakeRequest([]));
    assert.ok(result.ok);
    assert.equal(result.value, '');
  });

  it('accepts a body at exactly the limit', async () => {
    const result = await readBody(fakeRequest([Buffer.alloc(MAX_BODY_BYTES, 0x61)]));
    assert.ok(result.ok);
    assert.equal(Buffer.byteLength(result.value), MAX_BODY_BYTES);
  });

  it('refuses a body one byte over the limit', async () => {
    const result = await readBody(fakeRequest([Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)]));
    assert.ok(!result.ok);
    assert.equal(result.status, 413);
    assert.equal(result.code, 'BODY_TOO_LARGE');
  });

  it('leaves the stream readable so the server can send 413 and then drain', async () => {
    // Destroying the stream here would kill the socket while the client is
    // still uploading, and the client would report a connection reset instead
    // of reading the 413. The server drains the remainder after responding.
    const request = fakeRequest([Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)]);
    const result = await readBody(request);

    assert.ok(!result.ok);
    assert.equal((request as unknown as { destroyed: boolean }).destroyed, false);
  });

  it('stops reading rather than buffering the whole oversized body', async () => {
    // A megabyte in 64 KB chunks. A correct implementation reads only until the
    // running total passes the limit; one that measured after buffering would
    // pull all sixteen chunks first.
    const chunks = Array.from({ length: 16 }, () => Buffer.alloc(64 * 1024, 0x61));
    const request = fakeRequest(chunks);

    const result = await readBody(request);

    assert.ok(!result.ok);
    assert.equal(result.status, 413);
    assert.ok(
      request.bytesRead() <= MAX_BODY_BYTES + 64 * 1024,
      `read ${request.bytesRead()} bytes, expected to stop near the ${MAX_BODY_BYTES} byte limit`,
    );
  });

  it('rejects an oversized Content-Length without reading anything', async () => {
    const request = fakeRequest([Buffer.alloc(1024, 0x61)], {
      'content-length': String(MAX_BODY_BYTES + 1),
    });

    const result = await readBody(request);

    assert.ok(!result.ok);
    assert.equal(result.status, 413);
    assert.equal(request.bytesRead(), 0, 'must refuse before reading any body bytes');
  });

  it('still enforces the limit when Content-Length lies', async () => {
    // A caller declaring a small body and sending a large one must not slip
    // past on the header alone.
    const request = fakeRequest([Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)], {
      'content-length': '10',
    });

    const result = await readBody(request);

    assert.ok(!result.ok);
    assert.equal(result.status, 413);
  });

  it('ignores a malformed Content-Length and falls back to streaming', async () => {
    const request = fakeRequest(['{"a":1}'], { 'content-length': 'not-a-number' });
    const result = await readBody(request);
    assert.ok(result.ok);
    assert.equal(result.value, '{"a":1}');
  });

  it('counts bytes rather than characters', async () => {
    // Each of these is one character and four bytes. Counting characters would
    // let a caller send four times the intended limit.
    const emoji = '🙂';
    assert.equal(emoji.length, 2);
    assert.equal(Buffer.byteLength(emoji, 'utf8'), 4);

    const overLimit = emoji.repeat(MAX_BODY_BYTES / 2);
    const result = await readBody(fakeRequest([overLimit]));

    assert.ok(!result.ok);
    assert.equal(result.status, 413);
  });
});

describe('readJsonBody', () => {
  it('parses a JSON object', async () => {
    const result = await readJsonBody(fakeRequest(['{"url":"https://example.com"}']));
    assert.ok(result.ok);
    assert.deepEqual(result.value, { url: 'https://example.com' });
  });

  it('treats an empty body as undefined rather than a parse failure', async () => {
    const result = await readJsonBody(fakeRequest([]));
    assert.ok(result.ok);
    assert.equal(result.value, undefined);

    const whitespace = await readJsonBody(fakeRequest(['  \n ']));
    assert.ok(whitespace.ok);
    assert.equal(whitespace.value, undefined);
  });

  it('returns 400 for malformed JSON', async () => {
    const result = await readJsonBody(fakeRequest(['{"url":']));
    assert.ok(!result.ok);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'BODY_INVALID_JSON');
  });

  it('never echoes the caller input in the error message', async () => {
    const result = await readJsonBody(fakeRequest(['{"secret":"hunter2"']));
    assert.ok(!result.ok);
    assert.ok(!result.message.includes('hunter2'));
  });

  it('passes an oversized body straight through as 413', async () => {
    const result = await readJsonBody(fakeRequest([Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)]));
    assert.ok(!result.ok);
    assert.equal(result.status, 413);
  });

  it('parses a JSON value that is not an object, leaving validation to callers', async () => {
    const result = await readJsonBody(fakeRequest(['"just a string"']));
    assert.ok(result.ok);
    assert.equal(result.value, 'just a string');
  });
});
