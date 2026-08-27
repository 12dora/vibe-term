import { describe, expect, test } from 'bun:test';
import { bootMesh, dummyServer } from './auth-routes.test';

describe('mesh-http', () => {
  test('standalone localUiGuard always passes', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false } });
    try {
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/api/devices'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/login'))).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('localUiGuard 401 JSON for /api/*; static and /login pass', async () => {
    const mesh = await bootMesh();
    try {
      const api = mesh.runtime.localUiGuard(new Request('http://localhost/api/devices'));
      expect(api?.status).toBe(401);
      expect(await api?.json()).toEqual({ code: 'UNAUTHORIZED' });

      expect(mesh.runtime.localUiGuard(new Request('http://localhost/login'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/assets/app.js'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/favicon.ico'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/api/auth/mode'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/devices'))).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('unknown paths return null so assembler continues', async () => {
    const mesh = await bootMesh();
    try {
      const res = await mesh.runtime.handleRequest(
        new Request('http://localhost/api/devices'),
        dummyServer
      );
      expect(res).toBeNull();
    } finally {
      mesh.close();
    }
  });
});
