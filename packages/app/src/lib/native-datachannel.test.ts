import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from './artifacts-manifest';
import { loadNodeDatachannel, nativeAddonPath, nativeManifestPath } from './native-datachannel';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeNativeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tmex-native-'));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('loadNodeDatachannel', () => {
  test('returns null when addon is missing', async () => {
    const nativeDir = await makeNativeDir();
    const reasons: string[] = [];
    const mod = await loadNodeDatachannel({
      nativeDir,
      log: (message) => reasons.push(message),
    });
    expect(mod).toBeNull();
    expect(reasons.join('\n')).toContain('not found');
  });

  test('returns null when addon bytes do not match manifest sha256', async () => {
    const nativeDir = await makeNativeDir();
    const addon = Buffer.from('not-a-real-addon');
    await writeFile(nativeAddonPath(nativeDir), addon);
    await writeFile(
      nativeManifestPath(nativeDir),
      JSON.stringify({
        platform: 'darwin-arm64',
        version: '0.33.1',
        sha256: sha256Hex('something-else'),
        napiVersion: 8,
      })
    );

    const reasons: string[] = [];
    const mod = await loadNodeDatachannel({
      nativeDir,
      log: (message) => reasons.push(message),
    });
    expect(mod).toBeNull();
    expect(reasons.join('\n').toLowerCase()).toContain('sha256');
  });

  test('returns null without throwing when fake addon bytes match the manifest', async () => {
    const nativeDir = await makeNativeDir();
    const addon = Buffer.from('fake-node-addon-bytes');
    await writeFile(nativeAddonPath(nativeDir), addon);
    await writeFile(
      nativeManifestPath(nativeDir),
      JSON.stringify({
        platform: 'darwin-arm64',
        version: '0.33.1',
        sha256: sha256Hex(addon),
        napiVersion: 8,
      })
    );

    const reasons: string[] = [];
    const mod = await loadNodeDatachannel({
      nativeDir,
      log: (message) => reasons.push(message),
    });
    expect(mod).toBeNull();
    expect(reasons.length).toBeGreaterThan(0);
  });
});
