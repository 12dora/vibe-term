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

describe('POST /api/files/upload/init size validation', () => {
  test('rejects fractional size so received (integer) can ever equal size', async () => {
    const response = await dispatch('POST', '/api/files/upload/init', {
      rootId: 'any-root',
      path: '/tmp',
      name: 'a.bin',
      size: 1.5,
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    expect(await (response as Response).json()).toEqual({ error: t('apiError.invalidRequest') });
  });
});
