import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPGRADE_CANCELLED, releaseTarballName, releaseTarballUrl } from '@tmex/shared';
import type { InstallInfo } from './install-info';
import { resetReleaseDownloadForTests } from './release-download';
import {
  STAGED_PACKAGE_MAX_BYTES,
  UpgradeController,
  assertExtractedCliPackage,
  cmdlineOwnsInstallRuntime,
  releaseSha256SumsUrl,
  resolveUpgradeInstallDir,
  sha256Hex,
  stageGithubRelease,
  waitForSpawnAndDetach,
} from './upgrade';

const originalFetch = globalThis.fetch;
const originalCacheDir = process.env.TMEX_RELEASE_CACHE_DIR;
const originalInstallDir = process.env.TMEX_INSTALL_DIR;
const tempDirs: string[] = [];
const liveChildren: ChildProcess[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetReleaseDownloadForTests();
  if (originalCacheDir === undefined) delete process.env.TMEX_RELEASE_CACHE_DIR;
  else process.env.TMEX_RELEASE_CACHE_DIR = originalCacheDir;
  if (originalInstallDir === undefined) delete process.env.TMEX_INSTALL_DIR;
  else process.env.TMEX_INSTALL_DIR = originalInstallDir;
  rmSync(join(tmpdir(), 'tmex-release-cache'), { recursive: true, force: true });
  for (const child of liveChildren.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already exited
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function toResponseBody(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function writeCompletePackage(pkg: string): void {
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  mkdirSync(join(pkg, 'dist', 'runtime'), { recursive: true });
  mkdirSync(join(pkg, 'resources', 'fe-dist'), { recursive: true });
  mkdirSync(join(pkg, 'resources', 'gateway-drizzle'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    `${JSON.stringify({ name: 'tmex-cli', bin: { tmex: './bin/tmex.js' } })}\n`
  );
  writeFileSync(join(pkg, 'bin', 'tmex.js'), '#!/usr/bin/env node\nconsole.log("ok");\n');
  writeFileSync(join(pkg, 'dist', 'cli-node.js'), 'export {}\n');
  writeFileSync(join(pkg, 'dist', 'runtime', 'server.js'), 'export {}\n');
  writeFileSync(join(pkg, 'resources', 'fe-dist', 'index.html'), '<html></html>\n');
  writeFileSync(join(pkg, 'resources', 'gateway-drizzle', '0000.sql'), '--\n');
}

function packFakeCliTarball(version: string): Buffer {
  const dir = tempDir('tmex-pack-src-');
  writeCompletePackage(join(dir, 'package'));
  const tgz = join(dir, releaseTarballName(version));
  const packed = spawnSync('tar', ['-czf', tgz, '-C', dir, 'package'], { encoding: 'utf8' });
  if (packed.status !== 0) {
    throw new Error(`tar pack failed: ${packed.stderr}`);
  }
  return readFileSync(tgz);
}

function matchingSumsBody(bytes: Buffer, version: string): string {
  return `${sha256Hex(bytes)}  ${releaseTarballName(version)}\n`;
}

function stubGithubFetch(tarballBytes: Buffer, sums: { status: number; body: string }): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    if (url.includes('SHA256SUMS')) {
      return new Response(sums.body, { status: sums.status });
    }
    expect(init?.redirect === undefined || init.redirect === 'follow').toBe(true);
    return new Response(toResponseBody(tarballBytes), { status: 200 });
  }) as typeof fetch;
  return requested;
}

function spawnSleepChild(): ChildProcess {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  liveChildren.push(child);
  if (child.pid == null) {
    throw new Error('failed to spawn sleep child');
  }
  return child;
}

describe('resolveUpgradeInstallDir', () => {
  test('walks up from current/ when install-meta sits at the parent', () => {
    const dir = tempDir('tmex-upg-current-');
    mkdirSync(join(dir, 'current'), { recursive: true });
    writeFileSync(join(dir, 'install-meta.json'), '{"cliVersion":"1.0.0"}\n');
    expect(
      resolveUpgradeInstallDir({
        installedViaCli: true,
        deployment: 'launchd',
        installDir: join(dir, 'current'),
        serviceName: 'tmex',
        cliVersion: '1.0.0',
        bunPath: '/usr/bin/bun',
      })
    ).toBe(dir);
  });
});

describe('stageGithubRelease', () => {
  beforeEach(() => {
    process.env.TMEX_RELEASE_CACHE_DIR = tempDir('tmex-rel-cache-');
  });

  test('downloads GitHub tarball, extracts npm-pack layout, returns package/bin/tmex.js', async () => {
    const version = '9.9.9';
    const bytes = packFakeCliTarball(version);
    const requested = stubGithubFetch(bytes, {
      status: 200,
      body: matchingSumsBody(bytes, version),
    });

    const stageDir = tempDir('tmex-upg-stage-');
    const binPath = await stageGithubRelease(stageDir, version);

    expect(requested).toContain(releaseTarballUrl(version));
    expect(requested).toContain(releaseSha256SumsUrl(version));
    expect(binPath).toBe(join(stageDir, 'package', 'bin', 'tmex.js'));
    expect(existsSync(binPath)).toBe(true);
    expect(readFileSync(binPath, 'utf8')).toContain('console.log("ok")');
  });

  test('HTTP error while downloading tarball throws and never uses npm', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      return new Response('nope', { status: 403 });
    }) as typeof fetch;

    await expect(stageGithubRelease(tempDir('tmex-upg-stage-'), '9.9.9')).rejects.toThrow(
      /GitHub release tarball HTTP 403/i
    );
    expect(requested).toEqual([releaseTarballUrl('9.9.9')]);
    expect(requested.every((url) => !url.includes('registry.npmjs.org'))).toBe(true);
  });

  test('extract without package/bin/tmex.js throws', async () => {
    const dir = tempDir('tmex-pack-empty-');
    writeFileSync(join(dir, 'readme.txt'), 'no cli\n');
    const tgz = join(dir, 'empty.tgz');
    const packed = spawnSync('tar', ['-czf', tgz, '-C', dir, 'readme.txt'], { encoding: 'utf8' });
    if (packed.status !== 0) {
      throw new Error(`tar pack failed: ${packed.stderr}`);
    }
    const bytes = readFileSync(tgz);

    stubGithubFetch(bytes, { status: 200, body: matchingSumsBody(bytes, '1.2.3') });

    await expect(stageGithubRelease(tempDir('tmex-upg-stage-'), '1.2.3')).rejects.toThrow(
      /downloaded tmex-cli binary not found/
    );
  });

  test('extract missing package layout files throws and stays idle-capable', async () => {
    const dir = tempDir('tmex-pack-partial-');
    const pkg = join(dir, 'package');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      `${JSON.stringify({ name: 'tmex-cli', bin: { tmex: './bin/tmex.js' } })}\n`
    );
    writeFileSync(join(pkg, 'bin', 'tmex.js'), '#!/usr/bin/env node\n');
    const tgz = join(dir, releaseTarballName('1.2.3'));
    const packed = spawnSync('tar', ['-czf', tgz, '-C', dir, 'package'], { encoding: 'utf8' });
    if (packed.status !== 0) {
      throw new Error(`tar pack failed: ${packed.stderr}`);
    }
    const bytes = readFileSync(tgz);
    stubGithubFetch(bytes, { status: 200, body: matchingSumsBody(bytes, '1.2.3') });

    await expect(stageGithubRelease(tempDir('tmex-upg-stage-'), '1.2.3')).rejects.toThrow(
      /extracted package is missing/
    );
  });
});

describe('assertExtractedCliPackage', () => {
  test('accepts a complete tmex-cli package', () => {
    const root = tempDir('tmex-layout-ok-');
    writeCompletePackage(root);
    expect(() => assertExtractedCliPackage(root)).not.toThrow();
  });

  test('rejects wrong package name or missing bin', () => {
    const root = tempDir('tmex-layout-name-');
    writeCompletePackage(root);
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'other', bin: { tmex: './bin/tmex.js' } })}\n`
    );
    expect(() => assertExtractedCliPackage(root)).toThrow(/expected tmex-cli/);

    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'tmex-cli' })}\n`);
    expect(() => assertExtractedCliPackage(root)).toThrow(/bin entry/);
  });
});

describe('waitForSpawnAndDetach', () => {
  test('resolves on spawn and unrefs', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void; unrefed: boolean };
    child.unrefed = false;
    child.unref = () => {
      child.unrefed = true;
    };
    const done = waitForSpawnAndDetach(child as unknown as ChildProcess);
    child.emit('spawn');
    await done;
    expect(child.unrefed).toBe(true);
  });

  test('rejects on error', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const done = waitForSpawnAndDetach(child as unknown as ChildProcess);
    child.emit('error', new Error('spawn ENOENT'));
    await expect(done).rejects.toThrow(/ENOENT/);
  });
});

describe('UpgradeController detached spawn', () => {
  function makeInstall(): InstallInfo {
    const dir = tempDir('tmex-upg-install-');
    return {
      installedViaCli: true,
      deployment: 'launchd',
      installDir: dir,
      serviceName: 'tmex',
      cliVersion: '1.1.0',
      bunPath: '/usr/bin/bun',
    };
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  test('stays downloading until spawn, then marks executing', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    let spawned = false;
    const controller = new UpgradeController({
      getInstallInfo: () => makeInstall(),
      stageRelease: async () => '/tmp/pkg/bin/tmex.js',
      spawn: () => {
        spawned = true;
        return child as unknown as ChildProcess;
      },
    });

    expect(controller.start('1.2.3')).toBe(true);
    expect(controller.status().state).toBe('downloading');
    await settle();
    expect(spawned).toBe(true);
    expect(controller.status().state).toBe('downloading');
    child.emit('spawn');
    await settle();
    expect(controller.status().state).toBe('executing');
  });

  test('returns to idle with the message when the child errors', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => makeInstall(),
      stageRelease: async () => '/tmp/pkg/bin/tmex.js',
      spawn: () => child as unknown as ChildProcess,
    });

    expect(controller.start('1.2.3')).toBe(true);
    await settle();
    child.emit('error', new Error('spawn ENOENT'));
    await settle();
    expect(controller.status().state).toBe('idle');
    expect(controller.status().error).toContain('ENOENT');
    expect(controller.status().targetVersion).toBeNull();
  });

  test('resets to idle when the child exits early after spawn', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => makeInstall(),
      stageRelease: async () => '/tmp/pkg/bin/tmex.js',
      spawn: () => child as unknown as ChildProcess,
    });
    expect(controller.start('1.2.3')).toBe(true);
    await settle();
    child.emit('spawn');
    await settle();
    expect(controller.status().state).toBe('executing');
    child.emit('exit', 2, null);
    await settle();
    expect(controller.status().state).toBe('idle');
    expect(controller.status().error).toMatch(/exited early/);
  });

  test('refuses web upgrade when serviceMode is none without a live pid', async () => {
    const dir = tempDir('tmex-upg-none-');
    writeFileSync(
      join(dir, 'install-meta.json'),
      `${JSON.stringify({ cliVersion: '1.1.3', serviceMode: 'none' })}\n`
    );
    const spawned: string[][] = [];
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => ({
        installedViaCli: true,
        deployment: 'none',
        installDir: dir,
        serviceName: 'tmex',
        cliVersion: '1.1.3',
        bunPath: '/usr/bin/bun',
      }),
      stageRelease: async () => '/tmp/pkg/bin/tmex.js',
      spawn: (_cmd, args) => {
        spawned.push([...args]);
        return child as unknown as ChildProcess;
      },
    });
    expect(controller.start('1.2.3')).toBe(true);
    await settle();
    expect(controller.status().state).toBe('idle');
    expect(controller.status().error).toMatch(/pid file|serviceMode/i);
    expect(spawned).toEqual([]);
    expect(existsSync(join(dir, 'upgrade.log'))).toBe(false);
  });

  test('refuses web upgrade when none-mode pid is live but foreign', async () => {
    const dir = tempDir('tmex-upg-none-foreign-');
    writeFileSync(
      join(dir, 'install-meta.json'),
      `${JSON.stringify({ cliVersion: '1.1.3', serviceMode: 'none' })}\n`
    );
    const sleeper = spawnSleepChild();
    writeFileSync(join(dir, 'tmex.pid'), `${sleeper.pid}\n`);
    const spawned: string[][] = [];
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => ({
        installedViaCli: true,
        deployment: 'none',
        installDir: dir,
        serviceName: 'tmex',
        cliVersion: '1.1.3',
        bunPath: '/usr/bin/bun',
      }),
      stageRelease: async () => '/tmp/pkg/bin/tmex.js',
      spawn: (_cmd, args) => {
        spawned.push([...args]);
        return child as unknown as ChildProcess;
      },
    });
    expect(controller.start('1.2.3')).toBe(true);
    await settle();
    expect(controller.status().state).toBe('idle');
    expect(controller.status().error).toMatch(/not the tmex runtime|does not belong|ownership/i);
    expect(spawned).toEqual([]);
    expect(existsSync(join(dir, 'upgrade.log'))).toBe(false);
    expect(() => process.kill(sleeper.pid as number, 0)).not.toThrow();
  });

  test('refuses none-mode pid whose cmdline is vim with this install server.js', async () => {
    const dir = tempDir('tmex-upg-none-vim-');
    mkdirSync(join(dir, 'current', 'runtime'), { recursive: true });
    writeFileSync(join(dir, 'current', 'runtime', 'server.js'), 'export {}\n');
    writeFileSync(
      join(dir, 'install-meta.json'),
      `${JSON.stringify({ cliVersion: '1.1.3', serviceMode: 'none' })}\n`
    );
    const sleeper = spawnSleepChild();
    writeFileSync(join(dir, 'tmex.pid'), `${sleeper.pid}\n`);
    const vimCmd = `vim ${join(dir, 'current', 'runtime', 'server.js')}`;
    const spawned: string[][] = [];
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => ({
        installedViaCli: true,
        deployment: 'none',
        installDir: dir,
        serviceName: 'tmex',
        cliVersion: '1.1.3',
        bunPath: '/usr/bin/bun',
      }),
      stageRelease: async () => '/tmp/pkg/bin/tmex.js',
      processCommandLine: () => vimCmd,
      spawn: (_cmd, args) => {
        spawned.push([...args]);
        return child as unknown as ChildProcess;
      },
    });
    expect(controller.start('1.2.3')).toBe(true);
    await settle();
    expect(controller.status().state).toBe('idle');
    expect(controller.status().error).toMatch(/not the tmex runtime|does not belong|ownership/i);
    expect(spawned).toEqual([]);
    expect(() => process.kill(sleeper.pid as number, 0)).not.toThrow();
  });

  test('passes --no-service when persisted mode is none and pid cmdline matches this install', async () => {
    const dir = tempDir('tmex-upg-none-pid-');
    writeFileSync(
      join(dir, 'install-meta.json'),
      `${JSON.stringify({ cliVersion: '1.1.3', serviceMode: 'none' })}\n`
    );
    writeFileSync(join(dir, 'tmex.pid'), `${process.pid}\n`);
    const ownedCmd = `bun ${join(dir, 'current', 'runtime', 'server.js')}`;
    const spawned: string[][] = [];
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => ({
        installedViaCli: true,
        deployment: 'none',
        installDir: dir,
        serviceName: 'tmex',
        cliVersion: '1.1.3',
        bunPath: '/usr/bin/bun',
      }),
      stageRelease: async () => '/tmp/pkg/bin/tmex.js',
      processCommandLine: () => ownedCmd,
      spawn: (_cmd, args) => {
        spawned.push([...args]);
        return child as unknown as ChildProcess;
      },
    });
    expect(controller.start('1.2.3')).toBe(true);
    await settle();
    child.emit('spawn');
    await settle();
    expect(spawned[0]).toContain('--no-service');
    expect(controller.status().state).toBe('executing');
  });
});

describe('stageGithubRelease checksums', () => {
  beforeEach(() => {
    process.env.TMEX_RELEASE_CACHE_DIR = tempDir('tmex-rel-cache-');
  });

  test('aborts when SHA256SUMS returns a non-404 HTTP error before extract', async () => {
    const version = '9.9.9';
    const bytes = packFakeCliTarball(version);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('SHA256SUMS')) return new Response('nope', { status: 500 });
      return new Response(toResponseBody(bytes), { status: 200 });
    }) as typeof fetch;
    await expect(stageGithubRelease(tempDir('tmex-upg-sums-500-'), version)).rejects.toThrow(
      /SHA256SUMS HTTP 500/
    );
  });

  test('verifies a matching SHA256SUMS before extract', async () => {
    const version = '9.9.9';
    const bytes = packFakeCliTarball(version);
    const hex = sha256Hex(bytes);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('SHA256SUMS')) {
        return new Response(`${hex}  ${releaseTarballName(version)}\n`, { status: 200 });
      }
      return new Response(toResponseBody(bytes), { status: 200 });
    }) as typeof fetch;
    const binPath = await stageGithubRelease(tempDir('tmex-upg-sums-ok-'), version);
    expect(existsSync(binPath)).toBe(true);
  });

  test('aborts on SHA256 mismatch before extract', async () => {
    const version = '9.9.9';
    const bytes = packFakeCliTarball(version);
    stubGithubFetch(bytes, {
      status: 200,
      body: `${'0'.repeat(64)}  ${releaseTarballName(version)}\n`,
    });
    await expect(stageGithubRelease(tempDir('tmex-upg-sums-bad-'), version)).rejects.toThrow(
      /sha256 mismatch/i
    );
  });

  test('aborts when SHA256SUMS is HTTP 404 for versions >= 1.1.4', async () => {
    const version = '1.1.4';
    const bytes = packFakeCliTarball(version);
    stubGithubFetch(bytes, { status: 404, body: 'not published' });
    await expect(stageGithubRelease(tempDir('tmex-upg-sums-404-'), version)).rejects.toThrow(
      /requires SHA256SUMS|Refusing to continue/i
    );
  });

  test('aborts when SHA256SUMS is HTTP 404 for older targets (web never unverified)', async () => {
    const version = '1.1.0';
    const bytes = packFakeCliTarball(version);
    stubGithubFetch(bytes, { status: 404, body: 'not published' });
    await expect(stageGithubRelease(tempDir('tmex-upg-sums-404-old-'), version)).rejects.toThrow(
      /SHA256SUMS is missing|integrity is unverified|SHA256SUMS is required/i
    );
  });

  test('aborts when SHA256SUMS has no exact tarball entry', async () => {
    const version = '1.1.4';
    const bytes = packFakeCliTarball(version);
    stubGithubFetch(bytes, {
      status: 200,
      body: `${sha256Hex(bytes)}  other-file.tgz\n`,
    });
    await expect(stageGithubRelease(tempDir('tmex-upg-sums-noentry-'), version)).rejects.toThrow(
      /does not list|missing an entry/
    );
  });
});

describe('staged package', () => {
  function makeInstall(): InstallInfo {
    const dir = tempDir('tmex-upg-staged-');
    return {
      installedViaCli: true,
      deployment: 'launchd',
      installDir: dir,
      serviceName: 'tmex',
      cliVersion: '1.1.0',
      bunPath: '/usr/bin/bun',
    };
  }

  function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  test('PUT happy path writes tarball, sidecar, and remembers the package', async () => {
    const install = makeInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = packFakeCliTarball('1.2.3');
    const hex = sha256Hex(bytes);
    const result = await controller.stagePackage('1.2.3', hex, bytesStream(bytes));
    expect(result).toEqual({
      ok: true,
      version: '1.2.3',
      sha256: hex,
      bytes: bytes.byteLength,
    });
    const stagedPath = join(
      install.installDir as string,
      'staging',
      'staged',
      'tmex-cli-1.2.3.tgz'
    );
    expect(existsSync(stagedPath)).toBe(true);
    expect(readFileSync(stagedPath)).toEqual(Buffer.from(bytes));
    const sidecar = JSON.parse(
      readFileSync(
        join(install.installDir as string, 'staging', 'staged', 'tmex-cli-1.2.3.json'),
        'utf8'
      )
    ) as { version: string; sha256: string; bytes: number };
    expect(sidecar.version).toBe('1.2.3');
    expect(sidecar.sha256).toBe(hex);
    expect(sidecar.bytes).toBe(bytes.byteLength);
  });

  test('PUT sha256 mismatch deletes the part file and returns PACKAGE_SHA256_MISMATCH', async () => {
    const install = makeInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = packFakeCliTarball('1.2.3');
    const result = await controller.stagePackage('1.2.3', '0'.repeat(64), bytesStream(bytes));
    expect(result).toEqual({ ok: false, status: 400, code: 'PACKAGE_SHA256_MISMATCH' });
    const stagedDir = join(install.installDir as string, 'staging', 'staged');
    expect(existsSync(join(stagedDir, 'tmex-cli-1.2.3.tgz'))).toBe(false);
    expect(existsSync(join(stagedDir, 'tmex-cli-1.2.3.tgz.part'))).toBe(false);
  });

  test('PUT over the size cap returns 413 and does not keep the part', async () => {
    const install = makeInstall();
    const controller = new UpgradeController({
      getInstallInfo: () => install,
      maxPackageBytes: 32,
    });
    const bytes = new Uint8Array(64).fill(7);
    const result = await controller.stagePackage('1.2.3', sha256Hex(bytes), bytesStream(bytes));
    expect(result).toEqual({ ok: false, status: 413, code: 'PACKAGE_TOO_LARGE' });
    expect(
      existsSync(join(install.installDir as string, 'staging', 'staged', 'tmex-cli-1.2.3.tgz'))
    ).toBe(false);
    expect(
      existsSync(join(install.installDir as string, 'staging', 'staged', 'tmex-cli-1.2.3.tgz.part'))
    ).toBe(false);
  });

  test('PUT while an upgrade is in progress returns UPGRADE_IN_PROGRESS', async () => {
    const install = makeInstall();
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => install,
      stageRelease: async () => '/tmp/pkg/bin/tmex.js',
      spawn: () => child as unknown as ChildProcess,
    });
    expect(controller.start('9.9.9')).toBe(true);
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await controller.stagePackage('1.2.3', sha256Hex(bytes), bytesStream(bytes));
    expect(result).toEqual({ ok: false, status: 409, code: 'UPGRADE_IN_PROGRESS' });
    child.emit('spawn');
    await settle();
  });

  test('POST staged extracts the staged tarball and continues to executing', async () => {
    const install = makeInstall();
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => install,
      spawn: () => child as unknown as ChildProcess,
    });
    const bytes = packFakeCliTarball('1.2.3');
    const hex = sha256Hex(bytes);
    const staged = await controller.stagePackage('1.2.3', hex, bytesStream(bytes));
    expect(staged.ok).toBe(true);
    const started = controller.tryStart('1.2.3', { source: 'staged', sha256: hex });
    expect(started).toEqual({ ok: true });
    expect(controller.status().state).toBe('downloading');
    await settle();
    child.emit('spawn');
    await settle();
    expect(controller.status().state).toBe('executing');
  });

  test('POST staged without a staged package returns PACKAGE_NOT_STAGED and stays idle', async () => {
    const controller = new UpgradeController({ getInstallInfo: () => makeInstall() });
    const started = controller.tryStart('1.2.3', { source: 'staged' });
    expect(started).toEqual({ ok: false, code: 'PACKAGE_NOT_STAGED' });
    expect(controller.status().state).toBe('idle');
  });

  test('a new controller reloads the sidecar after a simulated restart', async () => {
    const install = makeInstall();
    const first = new UpgradeController({ getInstallInfo: () => install });
    const bytes = packFakeCliTarball('2.0.0');
    const hex = sha256Hex(bytes);
    expect((await first.stagePackage('2.0.0', hex, bytesStream(bytes))).ok).toBe(true);
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const second = new UpgradeController({
      getInstallInfo: () => install,
      spawn: () => child as unknown as ChildProcess,
    });
    const started = second.tryStart('2.0.0', { source: 'staged', sha256: hex });
    expect(started.ok).toBe(true);
    await settle();
    child.emit('spawn');
    await settle();
  });

  test('STAGED_PACKAGE_MAX_BYTES is 256 MiB', () => {
    expect(STAGED_PACKAGE_MAX_BYTES).toBe(256 * 1024 * 1024);
  });

  test('PUT writes to a unique .part-<id> temp name', async () => {
    const install = makeInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = packFakeCliTarball('1.2.3');
    const hex = sha256Hex(bytes);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(controllerStream) {
        await gate;
        controllerStream.enqueue(bytes);
        controllerStream.close();
      },
    });
    const pending = controller.stagePackage('1.2.3', hex, body);
    const stagedDir = join(install.installDir as string, 'staging', 'staged');
    let partNames: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      partNames = existsSync(stagedDir)
        ? readdirSync(stagedDir).filter((name) => /\.part-[0-9a-f-]+$/i.test(name))
        : [];
      if (partNames.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(partNames.length).toBeGreaterThan(0);
    release();
    expect((await pending).ok).toBe(true);
  });

  test('concurrent PUT and POST while a PUT is streaming are UPGRADE_IN_PROGRESS', async () => {
    const install = makeInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = packFakeCliTarball('1.2.3');
    const hex = sha256Hex(bytes);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new ReadableStream<Uint8Array>({
      async pull(stream) {
        await gate;
        stream.enqueue(bytes);
        stream.close();
      },
    });
    const first = controller.stagePackage('1.2.3', hex, slow);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const other = new Uint8Array([9, 9, 9]);
    const second = await controller.stagePackage('2.0.0', sha256Hex(other), bytesStream(other));
    expect(second).toEqual({ ok: false, status: 409, code: 'UPGRADE_IN_PROGRESS' });
    expect(controller.tryStart('9.9.9')).toEqual({ ok: false, code: 'UPGRADE_IN_PROGRESS' });
    expect(controller.tryStart('1.2.3', { source: 'staged', sha256: hex })).toEqual({
      ok: false,
      code: 'UPGRADE_IN_PROGRESS',
    });
    release();
    expect((await first).ok).toBe(true);
  });

  test('POST staged atomically moves the tarball into the txn dir before extract', async () => {
    const install = makeInstall();
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => install,
      spawn: () => child as unknown as ChildProcess,
    });
    const bytes = packFakeCliTarball('1.2.3');
    const hex = sha256Hex(bytes);
    expect((await controller.stagePackage('1.2.3', hex, bytesStream(bytes))).ok).toBe(true);
    const stagedPath = join(
      install.installDir as string,
      'staging',
      'staged',
      'tmex-cli-1.2.3.tgz'
    );
    expect(existsSync(stagedPath)).toBe(true);
    expect(controller.tryStart('1.2.3', { source: 'staged', sha256: hex }).ok).toBe(true);
    for (let i = 0; i < 50 && existsSync(stagedPath); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(stagedPath)).toBe(false);
    const stagingRoot = join(install.installDir as string, 'staging');
    const txnDirs = readdirSync(stagingRoot).filter(
      (name) => name !== 'staged' && name !== 'release-cache'
    );
    expect(txnDirs.length).toBeGreaterThan(0);
    const moved = join(stagingRoot, txnDirs[0] as string, 'tmex-cli-1.2.3.tgz');
    expect(existsSync(moved)).toBe(true);
    child.emit('spawn');
    await settle();
  });

  test('size cap does not cancel the request body before returning 413', async () => {
    const install = makeInstall();
    const controller = new UpgradeController({
      getInstallInfo: () => install,
      maxPackageBytes: 32,
    });
    let cancelled = false;
    const bytes = new Uint8Array(64).fill(7);
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await controller.stagePackage('1.2.3', sha256Hex(bytes), body);
    expect(result).toEqual({ ok: false, status: 413, code: 'PACKAGE_TOO_LARGE' });
    expect(cancelled).toBe(false);
  });

  test('rename/sidecar failure returns STAGE_FAILED and cleans part/final/sidecar', async () => {
    const install = makeInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const stagedDir = join(install.installDir as string, 'staging', 'staged');
    mkdirSync(stagedDir, { recursive: true });
    mkdirSync(join(stagedDir, 'tmex-cli-1.2.3.json'));
    const bytes = packFakeCliTarball('1.2.3');
    const hex = sha256Hex(bytes);
    const result = await controller.stagePackage('1.2.3', hex, bytesStream(bytes));
    expect(result).toEqual({ ok: false, status: 500, code: 'STAGE_FAILED' });
    const leftovers = existsSync(stagedDir)
      ? readdirSync(stagedDir).filter((name) => name.includes('.part') || name.endsWith('.tgz'))
      : [];
    expect(leftovers).toEqual([]);
  });

  test('orphan tgz without sidecar is pruned by the count/TTL sweep', async () => {
    const install = makeInstall();
    const controller = new UpgradeController({
      getInstallInfo: () => install,
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
    });
    const stagedDir = join(install.installDir as string, 'staging', 'staged');
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(join(stagedDir, 'tmex-cli-0.0.1.tgz'), 'orphan');
    const bytes = packFakeCliTarball('1.2.3');
    const hex = sha256Hex(bytes);
    expect((await controller.stagePackage('1.2.3', hex, bytesStream(bytes))).ok).toBe(true);
    expect(existsSync(join(stagedDir, 'tmex-cli-0.0.1.tgz'))).toBe(false);
  });

  test('local stageGithubRelease uses the shared staging/release-cache', async () => {
    const install = makeInstall();
    const version = '9.9.9';
    const bytes = packFakeCliTarball(version);
    stubGithubFetch(bytes, { status: 200, body: matchingSumsBody(bytes, version) });
    const stageDir = join(install.installDir as string, 'staging', 'txn-local');
    mkdirSync(stageDir, { recursive: true });
    const previous = process.env.TMEX_INSTALL_DIR;
    process.env.TMEX_INSTALL_DIR = install.installDir as string;
    try {
      await stageGithubRelease(stageDir, version);
      expect(
        existsSync(
          join(install.installDir as string, 'staging', 'release-cache', `tmex-cli-${version}.tgz`)
        )
      ).toBe(true);
      expect(existsSync(join(stageDir, '.release-cache'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TMEX_INSTALL_DIR;
      else process.env.TMEX_INSTALL_DIR = previous;
    }
  });

  test('aborted PUT body deletes the unique .part and leaves staging/staged empty', async () => {
    const install = makeInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = packFakeCliTarball('1.2.3');
    const hex = sha256Hex(bytes);
    let streamCtl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        streamCtl = stream;
        stream.enqueue(bytes.subarray(0, 32));
      },
    });
    const pending = controller.stagePackage('1.2.3', hex, body);
    const stagedDir = join(install.installDir as string, 'staging', 'staged');
    for (let i = 0; i < 50; i += 1) {
      const parts = existsSync(stagedDir)
        ? readdirSync(stagedDir).filter((name) => name.includes('.part'))
        : [];
      if (parts.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    streamCtl.error(new Error('aborted'));
    const result = await pending;
    expect(result.ok).toBe(false);
    const leftover = existsSync(stagedDir) ? readdirSync(stagedDir) : [];
    expect(leftover).toEqual([]);
  });

  test('DELETE package waits for an in-flight PUT of the same version then removes what landed', async () => {
    const install = makeInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const bytes = packFakeCliTarball('1.2.3');
    const hex = sha256Hex(bytes);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        await gate;
        stream.enqueue(bytes);
        stream.close();
      },
    });
    const put = controller.stagePackage('1.2.3', hex, body);
    const stagedDir = join(install.installDir as string, 'staging', 'staged');
    for (let i = 0; i < 50; i += 1) {
      const parts = existsSync(stagedDir)
        ? readdirSync(stagedDir).filter((name) => name.includes('.part'))
        : [];
      if (parts.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let deleteSettled = false;
    const del = controller.removeStagedPackage('1.2.3').then((result) => {
      deleteSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(deleteSettled).toBe(false);
    release();
    expect((await put).ok).toBe(true);
    expect(await del).toEqual({ ok: true });
    const leftover = existsSync(stagedDir) ? readdirSync(stagedDir) : [];
    expect(leftover).toEqual([]);
  });
});

describe('UpgradeController.cancel', () => {
  function makeInstall(): InstallInfo {
    const dir = tempDir('tmex-upg-cancel-');
    return {
      installedViaCli: true,
      deployment: 'launchd',
      installDir: dir,
      serviceName: 'tmex',
      cliVersion: '1.1.0',
      bunPath: '/usr/bin/bun',
    };
  }

  function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  function stagingEntries(installDir: string): string[] {
    const root = join(installDir, 'staging');
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((name) => name !== 'staged' && name !== 'release-cache');
  }

  test('idle cancel is UPGRADE_NOT_RUNNING', async () => {
    const controller = new UpgradeController({ getInstallInfo: () => makeInstall() });
    const result = await controller.cancel();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('UPGRADE_NOT_RUNNING');
    expect(result.status).toEqual({
      state: 'idle',
      targetVersion: null,
      error: null,
      startedAt: null,
    });
  });

  test('executing cancel is UPGRADE_NOT_CANCELLABLE and does not stop the child', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void; killed: boolean };
    child.unref = () => undefined;
    child.killed = false;
    const controller = new UpgradeController({
      getInstallInfo: () => makeInstall(),
      stageRelease: async () => '/tmp/pkg/bin/tmex.js',
      spawn: () => child as unknown as ChildProcess,
    });
    expect(controller.start('1.2.3')).toBe(true);
    await settle();
    child.emit('spawn');
    await settle();
    expect(controller.status().state).toBe('executing');
    const result = await controller.cancel();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('UPGRADE_NOT_CANCELLABLE');
    expect(result.status.state).toBe('executing');
    expect(result.status.targetVersion).toBe('1.2.3');
    expect(controller.status().state).toBe('executing');
  });

  test('downloading cancel aborts the fetch, removes the txn dir and unverified cache, and reports UPGRADE_CANCELLED', async () => {
    const install = makeInstall();
    const installDir = install.installDir as string;
    const cacheDir = join(installDir, 'staging', 'release-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'tmex-cli-1.2.3.tgz.part'), 'partial');
    writeFileSync(join(cacheDir, 'tmex-cli-1.2.3.tgz'), 'unverified');
    writeFileSync(join(cacheDir, 'tmex-cli-9.9.9.tgz'), 'keep');
    writeFileSync(join(cacheDir, 'tmex-cli-9.9.9.tgz.sha256'), `${'ab'.repeat(32)}\n`);
    let seenSignal: AbortSignal | undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => install,
      stageRelease: async (stageDir, _version, signal): Promise<string> => {
        seenSignal = signal;
        writeFileSync(join(stageDir, 'tmex-cli-1.2.3.tgz.part'), 'partial-txn');
        mkdirSync(join(stageDir, 'package'), { recursive: true });
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        });
        throw new Error('unreachable');
      },
    });
    expect(controller.start('1.2.3')).toBe(true);
    expect(controller.status().state).toBe('downloading');
    await settle();
    const result = await controller.cancel();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.status).toMatchObject({
      state: 'idle',
      targetVersion: null,
      error: UPGRADE_CANCELLED,
    });
    expect(result.status.error).toBe('UPGRADE_CANCELLED');
    expect(seenSignal?.aborted).toBe(true);
    expect(stagingEntries(installDir)).toEqual([]);
    expect(existsSync(join(cacheDir, 'tmex-cli-1.2.3.tgz.part'))).toBe(false);
    expect(existsSync(join(cacheDir, 'tmex-cli-1.2.3.tgz'))).toBe(false);
    expect(existsSync(join(cacheDir, 'tmex-cli-9.9.9.tgz'))).toBe(true);
    expect(controller.status().error).toBe(UPGRADE_CANCELLED);
  }, 5_000);

  test('a second cancel after success is UPGRADE_NOT_RUNNING and stays cleaned', async () => {
    const install = makeInstall();
    const controller = new UpgradeController({
      getInstallInfo: () => install,
      stageRelease: async (_stageDir, _version, signal): Promise<string> => {
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        });
        throw new Error('unreachable');
      },
    });
    expect(controller.start('1.2.3')).toBe(true);
    expect((await controller.cancel()).ok).toBe(true);
    const again = await controller.cancel();
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('expected failure');
    expect(again.code).toBe('UPGRADE_NOT_RUNNING');
    expect(again.status.error).toBe(UPGRADE_CANCELLED);
    expect(stagingEntries(install.installDir as string)).toEqual([]);
  });

  test('staged-source cancel while still downloading removes the txn dir (consumed tarball included)', async () => {
    const install = makeInstall();
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => install,
      spawn: () => child as unknown as ChildProcess,
      extractPackage: async (_tarballPath, _stageDir, signal): Promise<string> => {
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        });
        throw new Error('unreachable');
      },
    });
    const bytes = packFakeCliTarball('1.2.3');
    const hex = sha256Hex(bytes);
    expect((await controller.stagePackage('1.2.3', hex, bytesStream(bytes))).ok).toBe(true);
    const stagedPath = join(
      install.installDir as string,
      'staging',
      'staged',
      'tmex-cli-1.2.3.tgz'
    );
    expect(controller.tryStart('1.2.3', { source: 'staged', sha256: hex }).ok).toBe(true);
    for (let i = 0; i < 50 && existsSync(stagedPath); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(stagedPath)).toBe(false);
    expect(controller.status().state).toBe('downloading');
    const result = await controller.cancel();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.status.error).toBe(UPGRADE_CANCELLED);
    expect(stagingEntries(install.installDir as string)).toEqual([]);
    const stagedDir = join(install.installDir as string, 'staging', 'staged');
    const leftover = existsSync(stagedDir) ? readdirSync(stagedDir) : [];
    expect(leftover).toEqual([]);
  });

  test('cancel racing a finishing download is either full cleanup or uncancelled executing', async () => {
    const install = makeInstall();
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const controller = new UpgradeController({
      getInstallInfo: () => install,
      stageRelease: async (stageDir) => {
        writeFileSync(join(stageDir, 'partial.tgz'), 'x');
        await gate;
        return '/tmp/pkg/bin/tmex.js';
      },
      spawn: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child as unknown as ChildProcess;
      },
    });
    expect(controller.start('1.2.3')).toBe(true);
    await settle();
    const cancelPromise = controller.cancel();
    finish();
    const result = await cancelPromise;
    const status = controller.status();
    if (result.ok) {
      expect(status.state).toBe('idle');
      expect(status.error).toBe(UPGRADE_CANCELLED);
      expect(status.targetVersion).toBeNull();
      expect(stagingEntries(install.installDir as string)).toEqual([]);
    } else {
      expect(result.code).toBe('UPGRADE_NOT_CANCELLABLE');
      for (let i = 0; i < 50 && controller.status().state !== 'executing'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(controller.status().state).toBe('executing');
      expect(controller.status().error).not.toBe(UPGRADE_CANCELLED);
    }
  });

  test('orphan .part and txn leftovers from a crashed cancel are pruned on the next start', async () => {
    const install = makeInstall();
    const installDir = install.installDir as string;
    const stagedDir = join(installDir, 'staging', 'staged');
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(join(stagedDir, 'tmex-cli-1.2.3.tgz.part-deadbeef'), 'partial');
    const txnDir = join(installDir, 'staging', 'dead-txn');
    mkdirSync(txnDir, { recursive: true });
    writeFileSync(join(txnDir, 'tmex-cli-1.2.3.tgz.part'), 'x');
    const cacheDir = join(installDir, 'staging', 'release-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'tmex-cli-1.2.3.tgz.part'), 'x');
    writeFileSync(join(cacheDir, 'tmex-cli-0.0.1.tgz'), 'orphan-final');
    writeFileSync(join(cacheDir, 'tmex-cli-9.9.9.tgz'), 'keep');
    writeFileSync(join(cacheDir, 'tmex-cli-9.9.9.tgz.sha256'), `${'cd'.repeat(32)}\n`);
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => install,
      stageRelease: async () => '/tmp/pkg/bin/tmex.js',
      spawn: () => child as unknown as ChildProcess,
    });
    expect(controller.start('8.8.8')).toBe(true);
    await settle();
    expect(existsSync(join(stagedDir, 'tmex-cli-1.2.3.tgz.part-deadbeef'))).toBe(false);
    expect(existsSync(txnDir)).toBe(false);
    expect(existsSync(join(cacheDir, 'tmex-cli-1.2.3.tgz.part'))).toBe(false);
    expect(existsSync(join(cacheDir, 'tmex-cli-0.0.1.tgz'))).toBe(false);
    expect(existsSync(join(cacheDir, 'tmex-cli-9.9.9.tgz'))).toBe(true);
    child.emit('spawn');
    await settle();
  });

  test('orphan staged sidecar without a tarball is pruned on the next start', async () => {
    const install = makeInstall();
    const installDir = install.installDir as string;
    const stagedDir = join(installDir, 'staging', 'staged');
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(
      join(stagedDir, 'tmex-cli-1.2.3.json'),
      `${JSON.stringify({
        version: '1.2.3',
        sha256: 'ab'.repeat(32),
        path: join(stagedDir, 'tmex-cli-1.2.3.tgz'),
        bytes: 12,
        stagedAt: '2026-09-01T00:00:00.000Z',
      })}\n`
    );
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    const controller = new UpgradeController({
      getInstallInfo: () => install,
      stageRelease: async () => '/tmp/pkg/bin/tmex.js',
      spawn: () => child as unknown as ChildProcess,
    });
    expect(controller.start('8.8.8')).toBe(true);
    await settle();
    expect(existsSync(join(stagedDir, 'tmex-cli-1.2.3.json'))).toBe(false);
    expect(existsSync(join(stagedDir, 'tmex-cli-1.2.3.tgz'))).toBe(false);
    child.emit('spawn');
    await settle();
  });

  test('aborted PUT over an in-memory link leaves staging/staged empty', async () => {
    const { createInMemoryLinkPair } = await import('@tmex/shared/link');
    const { acceptHttpStream, openHttpStream } = await import('../mesh/stream-targets');
    const install = makeInstall();
    const controller = new UpgradeController({ getInstallInfo: () => install });
    const [local, remote] = createInMemoryLinkPair();
    remote.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry',
        sessionStore: {
          verify: () => ({ ok: true, session: { userId: 'user-1' } }),
        } as never,
        async dispatchHttp(req) {
          const url = new URL(req.url);
          const version = url.searchParams.get('version') ?? '';
          const sha256 = url.searchParams.get('sha256') ?? '';
          const result = await controller.stagePackage(version, sha256, req.body);
          if (!result.ok) {
            return new Response(JSON.stringify({ code: result.code }), {
              status: result.status,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      });
    });
    const ac = new AbortController();
    const chunk = new Uint8Array(16 * 1024).fill(7);
    const rawBody = new ReadableStream<Uint8Array>({
      pull(ctl) {
        ctl.enqueue(chunk);
      },
      cancel() {
        ac.abort();
      },
    });
    const pending = openHttpStream(
      local,
      {
        method: 'PUT',
        path: '/api/system/upgrade/package',
        query: `?version=1.2.3&sha256=${'ab'.repeat(32)}`,
        headers: { 'content-type': 'application/octet-stream' },
        origin: 'http://localhost',
        auth: 'remote-sid',
      },
      rawBody,
      ac.signal
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    ac.abort();
    await rawBody.cancel().catch(() => {});
    await pending.catch(() => {});
    await settle();
    const stagedDir = join(install.installDir as string, 'staging', 'staged');
    const leftover = existsSync(stagedDir) ? readdirSync(stagedDir) : [];
    expect(leftover).toEqual([]);
  }, 8_000);
});

describe('cmdlineOwnsInstallRuntime', () => {
  test('requires bun/node and an argv token equal to the runtime path', () => {
    const dir = '/tmp/tmex-install-own';
    const serverJs = join(dir, 'current', 'runtime', 'server.js');
    expect(cmdlineOwnsInstallRuntime(`bun ${serverJs}`, dir)).toBe(true);
    expect(cmdlineOwnsInstallRuntime(`/opt/homebrew/bin/node ${serverJs}`, dir)).toBe(true);
    expect(cmdlineOwnsInstallRuntime(`vim ${serverJs}`, dir)).toBe(false);
    expect(cmdlineOwnsInstallRuntime(`tail -f ${serverJs}`, dir)).toBe(false);
    expect(cmdlineOwnsInstallRuntime(`bun ${serverJs}.bak`, dir)).toBe(false);
  });
});
