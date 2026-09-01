import { describe, expect, test } from 'bun:test';
import { handleManagedSystemApiRequest } from './system-managed';

describe('managed system API', () => {
  for (const [method, path] of [
    ['GET', '/api/system/update-check'],
    ['POST', '/api/system/upgrade'],
    ['DELETE', '/api/system/upgrade'],
    ['PUT', '/api/system/upgrade/package'],
    ['DELETE', '/api/system/upgrade/package'],
  ] as const) {
    test(`${method} ${path} 始终拒绝进程内自更新`, async () => {
      const response = handleManagedSystemApiRequest(
        new Request(`http://localhost${path}`, { method }),
        path
      );

      expect(response?.status).toBe(403);
      expect(await response?.json()).toEqual({
        error: 'managed_externally',
        managed: true,
        canSelfUpdate: false,
      });
    });
  }

  test('不接管未知 system route', () => {
    const response = handleManagedSystemApiRequest(
      new Request('http://localhost/api/system/unknown'),
      '/api/system/unknown'
    );
    expect(response).toBeUndefined();
  });
});
