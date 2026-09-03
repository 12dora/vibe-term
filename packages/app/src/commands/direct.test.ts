import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../lib/artifacts-manifest';
import type { FetchLike } from '../lib/fetch-like';
import { pathExists } from '../lib/fs-utils';
import { createInstallLayout } from '../lib/install-layout';
import {
  type InstalledNativeManifest,
  nativeAddonPath,
  nativeManifestPath,
} from '../lib/native-datachannel';
import {
  NATIVE_ADDON_FILENAME,
  NATIVE_DATACHANNEL_VERSION,
  type NativePin,
} from '../lib/native-manifest';
import { integrityOf, packNpmTarball } from '../lib/native-tarball';
import type { ParsedArgs } from '../types';
import {
  disableDirect,
  enableDirect,
  promoteNativeDirectory,
  reenableDirectIfNeeded,
  runDirect,
  shouldEnableDirectForRoles,
} from './direct';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeInstallDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tmex-direct-'));
  tempDirs.push(dir);
  return dir;
}

function fakePin(tarballUrl: string, integrity: string): NativePin {
  return {
    platformId: 'darwin-arm64',
    npmPackage: '@node-datachannel/darwin-arm64',
    version: NATIVE_DATACHANNEL_VERSION,
    tarballUrl,
    addonPath: `package/${NATIVE_ADDON_FILENAME}`,
    integrity,
    napiVersion: 8,
  };
}

async function leftoverStaging(installDir: string): Promise<string[]> {
  const names = await readdir(installDir);
  return names.filter((name) => name.startsWith('native.tmp-'));
}

async function leftoverBackup(installDir: string): Promise<string[]> {
  const names = await readdir(installDir);
  return names.filter((name) => name.startsWith('native.bak-'));
}

async function serveTarball(bytes: Uint8Array): Promise<{ url: string; stop: () => void }> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(new Uint8Array(bytes), {
        headers: { 'content-type': 'application/octet-stream' },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/addon.tgz`,
    stop: () => server.stop(true),
  };
}

describe('shouldEnableDirectForRoles', () => {
  test('node and hub,node enable by default; standalone does not', () => {
    expect(shouldEnableDirectForRoles('node')).toBe(true);
    expect(shouldEnableDirectForRoles('hub,node')).toBe(true);
    expect(shouldEnableDirectForRoles(['hub', 'node'])).toBe(true);
    expect(shouldEnableDirectForRoles('standalone')).toBe(false);
    expect(shouldEnableDirectForRoles('hub')).toBe(false);
  });
});

describe('enableDirect / disableDirect', () => {
  test('rejects integrity mismatch and does not write native files', async () => {
    const installDir = await makeInstallDir();
    const addon = Buffer.from('fake-addon-mismatch');
    const tarball = packNpmTarball({
      'package/package.json': Buffer.from('{"name":"@node-datachannel/darwin-arm64"}'),
      [`package/${NATIVE_ADDON_FILENAME}`]: addon,
    });
    const served = await serveTarball(tarball);
    try {
      const result = await enableDirect({
        installDir,
        pin: fakePin(
          served.url,
          'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
        ),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('integrity');
        expect(result.reason.toLowerCase()).toContain('integrity');
      }
      const layout = createInstallLayout(installDir);
      expect(await pathExists(nativeAddonPath(layout.nativeDir))).toBe(false);
      expect(await pathExists(nativeManifestPath(layout.nativeDir))).toBe(false);
      expect(await leftoverStaging(installDir)).toEqual([]);
    } finally {
      served.stop();
    }
  });

  test('success writes addon and manifest.json', async () => {
    const installDir = await makeInstallDir();
    const addon = Buffer.from('fake-addon-success-bytes');
    const tarball = packNpmTarball({
      'package/package.json': Buffer.from('{"name":"@node-datachannel/darwin-arm64"}'),
      [`package/${NATIVE_ADDON_FILENAME}`]: addon,
    });
    const served = await serveTarball(tarball);
    try {
      const result = await enableDirect({
        installDir,
        pin: fakePin(served.url, integrityOf(tarball)),
      });
      expect(result.ok).toBe(true);
      const layout = createInstallLayout(installDir);
      const written = await readFile(nativeAddonPath(layout.nativeDir));
      expect(Buffer.from(written).equals(addon)).toBe(true);
      const manifest = JSON.parse(
        await readFile(nativeManifestPath(layout.nativeDir), 'utf8')
      ) as InstalledNativeManifest;
      expect(manifest.platform).toBe('darwin-arm64');
      expect(manifest.version).toBe('0.33.1');
      expect(manifest.sha256).toBe(sha256Hex(addon));
      expect(manifest.napiVersion).toBe(8);
      expect(await leftoverStaging(installDir)).toEqual([]);
      expect(await leftoverBackup(installDir)).toEqual([]);
    } finally {
      served.stop();
    }
  });

  test('disable removes native/', async () => {
    const installDir = await makeInstallDir();
    const layout = createInstallLayout(installDir);
    await mkdir(layout.nativeDir, { recursive: true });
    await writeFile(nativeAddonPath(layout.nativeDir), 'x');
    await writeFile(nativeManifestPath(layout.nativeDir), '{}');

    await disableDirect({ installDir });
    expect(await pathExists(layout.nativeDir)).toBe(false);
  });

  test('writes addon and verifies sha256 using node fs (fetchImpl, no Bun.serve)', async () => {
    const installDir = await makeInstallDir();
    const addon = Buffer.from('node-portable-addon-bytes');
    const tarball = packNpmTarball({
      'package/package.json': Buffer.from('{}'),
      [`package/${NATIVE_ADDON_FILENAME}`]: addon,
    });
    const result = await enableDirect({
      installDir,
      pin: fakePin('https://example.test/addon.tgz', integrityOf(tarball)),
      fetchImpl: async () => new Response(new Uint8Array(tarball)),
    });
    expect(result.ok).toBe(true);
    const layout = createInstallLayout(installDir);
    const written = await readFile(nativeAddonPath(layout.nativeDir));
    expect(Buffer.from(written).equals(addon)).toBe(true);
    const manifest = JSON.parse(
      await readFile(nativeManifestPath(layout.nativeDir), 'utf8')
    ) as InstalledNativeManifest;
    expect(manifest.sha256).toBe(sha256Hex(addon));
    expect(manifest.sha256).toBe(sha256Hex(written));
  });

  test('skips with unsupported when the platform has no native pin', async () => {
    const installDir = await makeInstallDir();
    const result = await enableDirect({
      installDir,
      platform: 'win32',
      arch: 'x64',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unsupported');
      expect(result.unsupported).toBe(true);
      expect(result.reason.toLowerCase()).toContain('not supported');
    }
    const layout = createInstallLayout(installDir);
    expect(await pathExists(nativeAddonPath(layout.nativeDir))).toBe(false);
  });

  test('HTTP download failure is kind download and leaves no native/', async () => {
    const installDir = await makeInstallDir();
    const result = await enableDirect({
      installDir,
      pin: fakePin('https://example.test/missing.tgz', 'sha512-unused'),
      fetchImpl: async () => new Response('nope', { status: 503 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('download');
      expect(result.reason).toContain('HTTP 503');
    }
    expect(await pathExists(createInstallLayout(installDir).nativeDir)).toBe(false);
    expect(await leftoverStaging(installDir)).toEqual([]);
  });

  test('abort cancels fetch/body and leaves no native/ or staging dir', async () => {
    const installDir = await makeInstallDir();
    const controller = new AbortController();
    let fetchSawAborted = false;
    const fetchImpl: FetchLike = async (_url, init) => {
      const signal = init?.signal;
      await new Promise<void>((_resolve, reject) => {
        const fail = () => {
          fetchSawAborted = signal?.aborted === true;
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener('abort', fail, { once: true });
      });
      throw new Error('unreachable');
    };
    const pending = enableDirect({
      installDir,
      pin: fakePin('https://example.test/addon.tgz', 'sha512-unused'),
      fetchImpl,
      signal: controller.signal,
    });
    await Bun.sleep(20);
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('download');
    }
    expect(fetchSawAborted).toBe(true);
    expect(await pathExists(createInstallLayout(installDir).nativeDir)).toBe(false);
    expect(await leftoverStaging(installDir)).toEqual([]);
  });

  test('missing addon in tarball is kind install and does not leave staging', async () => {
    const installDir = await makeInstallDir();
    const tarball = packNpmTarball({
      'package/package.json': Buffer.from('{}'),
    });
    const result = await enableDirect({
      installDir,
      pin: fakePin('https://example.test/addon.tgz', integrityOf(tarball)),
      fetchImpl: async () => new Response(new Uint8Array(tarball)),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('install');
      expect(result.reason).toContain('not found');
    }
    expect(await pathExists(createInstallLayout(installDir).nativeDir)).toBe(false);
    expect(await leftoverStaging(installDir)).toEqual([]);
  });

  test('replaces an existing native/ via staging rename', async () => {
    const installDir = await makeInstallDir();
    const layout = createInstallLayout(installDir);
    await mkdir(layout.nativeDir, { recursive: true });
    await writeFile(nativeAddonPath(layout.nativeDir), 'old-addon');
    await writeFile(nativeManifestPath(layout.nativeDir), '{"version":"old"}');

    const addon = Buffer.from('replacement-addon-bytes');
    const tarball = packNpmTarball({
      'package/package.json': Buffer.from('{}'),
      [`package/${NATIVE_ADDON_FILENAME}`]: addon,
    });
    const result = await enableDirect({
      installDir,
      pin: fakePin('https://example.test/addon.tgz', integrityOf(tarball)),
      fetchImpl: async () => new Response(new Uint8Array(tarball)),
    });
    expect(result.ok).toBe(true);
    expect(Buffer.from(await readFile(nativeAddonPath(layout.nativeDir))).equals(addon)).toBe(true);
    expect(await leftoverStaging(installDir)).toEqual([]);
    expect(await leftoverBackup(installDir)).toEqual([]);
  });

  test('promotion failure keeps the old addon', async () => {
    const installDir = await makeInstallDir();
    const layout = createInstallLayout(installDir);
    await mkdir(layout.nativeDir, { recursive: true });
    await writeFile(nativeAddonPath(layout.nativeDir), 'old-addon');
    const missingStaging = join(installDir, 'native.tmp-missing');
    const backupDir = join(installDir, `native.bak-${process.pid}`);
    await expect(
      promoteNativeDirectory(missingStaging, layout.nativeDir, backupDir)
    ).rejects.toThrow();
    expect(await readFile(nativeAddonPath(layout.nativeDir), 'utf8')).toBe('old-addon');
    expect(await leftoverBackup(installDir)).toEqual([]);
  });
});

describe('reenableDirectIfNeeded', () => {
  test('skips when installed version already matches the pin', async () => {
    const installDir = await makeInstallDir();
    const layout = createInstallLayout(installDir);
    await mkdir(layout.nativeDir, { recursive: true });
    const addon = Buffer.from('current-addon');
    await writeFile(nativeAddonPath(layout.nativeDir), addon);
    await writeFile(
      nativeManifestPath(layout.nativeDir),
      JSON.stringify({
        platform: 'darwin-arm64',
        version: NATIVE_DATACHANNEL_VERSION,
        sha256: sha256Hex(addon),
        napiVersion: 8,
      })
    );
    const result = await reenableDirectIfNeeded({
      installDir,
      pin: fakePin('http://127.0.0.1:1/not-used.tgz', 'sha512-unused'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skipped).toBe(true);
    }
    expect(await readFile(nativeAddonPath(layout.nativeDir), 'utf8')).toBe('current-addon');
  });

  test('skips when native is absent', async () => {
    const installDir = await makeInstallDir();
    const result = await reenableDirectIfNeeded({ installDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skipped).toBe(true);
    }
  });

  test('re-downloads when installed version differs from pin', async () => {
    const installDir = await makeInstallDir();
    const layout = createInstallLayout(installDir);
    await mkdir(layout.nativeDir, { recursive: true });
    await writeFile(nativeAddonPath(layout.nativeDir), 'old');
    await writeFile(
      nativeManifestPath(layout.nativeDir),
      JSON.stringify({
        platform: 'darwin-arm64',
        version: '0.0.1',
        sha256: sha256Hex('old'),
        napiVersion: 8,
      })
    );

    const addon = Buffer.from('upgraded-addon');
    const tarball = packNpmTarball({
      'package/package.json': Buffer.from('{}'),
      [`package/${NATIVE_ADDON_FILENAME}`]: addon,
    });
    const served = await serveTarball(tarball);
    try {
      const result = await reenableDirectIfNeeded({
        installDir,
        pin: fakePin(served.url, integrityOf(tarball)),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.skipped).not.toBe(true);
      }
      expect(sha256Hex(await readFile(nativeAddonPath(layout.nativeDir)))).toBe(sha256Hex(addon));
    } finally {
      served.stop();
    }
  });
});

describe('runDirect', () => {
  test('enable then disable via CLI args', async () => {
    const installDir = await makeInstallDir();
    const addon = Buffer.from('cli-addon');
    const tarball = packNpmTarball({
      'package/package.json': Buffer.from('{}'),
      [`package/${NATIVE_ADDON_FILENAME}`]: addon,
    });
    const served = await serveTarball(tarball);
    const pin = fakePin(served.url, integrityOf(tarball));
    try {
      const enableArgs: ParsedArgs = {
        command: 'direct',
        positionals: ['enable'],
        flags: { 'install-dir': installDir },
      };
      await runDirect(enableArgs, { pin });
      const layout = createInstallLayout(installDir);
      expect(await pathExists(nativeAddonPath(layout.nativeDir))).toBe(true);

      const disableArgs: ParsedArgs = {
        command: 'direct',
        positionals: ['disable'],
        flags: { 'install-dir': installDir },
      };
      await runDirect(disableArgs);
      expect(await pathExists(layout.nativeDir)).toBe(false);
    } finally {
      served.stop();
    }
  });

  test('enable exits non-zero when download fails (not platform-unsupported)', async () => {
    const installDir = await makeInstallDir();
    process.exitCode = 0;
    try {
      const enableArgs: ParsedArgs = {
        command: 'direct',
        positionals: ['enable'],
        flags: { 'install-dir': installDir },
      };
      await runDirect(enableArgs, {
        pin: fakePin('https://example.test/missing.tgz', 'sha512-unused'),
        fetchImpl: async () => new Response('nope', { status: 503 }),
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
    }
  });

  test('enable skips with exit 0 when the platform is unsupported', async () => {
    const installDir = await makeInstallDir();
    process.exitCode = 0;
    try {
      const enableArgs: ParsedArgs = {
        command: 'direct',
        positionals: ['enable'],
        flags: { 'install-dir': installDir },
      };
      await runDirect(enableArgs, { pin: null });
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.exitCode = 0;
    }
  });
});
