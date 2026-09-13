import { describe, expect, test } from 'bun:test';
import { readJsonBody } from './read-json-body';

function jsonRequest(body: unknown): Request {
  return new Request('http://127.0.0.1/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('readJsonBody', () => {
  test('parses JSON and returns the normalized value', async () => {
    const parsed = await readJsonBody(jsonRequest({ n: 1.9 }), (body: { n: number }) => ({
      n: Math.floor(body.n),
    }));
    expect(parsed).toEqual({ ok: true, value: { n: 1 } });
  });

  test('invalid JSON becomes 400 with the parser message', async () => {
    const parsed = await readJsonBody(jsonRequest('{'), (body: unknown) => body);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.response.status).toBe(400);
    const payload = (await parsed.response.json()) as { error: string };
    expect(payload.error.length).toBeGreaterThan(0);
  });

  test('normalize throw becomes 400 with the error message', async () => {
    const parsed = await readJsonBody(jsonRequest({}), () => {
      throw new Error('bad field');
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.response.status).toBe(400);
    expect(await parsed.response.json()).toEqual({ error: 'bad field' });
  });
});
