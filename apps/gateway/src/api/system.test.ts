import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  test('includes staged-package, upgrade-cancel, uninstall and staged-package-resume', async () => {
    const response = await handleSystemApiRequest(
      new Request('http://localhost/api/system/info'),
      '/api/system/info'
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { upgradeCapabilities?: string[] };
    expect(body.upgradeCapabilities).toEqual([
      'staged-package',
      'upgrade-cancel',
      'uninstall',
      'staged-package-resume',
    ]);
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

describe('GET/PUT /api/system/upgrade/package 断点续传', () => {
  const installDirs: string[] = [];
  const originalInstallDir = process.env.TMEX_INSTALL_DIR;

  afterEach(() => {
    upgradeController.resetForTests();
    if (originalInstallDir === undefined) delete process.env.TMEX_INSTALL_DIR;
    else process.env.TMEX_INSTALL_DIR = originalInstallDir;
    for (const dir of installDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function installDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tmex-api-resume-'));
    installDirs.push(dir);
    writeFileSync(join(dir, 'install-meta.json'), '{}');
    process.env.TMEX_INSTALL_DIR = dir;
    return dir;
  }

  /** `declared` 模拟推送端声明的剩余长度：链路半路断掉时它大于实际收到的字节数。 */
  function put(
    version: string,
    sha256: string,
    body: Uint8Array,
    opts?: { offset?: number; declared?: number }
  ): Request {
    const query = opts?.offset === undefined ? '' : `&offset=${opts.offset}`;
    return withMeshAuth(
      new Request(
        `http://localhost/api/system/upgrade/package?version=${version}&sha256=${sha256}${query}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(opts?.declared ?? body.byteLength),
          },
          body: bytesStream(body),
        }
      )
    );
  }

  function statusRequest(version: string, sha256: string): Request {
    return withMeshAuth(
      new Request(`http://localhost/api/system/upgrade/package?version=${version}&sha256=${sha256}`)
    );
  }

  test('GET 报已收字节数，PUT 带 offset 续写后 complete', async () => {
    const dir = installDir();
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      const bytes = new Uint8Array(64).fill(3);
      const hex = sha256Hex(bytes);
      const empty = await handleSystemApiRequest(
        statusRequest('1.2.3', hex),
        '/api/system/upgrade/package'
      );
      expect(empty?.status).toBe(200);
      expect(await empty?.json()).toEqual({
        version: '1.2.3',
        sha256: hex,
        receivedBytes: 0,
        complete: false,
      });

      const partial = await handleSystemApiRequest(
        put('1.2.3', hex, bytes.subarray(0, 20), { declared: 64 }),
        '/api/system/upgrade/package'
      );
      expect(partial?.status).toBe(500);
      expect(await partial?.json()).toEqual({ code: 'PACKAGE_INCOMPLETE', receivedBytes: 20 });

      const offsetRes = await handleSystemApiRequest(
        statusRequest('1.2.3', hex),
        '/api/system/upgrade/package'
      );
      expect(await offsetRes?.json()).toMatchObject({ receivedBytes: 20, complete: false });

      const rest = await handleSystemApiRequest(
        put('1.2.3', hex, bytes.subarray(20), { offset: 20 }),
        '/api/system/upgrade/package'
      );
      expect(rest?.status).toBe(200);
      expect(await rest?.json()).toEqual({ version: '1.2.3', sha256: hex, bytes: 64 });

      const done = await handleSystemApiRequest(
        statusRequest('1.2.3', hex),
        '/api/system/upgrade/package'
      );
      expect(await done?.json()).toMatchObject({ receivedBytes: 64, complete: true });
      expect(existsSync(join(dir, 'staging', 'staged', 'tmex-cli-1.2.3.tgz'))).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('整长度 .part 未提交：无请求体的收尾 PUT 校验 sha 并落正式包与 sidecar', async () => {
    const dir = installDir();
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      const bytes = new Uint8Array(64).fill(7);
      const hex = sha256Hex(bytes);
      // 声明 65 字节却只收到 64：`.part` 写满但没提交
      const partial = await handleSystemApiRequest(
        put('1.2.3', hex, bytes, { declared: 65 }),
        '/api/system/upgrade/package'
      );
      expect(partial?.status).toBe(500);
      expect(await partial?.json()).toEqual({ code: 'PACKAGE_INCOMPLETE', receivedBytes: 64 });
      const stale = await handleSystemApiRequest(
        statusRequest('1.2.3', hex),
        '/api/system/upgrade/package'
      );
      expect(await stale?.json()).toMatchObject({ receivedBytes: 64, complete: false });

      const finalize = await handleSystemApiRequest(
        withMeshAuth(
          new Request(
            `http://localhost/api/system/upgrade/package?version=1.2.3&sha256=${hex}&offset=64`,
            {
              method: 'PUT',
              headers: {
                'content-type': 'application/octet-stream',
                'content-length': '0',
              },
            }
          )
        ),
        '/api/system/upgrade/package'
      );
      expect(finalize?.status).toBe(200);
      expect(await finalize?.json()).toEqual({ version: '1.2.3', sha256: hex, bytes: 64 });
      const done = await handleSystemApiRequest(
        statusRequest('1.2.3', hex),
        '/api/system/upgrade/package'
      );
      expect(await done?.json()).toMatchObject({ receivedBytes: 64, complete: true });
      expect(existsSync(join(dir, 'staging', 'staged', 'tmex-cli-1.2.3.tgz'))).toBe(true);
      expect(existsSync(join(dir, 'staging', 'staged', 'tmex-cli-1.2.3.json'))).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('offset 对不上是 409 UPGRADE_OFFSET_MISMATCH，回包带真实偏移', async () => {
    installDir();
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      const bytes = new Uint8Array(64).fill(5);
      const hex = sha256Hex(bytes);
      await handleSystemApiRequest(
        put('1.2.3', hex, bytes.subarray(0, 10), { declared: 64 }),
        '/api/system/upgrade/package'
      );
      const bad = await handleSystemApiRequest(
        put('1.2.3', hex, bytes.subarray(50), { offset: 50 }),
        '/api/system/upgrade/package'
      );
      expect(bad?.status).toBe(409);
      expect(await bad?.json()).toEqual({ code: 'UPGRADE_OFFSET_MISMATCH', receivedBytes: 10 });
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('GET 未登录是 403 staged_requires_auth', async () => {
    installDir();
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      const res = await handleSystemApiRequest(
        new Request(
          `http://localhost/api/system/upgrade/package?version=1.2.3&sha256=${'ab'.repeat(32)}`
        ),
        '/api/system/upgrade/package'
      );
      expect(res?.status).toBe(403);
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('GET 版本 / sha256 非法是 400', async () => {
    installDir();
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(selfUpdateInfo());
    try {
      const res = await handleSystemApiRequest(
        statusRequest('latest', 'ab'.repeat(32)),
        '/api/system/upgrade/package'
      );
      expect(res?.status).toBe(400);
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

  test('GET and POST without a user session are 401', async () => {
    const getRes = await handleSystemApiRequest(
      new Request('http://localhost/api/system/uninstall'),
      '/api/system/uninstall'
    );
    expect(getRes?.status).toBe(401);
    expect(await getRes?.json()).toEqual({ code: 'UNAUTHORIZED' });
    const postRes = await handleSystemApiRequest(
      new Request('http://localhost/api/system/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'full' }),
      }),
      '/api/system/uninstall'
    );
    expect(postRes?.status).toBe(401);
    expect(await postRes?.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  test('GET returns idle status', async () => {
    const response = await handleSystemApiRequest(
      withMeshAuth(new Request('http://localhost/api/system/uninstall')),
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
      withMeshAuth(
        new Request('http://localhost/api/system/uninstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'partial' }),
        })
      ),
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
      const infoLines: string[] = [];
      const originalInfo = console.info;
      console.info = (...args: unknown[]) => {
        infoLines.push(args.map(String).join(' '));
      };
      let response: Response | Promise<Response> | undefined;
      try {
        response = await handleSystemApiRequest(
          withMeshAuth(
            new Request('http://localhost/api/system/uninstall', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mode: 'full' }),
            })
          ),
          '/api/system/uninstall'
        );
      } finally {
        console.info = originalInfo;
      }
      expect(response?.status).toBe(202);
      expect(spawned[0]?.slice(1, 4)).toEqual(['uninstall', '--yes', '--purge']);
      expect(
        infoLines.some((line) =>
          line.includes('[system] uninstall requested via=entry-node user=user-1')
        )
      ).toBe(true);
      const status = await handleSystemApiRequest(
        withMeshAuth(new Request('http://localhost/api/system/uninstall')),
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
