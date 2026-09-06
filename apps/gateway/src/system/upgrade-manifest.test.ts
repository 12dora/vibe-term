import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOREIGN_SIGNING_SEED,
  restoreSigningKeys,
  signSums,
  signedSumsFor,
  sumsTextFor,
  useTestSigningKeys,
} from '../test-support/release-signing';
import type { InstallInfo } from './install-info';
import { UpgradeController } from './upgrade';
import { readStagedManifest, stagedManifestPath, verifyPackageManifest } from './upgrade-manifest';

const tempDirs: string[] = [];

beforeAll(() => {
  useTestSigningKeys();
});

afterAll(() => {
  restoreSigningKeys();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempInstall(): InstallInfo {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-manifest-'));
  tempDirs.push(dir);
  return {
    installedViaCli: true,
    deployment: 'launchd',
    installDir: dir,
    serviceName: 'vibeterm',
    cliVersion: '1.1.0',
    bunPath: '/usr/bin/bun',
  };
}

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

function stagedDirOf(install: InstallInfo): string {
  return join(install.installDir as string, 'staging', 'staged');
}

describe('verifyPackageManifest', () => {
  const version = '1.1.39';
  const hex = 'ab'.repeat(32);

  test('accepts a signed SHA256SUMS and returns the authoritative digest', () => {
    const result = verifyPackageManifest({ version, ...signedSumsFor(version, hex) });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('expected ok');
    expect(result.manifest.sha256).toBe(hex);
    expect(result.manifest.keyId).toBe('tk');
  });

  test('a missing signature is RELEASE_UNSIGNED even for an old version', () => {
    expect(
      verifyPackageManifest({ version: '1.0.0', sums: sumsTextFor('1.0.0', hex), sig: '' })
    ).toEqual({ ok: false, status: 400, code: 'RELEASE_UNSIGNED' });
  });

  test('tampered sums fail with RELEASE_SIGNATURE_INVALID', () => {
    const signed = signedSumsFor(version, hex);
    const tampered = signed.sums.replace(hex, 'cd'.repeat(32));
    expect(verifyPackageManifest({ version, sums: tampered, sig: signed.sig })).toEqual({
      ok: false,
      status: 400,
      code: 'RELEASE_SIGNATURE_INVALID',
    });
  });

  test('a signature from a key that is not embedded is rejected', () => {
    const signed = signedSumsFor(version, hex, FOREIGN_SIGNING_SEED);
    expect(verifyPackageManifest({ version, sums: signed.sums, sig: signed.sig })).toEqual({
      ok: false,
      status: 400,
      code: 'RELEASE_SIGNATURE_INVALID',
    });
  });

  test('sums that do not list this version are RELEASE_SUMS_INVALID', () => {
    const sums = sumsTextFor('9.9.9', hex);
    expect(verifyPackageManifest({ version, sums, sig: signSums(sums) })).toEqual({
      ok: false,
      status: 400,
      code: 'RELEASE_SUMS_INVALID',
    });
  });

  test('non-string fields and oversized bodies are BAD_REQUEST', () => {
    expect(verifyPackageManifest({ version, sums: 42, sig: 'x' })).toMatchObject({
      code: 'BAD_REQUEST',
    });
    const huge = `${'a'.repeat(70 * 1024)}\n`;
    expect(verifyPackageManifest({ version, sums: huge, sig: 'x' })).toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('UpgradeController.putPackageManifest', () => {
  test('persists a sidecar that reads back verified', async () => {
    const install = tempInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const hex = 'ab'.repeat(32);
    const result = await controller.putPackageManifest('1.1.39', signedSumsFor('1.1.39', hex));
    expect(result).toEqual({ ok: true, version: '1.1.39', sha256: hex, keyId: 'tk' });
    expect(existsSync(stagedManifestPath(stagedDirOf(install), '1.1.39'))).toBe(true);
    expect(readStagedManifest(stagedDirOf(install), '1.1.39')?.sha256).toBe(hex);
  });

  test('a rejected manifest writes nothing', async () => {
    const install = tempInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const result = await controller.putPackageManifest('1.1.39', {
      sums: sumsTextFor('1.1.39', 'ab'.repeat(32)),
      sig: 'tmex-release-sig v1 tk not-a-signature',
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(existsSync(stagedManifestPath(stagedDirOf(install), '1.1.39'))).toBe(false);
  });

  test('a sidecar edited on disk stops reading back', async () => {
    const install = tempInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const hex = 'ab'.repeat(32);
    await controller.putPackageManifest('1.1.39', signedSumsFor('1.1.39', hex));
    const path = stagedManifestPath(stagedDirOf(install), '1.1.39');
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    record.sums = sumsTextFor('1.1.39', 'cd'.repeat(32));
    record.sha256 = 'cd'.repeat(32);
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    expect(readStagedManifest(stagedDirOf(install), '1.1.39')).toBeNull();
  });
});

describe('stagePackage against a manifest', () => {
  test('a sha256 that differs from the manifest is 409 UPGRADE_MANIFEST_MISMATCH', async () => {
    const install = tempInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await controller.putPackageManifest('1.1.39', signedSumsFor('1.1.39', 'ab'.repeat(32)));
    const result = await controller.stagePackage('1.1.39', sha256Hex(bytes), bytesStream(bytes));
    expect(result).toEqual({ ok: false, status: 409, code: 'UPGRADE_MANIFEST_MISMATCH' });
    expect(existsSync(join(stagedDirOf(install), 'vibeterm-cli-1.1.39.tgz'))).toBe(false);
  });

  test('bytes matching the manifest stage normally', async () => {
    const install = tempInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hex = sha256Hex(bytes);
    await controller.putPackageManifest('1.1.39', signedSumsFor('1.1.39', hex));
    const result = await controller.stagePackage('1.1.39', hex, bytesStream(bytes));
    expect(result).toEqual({ ok: true, version: '1.1.39', sha256: hex, bytes: bytes.byteLength });
  });
});

describe('tryStart(source: staged) requires a manifest', () => {
  test('no manifest at all is UPGRADE_SIGNATURE_REQUIRED', async () => {
    const install = tempInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const hex = sha256Hex(bytes);
    expect((await controller.stagePackage('1.1.39', hex, bytesStream(bytes))).ok).toBe(true);
    expect(controller.tryStart('1.1.39', { source: 'staged', sha256: hex })).toEqual({
      ok: false,
      code: 'UPGRADE_SIGNATURE_REQUIRED',
    });
    expect(controller.status().state).toBe('idle');
  });

  test('a manifest for a different digest is refused', async () => {
    const install = tempInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const hex = sha256Hex(bytes);
    expect((await controller.stagePackage('1.1.39', hex, bytesStream(bytes))).ok).toBe(true);
    // 先落包再补一份对不上的清单：装包这一步必须还是拒绝。
    await controller.putPackageManifest('1.1.39', signedSumsFor('1.1.39', 'ab'.repeat(32)));
    expect(controller.tryStart('1.1.39', { source: 'staged', sha256: hex })).toEqual({
      ok: false,
      code: 'UPGRADE_SIGNATURE_REQUIRED',
    });
  });

  test('a manifest tampered on disk is refused', async () => {
    const install = tempInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const hex = sha256Hex(bytes);
    await controller.putPackageManifest('1.1.39', signedSumsFor('1.1.39', hex));
    expect((await controller.stagePackage('1.1.39', hex, bytesStream(bytes))).ok).toBe(true);
    const path = stagedManifestPath(stagedDirOf(install), '1.1.39');
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    record.sig = 'tmex-release-sig v1 tk AAAA';
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    expect(controller.tryStart('1.1.39', { source: 'staged', sha256: hex })).toEqual({
      ok: false,
      code: 'UPGRADE_SIGNATURE_REQUIRED',
    });
  });
});

describe('staged manifest lifecycle', () => {
  test('removeStagedPackage drops the manifest with the package', async () => {
    const install = tempInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = new Uint8Array([9, 9, 9]);
    const hex = sha256Hex(bytes);
    await controller.putPackageManifest('1.1.39', signedSumsFor('1.1.39', hex));
    expect((await controller.stagePackage('1.1.39', hex, bytesStream(bytes))).ok).toBe(true);
    expect((await controller.removeStagedPackage('1.1.39')).ok).toBe(true);
    expect(existsSync(stagedManifestPath(stagedDirOf(install), '1.1.39'))).toBe(false);
  });

  test('a manifest that arrives before the bytes survives the orphan sweep', async () => {
    const install = tempInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = new Uint8Array([9, 9, 9]);
    const hex = sha256Hex(bytes);
    await controller.putPackageManifest('1.1.39', signedSumsFor('1.1.39', hex));
    // stagePackage 会先跑一遍孤儿清理；清单不能在那时被当成垃圾删掉。
    expect((await controller.stagePackage('1.1.39', hex, bytesStream(bytes))).ok).toBe(true);
    expect(readStagedManifest(stagedDirOf(install), '1.1.39')?.sha256).toBe(hex);
  });
});

describe('远程发起的升级要过签名下限', () => {
  function stubbedController(install: InstallInfo): UpgradeController {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    return new UpgradeController({
      getInstallInfo: () => install,
      stageRelease: async () => '/tmp/pkg/bin/vibeterm.js',
      spawn: () => child as unknown as ChildProcess,
    });
  }

  test('远程 + 下限之前的版本：拒绝，不进 downloading', () => {
    const controller = stubbedController(tempInstall());
    expect(controller.tryStart('1.1.38', { remote: true })).toEqual({
      ok: false,
      code: 'UPGRADE_SIGNATURE_REQUIRED',
    });
    expect(controller.status().state).toBe('idle');
  });

  test('本机操作者仍可装历史版本', () => {
    const controller = stubbedController(tempInstall());
    expect(controller.tryStart('1.1.38')).toEqual({ ok: true });
    expect(controller.status().state).toBe('downloading');
  });

  test('远程 + 下限之上的版本照常放行（走下载路径自己验签）', () => {
    const controller = stubbedController(tempInstall());
    expect(controller.tryStart('1.1.39', { remote: true })).toEqual({ ok: true });
    expect(controller.status().state).toBe('downloading');
  });
});

describe('暂存包过期后重试', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function clockedController(
    install: InstallInfo,
    now: () => number,
    stub = false
  ): UpgradeController {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    return new UpgradeController({
      getInstallInfo: () => install,
      now,
      ...(stub
        ? {
            spawn: () => child as unknown as ChildProcess,
            extractPackage: async () => '/tmp/pkg/bin/vibeterm.js',
          }
        : {}),
    });
  }

  test('过期清理不会删掉刚收到的新清单，重传后仍装得上', async () => {
    const install = tempInstall();
    let now = Date.now();
    const controller = clockedController(install, () => now, true);
    const bytes = new Uint8Array([3, 1, 4, 1, 5]);
    const hex = sha256Hex(bytes);

    await controller.putPackageManifest('1.1.39', signedSumsFor('1.1.39', hex));
    expect((await controller.stagePackage('1.1.39', hex, bytesStream(bytes))).ok).toBe(true);

    // 25 小时没人装它：暂存记录过期，重试要能从头走一遍
    now += DAY_MS + 60 * 60 * 1000;
    await controller.putPackageManifest('1.1.39', signedSumsFor('1.1.39', hex));
    const status = await controller.stagedPackageStatus('1.1.39', hex);
    expect(status).toMatchObject({ ok: true, complete: false });
    expect(readStagedManifest(stagedDirOf(install), '1.1.39')?.sha256).toBe(hex);

    expect((await controller.stagePackage('1.1.39', hex, bytesStream(bytes))).ok).toBe(true);
    expect(readStagedManifest(stagedDirOf(install), '1.1.39')?.sha256).toBe(hex);
    expect(controller.tryStart('1.1.39', { source: 'staged', sha256: hex })).toEqual({ ok: true });
  });

  test('重试跨控制器重启也成立', async () => {
    const install = tempInstall();
    let now = Date.now();
    const first = clockedController(install, () => now);
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const hex = sha256Hex(bytes);
    await first.putPackageManifest('1.1.39', signedSumsFor('1.1.39', hex));
    expect((await first.stagePackage('1.1.39', hex, bytesStream(bytes))).ok).toBe(true);

    now += DAY_MS + 60 * 60 * 1000;
    const second = clockedController(install, () => now, true);
    await second.putPackageManifest('1.1.39', signedSumsFor('1.1.39', hex));
    expect((await second.stagePackage('1.1.39', hex, bytesStream(bytes))).ok).toBe(true);
    expect(second.tryStart('1.1.39', { source: 'staged', sha256: hex })).toEqual({ ok: true });
  });

  test('没人来重试的清单按自报时间过期', async () => {
    const install = tempInstall();
    let now = Date.now();
    const controller = clockedController(install, () => now);
    const bytes = new Uint8Array([1, 1, 1]);
    const hex = sha256Hex(bytes);
    await controller.putPackageManifest('1.1.39', signedSumsFor('1.1.39', hex));
    expect((await controller.stagePackage('1.1.39', hex, bytesStream(bytes))).ok).toBe(true);

    now += DAY_MS + 60 * 60 * 1000;
    // 换一版触发一次清理：老清单没人续，应当被清掉
    await controller.putPackageManifest('1.1.40', signedSumsFor('1.1.40', hex));
    expect((await controller.stagePackage('1.1.40', hex, bytesStream(bytes))).ok).toBe(true);
    expect(existsSync(stagedManifestPath(stagedDirOf(install), '1.1.39'))).toBe(false);
    expect(readStagedManifest(stagedDirOf(install), '1.1.40')?.sha256).toBe(hex);
  });
});
