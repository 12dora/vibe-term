import { describe, expect, test } from 'bun:test';
import { t } from '../i18n';
import { filesRoutes } from './files';
import { dispatchRoutes } from './route';

function dispatch(method: string, path: string, body?: unknown) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const pathname = new URL(req.url).pathname;
  return dispatchRoutes(req, pathname, filesRoutes, { server: {} as never, path: pathname });
}

function dispatchRaw(method: string, path: string, body?: BodyInit) {
  const req = new Request(`http://localhost${path}`, { method, body });
  const pathname = new URL(req.url).pathname;
  return dispatchRoutes(req, pathname, filesRoutes, { server: {} as never, path: pathname });
}

async function expectInvalidRequest(response: Response | Promise<Response> | undefined) {
  expect(response).toBeInstanceOf(Response);
  const res = response as Response;
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: t('apiError.invalidRequest') });
}

describe('POST /api/files/upload/init size validation', () => {
  test('rejects fractional size so received (integer) can ever equal size', async () => {
    await expectInvalidRequest(
      await dispatch('POST', '/api/files/upload/init', {
        rootId: 'any-root',
        path: '/tmp',
        name: 'a.bin',
        size: 1.5,
      })
    );
  });
});

describe('PUT /api/files/upload/:id offset validation', () => {
  test('rejects trailing-garbage offset that parseInt would coerce (12garbage → 12)', async () => {
    await expectInvalidRequest(
      await dispatchRaw('PUT', '/api/files/upload/any-id?offset=12garbage', new Uint8Array([1]))
    );
  });

  test('rejects fractional offset that parseInt would truncate (12.5 → 12)', async () => {
    await expectInvalidRequest(
      await dispatchRaw('PUT', '/api/files/upload/any-id?offset=12.5', new Uint8Array([1]))
    );
  });

  test('rejects missing offset instead of treating empty string as 0', async () => {
    await expectInvalidRequest(
      await dispatchRaw('PUT', '/api/files/upload/any-id', new Uint8Array([1]))
    );
  });

  test('accepts an exact non-negative integer offset and then reports missing session', async () => {
    const response = await dispatchRaw(
      'PUT',
      '/api/files/upload/missing?offset=0',
      new Uint8Array([1])
    );
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', code: 'not_found' });
  });

  test('accepts decimal offset 12 and then reports missing session', async () => {
    const response = await dispatchRaw(
      'PUT',
      '/api/files/upload/missing?offset=12',
      new Uint8Array([1])
    );
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', code: 'not_found' });
  });

  for (const offset of [' ', '0x10', '1e2']) {
    test(`rejects offset ${JSON.stringify(offset)} that Number() would coerce`, async () => {
      await expectInvalidRequest(
        await dispatchRaw(
          'PUT',
          `/api/files/upload/any-id?offset=${encodeURIComponent(offset)}`,
          new Uint8Array([1])
        )
      );
    });
  }
});

describe('JSON object body validation', () => {
  test('POST /api/files/roots rejects JSON null instead of throwing on property access', async () => {
    await expectInvalidRequest(await dispatch('POST', '/api/files/roots', null));
  });

  test('POST /api/files/roots rejects a JSON array body', async () => {
    await expectInvalidRequest(await dispatch('POST', '/api/files/roots', []));
  });

  test('POST /api/files/upload/init rejects JSON null instead of throwing on property access', async () => {
    await expectInvalidRequest(await dispatch('POST', '/api/files/upload/init', null));
  });

  test('POST /api/files/upload/init rejects a JSON array body', async () => {
    await expectInvalidRequest(await dispatch('POST', '/api/files/upload/init', []));
  });

  test('POST /api/files/download/prepare emits NDJSON invalid on JSON null instead of throwing', async () => {
    const response = await dispatch('POST', '/api/files/download/prepare', null);
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(200);
    expect(JSON.parse((await res.text()).trim())).toEqual({ type: 'error', code: 'invalid' });
  });
});
