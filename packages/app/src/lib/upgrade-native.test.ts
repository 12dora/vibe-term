import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableDirect } from '../commands/direct';
import { sha256Hex } from './artifacts-manifest';
import { pathExists } from './fs-utils';
import { createVersionLayout } from './install-layout';
import { nativeAddonPath, nativeManifestPath } from './native-datachannel';
import {
  NATIVE_ADDON_FILENAME,
  NATIVE_DATACHANNEL_VERSION,
  type NativePin,
} from './native-manifest';
import { integrityOf, packNpmTarball } from './native-tarball';
import { ensureCandidateNativeAddon } from './upgrade-native';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

async function serveTarball(bytes: Uint8Array): Promise<{ url: string; stop: () => void }> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(bytes, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/addon.tgz`,
    stop: () => server.stop(true),
  };
}

describe('ensureCandidateNativeAddon', () => {
  test('installs the pinned addon into the candidate dir with the real enableDirect path', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-native-up-'));
    tempDirs.push(installDir);
    const fromLayout = createVersionLayout(installDir, '1.1.3');
    await mkdir(fromLayout.nativeDir, { recursive: true });
    await writeFile(nativeAddonPath(fromLayout.nativeDir), 'old-addon');
    await writeFile(
      nativeManifestPath(fromLayout.nativeDir),
      JSON.stringify({
        platform: 'darwin-arm64',
        version: '0.0.1',
        sha256: sha256Hex('old-addon'),
        napiVersion: 8,
      })
    );
    await mkdir(join(installDir, 'versions', '1.1.4'), { recursive: true });

    const addon = Buffer.from('candidate-native-addon');
    const tarball = packNpmTarball({
      'package/package.json': Buffer.from('{}'),
      [`package/${NATIVE_ADDON_FILENAME}`]: addon,
    });
    const served = await serveTarball(tarball);
    try {
      await ensureCandidateNativeAddon({
        installDir,
        fromVersion: '1.1.3',
        toVersion: '1.1.4',
        enableDirect: (options) =>
          enableDirect({
            ...options,
            pin: fakePin(served.url, integrityOf(tarball)),
          }),
      });
      const dest = nativeAddonPath(createVersionLayout(installDir, '1.1.4').nativeDir);
      expect(await pathExists(dest)).toBe(true);
      expect(sha256Hex(await readFile(dest))).toBe(sha256Hex(addon));
    } finally {
      served.stop();
    }
  });

  test('aborts when native install fails unless allow-missing-native', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-native-fail-'));
    tempDirs.push(installDir);
    const fromLayout = createVersionLayout(installDir, '1.0.0');
    await mkdir(fromLayout.nativeDir, { recursive: true });
    await writeFile(
      nativeManifestPath(fromLayout.nativeDir),
      JSON.stringify({
        platform: 'darwin-arm64',
        version: '0.0.1',
        sha256: 'abc',
        napiVersion: 8,
      })
    );
    await expect(
      ensureCandidateNativeAddon({
        installDir,
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        enableDirect: async () => ({ ok: false, reason: 'download failed' }),
      })
    ).rejects.toThrow(/download failed/);

    await ensureCandidateNativeAddon({
      installDir,
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      allowMissingNative: true,
      enableDirect: async () => ({ ok: false, reason: 'download failed' }),
    });
  });

  test('is a no-op when the current version has no native manifest', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-native-skip-'));
    tempDirs.push(installDir);
    let called = false;
    await ensureCandidateNativeAddon({
      installDir,
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      enableDirect: async () => {
        called = true;
        return { ok: true, platformId: 'x', version: '1', addonPath: 'y' };
      },
    });
    expect(called).toBe(false);
  });
});
