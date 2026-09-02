import { describe, expect, test } from 'bun:test';
import { JSON_BODY_MAX_BYTES, readJsonBody } from './http';

function jsonRequest(body: string, headers?: Record<string, string>): Request {
  return new Request('http://127.0.0.1/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

function streamRequest(chunks: string[], headers?: Record<string, string>): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Request('http://127.0.0.1/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('readJsonBody', () => {
  test('parses an object under the byte cap', async () => {
    const body = await readJsonBody(jsonRequest(JSON.stringify({ hello: 'world' })));
    expect(body).toEqual({ hello: 'world' });
  });

  test('returns null when content-length exceeds the cap', async () => {
    const req = jsonRequest(JSON.stringify({ ok: true }), {
      'content-length': String(JSON_BODY_MAX_BYTES + 1),
    });
    expect(await readJsonBody(req)).toBeNull();
    expect(
      await readJsonBody(jsonRequest('{"ok":true}', { 'content-length': '64' }), 16)
    ).toBeNull();
  });

  test('returns null when a chunked body exceeds the cap without content-length', async () => {
    const req = streamRequest(['{"k":"', 'aaaaaaaaaaaaaaaa', '"}']);
    expect(req.headers.get('content-length')).toBeNull();
    expect(await readJsonBody(req, 16)).toBeNull();
  });

  test('parses a chunked body that stays under the cap', async () => {
    const req = streamRequest(['{"k":', '"v"}']);
    expect(req.headers.get('content-length')).toBeNull();
    expect(await readJsonBody(req, 16)).toEqual({ k: 'v' });
  });

  test('returns null for malformed JSON', async () => {
    expect(await readJsonBody(jsonRequest('{'))).toBeNull();
    expect(await readJsonBody(jsonRequest('not-json'))).toBeNull();
  });

  test('returns null for a JSON array', async () => {
    expect(await readJsonBody(jsonRequest('[1,2]'))).toBeNull();
  });
});
