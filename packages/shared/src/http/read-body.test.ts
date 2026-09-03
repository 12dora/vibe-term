import { describe, expect, test } from 'bun:test';
import {
  JSON_BODY_MAX_BYTES,
  readBodyCapped,
  readBodyCappedResult,
  readJsonObjectBody,
} from './read-body';

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

describe('readBodyCappedResult', () => {
  test('returns ok bytes when the body is exactly at the limit', async () => {
    const payload = new Uint8Array(16).fill(7);
    const got = await readBodyCappedResult(
      new Request('http://127.0.0.1/', {
        method: 'POST',
        headers: { 'content-length': '16' },
        body: payload,
      }),
      16
    );
    expect(got).toEqual({ ok: true, bytes: payload });
  });

  test('returns ok:false when content-length exceeds the limit', async () => {
    const req = jsonRequest('ok', {
      'content-length': String(JSON_BODY_MAX_BYTES + 1),
    });
    expect(await readBodyCappedResult(req, JSON_BODY_MAX_BYTES)).toEqual({ ok: false });
  });

  test('returns ok:false and cancels when streamed chunks exceed the limit', async () => {
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
    expect(await readBodyCappedResult(req, 15)).toEqual({ ok: false });
    expect(cancelled).toBe(true);
  });

  test('matches readBodyCapped under, at, and over the limit', async () => {
    const under = new Uint8Array(8).fill(1);
    const at = new Uint8Array(16).fill(2);
    const over = new Uint8Array(17).fill(3);
    const make = (bytes: Uint8Array<ArrayBuffer>) =>
      new Request('http://127.0.0.1/', { method: 'POST', body: bytes });

    const underCapped = await readBodyCapped(make(under), 16);
    const underResult = await readBodyCappedResult(make(under), 16);
    expect(underCapped).toEqual(under);
    expect(underResult).toEqual({ ok: true, bytes: under });

    const atCapped = await readBodyCapped(make(at), 16);
    const atResult = await readBodyCappedResult(make(at), 16);
    expect(atCapped).toEqual(at);
    expect(atResult).toEqual({ ok: true, bytes: at });

    expect(await readBodyCapped(make(over), 16)).toBeNull();
    expect(await readBodyCappedResult(make(over), 16)).toEqual({ ok: false });
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
