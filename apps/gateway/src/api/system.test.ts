import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SystemInfo } from '@tmex/shared';
import { requestDispatchContext } from '../mesh/types';
import * as infoPublic from '../system/info-public';
import { uninstallController } from '../system/uninstall';
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
  test('includes staged-package, upgrade-cancel and uninstall', async () => {
    const response = await handleSystemApiRequest(
      new Request('http://localhost/api/system/info'),
      '/api/system/info'
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { upgradeCapabilities?: string[] };
    expect(body.upgradeCapabilities).toEqual(['staged-package', 'upgrade-cancel', 'uninstall']);
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

describe('DELETE /api/system/upgrade', () => {
  afterEach(() => {
    upgradeController.resetForTests();
  });

  test('idle cancel is 409 UPGRADE_NOT_RUNNING with the idle status', async () => {
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      const response = await handleSystemApiRequest(
        new Request('http://localhost/api/system/upgrade', { method: 'DELETE' }),
        '/api/system/upgrade'
      );
      expect(response?.status).toBe(409);
      expect(await response?.json()).toEqual({
        code: 'UPGRADE_NOT_RUNNING',
        state: 'idle',
        targetVersion: null,
        error: null,
        startedAt: null,
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('successful cancel is 200 idle with error UPGRADE_CANCELLED', async () => {
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    const cancelSpy = spyOn(upgradeController, 'cancel').mockResolvedValue({
      ok: true,
      status: {
        state: 'idle',
        targetVersion: null,
        error: 'UPGRADE_CANCELLED',
        startedAt: '2026-09-01T00:00:00.000Z',
      },
    });
    try {
      const response = await handleSystemApiRequest(
        new Request('http://localhost/api/system/upgrade', { method: 'DELETE' }),
        '/api/system/upgrade'
      );
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({
        state: 'idle',
        targetVersion: null,
        error: 'UPGRADE_CANCELLED',
        startedAt: '2026-09-01T00:00:00.000Z',
      });
    } finally {
      cancelSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('executing cancel is 409 UPGRADE_NOT_CANCELLABLE', async () => {
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    const cancelSpy = spyOn(upgradeController, 'cancel').mockResolvedValue({
      ok: false,
      code: 'UPGRADE_NOT_CANCELLABLE',
      status: {
        state: 'executing',
        targetVersion: '9.9.9',
        error: null,
        startedAt: '2026-09-01T00:00:00.000Z',
      },
    });
    try {
      const response = await handleSystemApiRequest(
        new Request('http://localhost/api/system/upgrade', { method: 'DELETE' }),
        '/api/system/upgrade'
      );
      expect(response?.status).toBe(409);
      expect(await response?.json()).toEqual({
        code: 'UPGRADE_NOT_CANCELLABLE',
        state: 'executing',
        targetVersion: '9.9.9',
        error: null,
        startedAt: '2026-09-01T00:00:00.000Z',
      });
    } finally {
      cancelSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});

describe('DELETE /api/system/upgrade/package', () => {
  afterEach(() => {
    upgradeController.resetForTests();
  });

  test('open-mode DELETE package is 403 staged_requires_auth', async () => {
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      const response = await handleSystemApiRequest(
        new Request('http://localhost/api/system/upgrade/package?version=1.2.3', {
          method: 'DELETE',
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

  test('returns 404 when no package is staged for that version', async () => {
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      const response = await handleSystemApiRequest(
        withMeshAuth(
          new Request('http://localhost/api/system/upgrade/package?version=1.2.3', {
            method: 'DELETE',
          })
        ),
        '/api/system/upgrade/package'
      );
      expect(response?.status).toBe(404);
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('removes the staged tarball and sidecar', async () => {
    const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const installDir = mkdtempSync(join(tmpdir(), 'tmex-del-pkg-'));
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    const prevInstall = process.env.TMEX_INSTALL_DIR;
    process.env.TMEX_INSTALL_DIR = installDir;
    try {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const hex = sha256Hex(bytes);
      const staged = await upgradeController.stagePackage('1.2.3', hex, bytesStream(bytes));
      expect(staged.ok).toBe(true);
      const tgz = join(installDir, 'staging', 'staged', 'tmex-cli-1.2.3.tgz');
      const sidecar = join(installDir, 'staging', 'staged', 'tmex-cli-1.2.3.json');
      expect(existsSync(tgz)).toBe(true);
      const response = await handleSystemApiRequest(
        withMeshAuth(
          new Request('http://localhost/api/system/upgrade/package?version=1.2.3', {
            method: 'DELETE',
          })
        ),
        '/api/system/upgrade/package'
      );
      expect(response?.status).toBe(200);
      expect(existsSync(tgz)).toBe(false);
      expect(existsSync(sidecar)).toBe(false);
    } finally {
      infoSpy.mockRestore();
      if (prevInstall === undefined) delete process.env.TMEX_INSTALL_DIR;
      else process.env.TMEX_INSTALL_DIR = prevInstall;
      rmSync(installDir, { recursive: true, force: true });
    }
  });
});

describe('POST/GET /api/system/uninstall', () => {
  afterEach(() => {
    uninstallController.resetForTests();
  });

  test('GET returns idle status', async () => {
    const response = await handleSystemApiRequest(
      new Request('http://localhost/api/system/uninstall'),
      '/api/system/uninstall'
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      state: 'idle',
      startedAt: null,
      error: null,
    });
  });

  test('rejects mode other than full with 400', async () => {
    const response = await handleSystemApiRequest(
      new Request('http://localhost/api/system/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'partial' }),
      }),
      '/api/system/uninstall'
    );
    expect(response?.status).toBe(400);
  });

  test('POST schedules uninstall through the injected spawner', async () => {
    const installDir = mkdtempSync(join(tmpdir(), 'tmex-sys-uninst-'));
    const copyRoot = mkdtempSync(join(tmpdir(), 'tmex-sys-uninst-tmp-'));
    try {
      const versionDir = join(installDir, 'versions', '1.2.3');
      mkdirSync(join(versionDir, 'cli', 'bin'), { recursive: true });
      writeFileSync(join(versionDir, 'cli', 'bin', 'tmex.js'), '#!/usr/bin/env node\n');
      symlinkSync(versionDir, join(installDir, 'current'));
      const spawned: string[][] = [];
      uninstallController.setDepsForTests({
        getInstallInfo: () => ({
          installedViaCli: true,
          deployment: 'launchd',
          installDir,
          serviceName: 'tmex',
          cliVersion: '1.2.3',
          bunPath: process.execPath,
        }),
        tmpdir: () => copyRoot,
        randomId: () => 'feedface',
        spawn: (_cmd, args) => {
          spawned.push([...args]);
          const child = new EventEmitter() as EventEmitter & { unref: () => void };
          child.unref = () => undefined;
          queueMicrotask(() => child.emit('spawn'));
          return child as unknown as ChildProcess;
        },
      });
      const response = await handleSystemApiRequest(
        new Request('http://localhost/api/system/uninstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'full' }),
        }),
        '/api/system/uninstall'
      );
      expect(response?.status).toBe(202);
      expect(spawned[0]?.slice(1, 4)).toEqual(['uninstall', '--yes', '--purge']);
      const status = await handleSystemApiRequest(
        new Request('http://localhost/api/system/uninstall'),
        '/api/system/uninstall'
      );
      expect(status?.status).toBe(200);
      const body = (await status?.json()) as { state: string };
      expect(body.state).toBe('scheduled');
    } finally {
      rmSync(installDir, { recursive: true, force: true });
      rmSync(copyRoot, { recursive: true, force: true });
    }
  });
});
