import { describe, expect, test } from 'bun:test';
import { JSON_BODY_MAX_BYTES, readBodyCapped, readJsonObjectBody } from './read-body';

function jsonRequest(body: string, headers?: Record<string, string>): Request {
  return new Request('http://127.0.0.1/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('readBodyCapped', () => {
  test('returns bytes when the body is under the limit', async () => {
    const payload = new TextEncoder().encode('hello');
    const got = await readBodyCapped(jsonRequest('hello'), 16);
    expect(got).toEqual(payload);
  });

  test('returns bytes when the body is exactly at the limit', async () => {
    const payload = new Uint8Array(16).fill(7);
    const got = await readBodyCapped(
      new Request('http://127.0.0.1/', {
        method: 'POST',
        headers: { 'content-length': '16' },
        body: payload,
      }),
      16
    );
    expect(got).toEqual(payload);
  });

  test('returns null when content-length exceeds the limit', async () => {
    const req = jsonRequest('ok', {
      'content-length': String(JSON_BODY_MAX_BYTES + 1),
    });
    expect(await readBodyCapped(req, JSON_BODY_MAX_BYTES)).toBeNull();
  });

  test('cancels the reader when streamed chunks exceed the limit', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(10);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request('http://127.0.0.1/', { method: 'POST', body });
    expect(req.headers.get('content-length')).toBeNull();
    expect(await readBodyCapped(req, 15)).toBeNull();
    expect(cancelled).toBe(true);
  });
});

describe('readJsonObjectBody', () => {
  test('returns null for non-object JSON', async () => {
    expect(await readJsonObjectBody(jsonRequest('null'))).toBeNull();
    expect(await readJsonObjectBody(jsonRequest('[]'))).toBeNull();
    expect(await readJsonObjectBody(jsonRequest('[1,2]'))).toBeNull();
    expect(await readJsonObjectBody(jsonRequest('"str"'))).toBeNull();
    expect(await readJsonObjectBody(jsonRequest('1'))).toBeNull();
    expect(await readJsonObjectBody(jsonRequest('true'))).toBeNull();
  });
});
