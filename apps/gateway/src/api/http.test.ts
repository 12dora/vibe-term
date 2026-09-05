import { describe, expect, test } from 'bun:test';
import { readJsonObjectBody } from './http';

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

describe('readJsonObjectBody', () => {
  test('parses an object under the byte cap', async () => {
    const body = await readJsonObjectBody(jsonRequest(JSON.stringify({ hello: 'world' })));
    expect(body).toEqual({ hello: 'world' });
  });

  test('parses a chunked body that stays under the cap', async () => {
    const req = streamRequest(['{"k":', '"v"}']);
    expect(req.headers.get('content-length')).toBeNull();
    expect(await readJsonObjectBody(req, 16)).toEqual({ k: 'v' });
  });

  test('returns null for malformed JSON', async () => {
    expect(await readJsonObjectBody(jsonRequest('{'))).toBeNull();
    expect(await readJsonObjectBody(jsonRequest('not-json'))).toBeNull();
  });
});
