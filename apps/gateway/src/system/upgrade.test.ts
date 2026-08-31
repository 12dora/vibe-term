import { afterEach, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseTarballName, releaseTarballUrl } from '@tmex/shared';
import type { InstallInfo } from './install-info';
import {
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
const tempDirs: string[] = [];
const liveChildren: ChildProcess[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
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
