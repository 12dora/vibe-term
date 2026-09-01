import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { SystemInfo } from '@tmex/shared';
import { requestDispatchContext } from '../mesh/types';
import * as infoPublic from '../system/info-public';
import { STAGED_PACKAGE_MAX_BYTES, upgradeController } from '../system/upgrade';
import { handleSystemApiRequest, isReleaseVersion } from './system';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function withMeshAuth(req: Request): Request {
  requestDispatchContext.set(req, { uid: 'user-1', viaNodeId: 'entry-node' });
  return req;
}

function selfUpdateInfo(): SystemInfo {
  return {
    version: '1.0.0',
    baseVersion: '1.0.0',
    isProd: true,
    installedViaCli: true,
    deployment: 'launchd',
    canSelfUpdate: true,
    serviceName: 'tmex',
    transferMaxBytes: 1,
  };
}

describe('isReleaseVersion', () => {
  test('accepts strict semver with optional prerelease', () => {
    expect(isReleaseVersion('1.2.3')).toBe(true);
    expect(isReleaseVersion('1.2.3-beta.1')).toBe(true);
    expect(isReleaseVersion('0.11.0')).toBe(true);
  });

  test('rejects latest, traversal, and non-semver strings', () => {
    expect(isReleaseVersion('latest')).toBe(false);
    expect(isReleaseVersion('../etc/passwd')).toBe(false);
    expect(isReleaseVersion('1.2')).toBe(false);
    expect(isReleaseVersion('1.2.3+build')).toBe(false);
    expect(isReleaseVersion('v1.2.3')).toBe(false);
    expect(isReleaseVersion('')).toBe(false);
  });
});

describe('POST /api/system/upgrade version validation', () => {
  test('rejects missing, latest, and non-semver versions with 400', async () => {
    for (const body of [{}, { version: '' }, { version: 'latest' }, { version: '../etc' }]) {
      const response = await handleSystemApiRequest(
        new Request('http://localhost/api/system/upgrade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        '/api/system/upgrade'
      );
      expect(response?.status).toBe(400);
    }
  });

  test('rejects source values other than release|staged with 400', async () => {
    const response = await handleSystemApiRequest(
      new Request('http://localhost/api/system/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '1.2.3', source: 'stage' }),
      }),
      '/api/system/upgrade'
    );
    expect(response?.status).toBe(400);
  });

  test('does not start upgrade for an invalid version', async () => {
    const response = await handleSystemApiRequest(
      new Request('http://localhost/api/system/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '1.2.3/../../../tmp' }),
      }),
      '/api/system/upgrade'
    );
    expect(response?.status).toBe(400);
    const payload = (await response?.json()) as { error?: string };
    expect(payload.error).toBeTruthy();
  });
});

describe('GET /api/system/info upgradeCapabilities', () => {
  test('includes staged-package', async () => {
    const response = await handleSystemApiRequest(
      new Request('http://localhost/api/system/info'),
      '/api/system/info'
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { upgradeCapabilities?: string[] };
    expect(body.upgradeCapabilities).toEqual(['staged-package']);
  });
});

describe('PUT /api/system/upgrade/package', () => {
  afterEach(() => {
    upgradeController.resetForTests();
  });

  test('rejects invalid version and sha256 with 400', async () => {
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      const bytes = new Uint8Array([1, 2, 3]);
      const hex = sha256Hex(bytes);
      for (const url of [
        'http://localhost/api/system/upgrade/package',
        `http://localhost/api/system/upgrade/package?version=latest&sha256=${hex}`,
        `http://localhost/api/system/upgrade/package?version=1.2.3&sha256=${'z'.repeat(64)}`,
        'http://localhost/api/system/upgrade/package?version=1.2.3&sha256=abcd',
      ]) {
        const response = await handleSystemApiRequest(
          withMeshAuth(
            new Request(url, {
              method: 'PUT',
              headers: { 'content-type': 'application/octet-stream' },
              body: bytesStream(bytes),
            })
          ),
          '/api/system/upgrade/package'
        );
        expect(response?.status).toBe(400);
      }
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('refuses when canSelfUpdate is false', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hex = sha256Hex(bytes);
    const response = await handleSystemApiRequest(
      withMeshAuth(
        new Request(`http://localhost/api/system/upgrade/package?version=1.2.3&sha256=${hex}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytesStream(bytes),
        })
      ),
      '/api/system/upgrade/package'
    );
    expect(response?.status).toBe(403);
  });

  test('open-mode standalone PUT is 403 staged_requires_auth', async () => {
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      const bytes = new Uint8Array([1, 2, 3]);
      const hex = sha256Hex(bytes);
      const response = await handleSystemApiRequest(
        new Request(`http://localhost/api/system/upgrade/package?version=1.2.3&sha256=${hex}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytesStream(bytes),
        }),
        '/api/system/upgrade/package'
      );
      expect(response?.status).toBe(403);
      expect(await response?.json()).toEqual({
        code: 'UPGRADE_NOT_ALLOWED',
        reason: 'staged_requires_auth',
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('rejects Content-Length above the package cap with 413 before reading the body', async () => {
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel() {
          cancelled = true;
        },
      });
      const hex = 'ab'.repeat(32);
      const response = await handleSystemApiRequest(
        withMeshAuth(
          new Request(`http://localhost/api/system/upgrade/package?version=1.2.3&sha256=${hex}`, {
            method: 'PUT',
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(STAGED_PACKAGE_MAX_BYTES + 1),
            },
            body,
          })
        ),
        '/api/system/upgrade/package'
      );
      expect(response?.status).toBe(413);
      expect(await response?.json()).toEqual({ code: 'PACKAGE_TOO_LARGE' });
      expect(cancelled).toBe(false);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('POST /api/system/upgrade source=staged', () => {
  afterEach(() => {
    upgradeController.resetForTests();
  });

  test('returns 409 PACKAGE_NOT_STAGED when no package is staged', async () => {
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      const response = await handleSystemApiRequest(
        withMeshAuth(
          new Request('http://localhost/api/system/upgrade', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ version: '9.9.9', source: 'staged' }),
          })
        ),
        '/api/system/upgrade'
      );
      expect(response?.status).toBe(409);
      expect(await response?.json()).toEqual({ code: 'PACKAGE_NOT_STAGED' });
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('open-mode standalone POST source=staged is 403 staged_requires_auth', async () => {
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      const response = await handleSystemApiRequest(
        new Request('http://localhost/api/system/upgrade', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: '9.9.9', source: 'staged' }),
        }),
        '/api/system/upgrade'
      );
      expect(response?.status).toBe(403);
      expect(await response?.json()).toEqual({
        code: 'UPGRADE_NOT_ALLOWED',
        reason: 'staged_requires_auth',
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('POST source=release in open-mode is not gated as staged_requires_auth', async () => {
    const response = await handleSystemApiRequest(
      new Request('http://localhost/api/system/upgrade', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: '9.9.9', source: 'release' }),
      }),
      '/api/system/upgrade'
    );
    expect(response?.status).toBe(403);
    const body = (await response?.json()) as { reason?: string; code?: string };
    expect(body.reason).not.toBe('staged_requires_auth');
  });
});
