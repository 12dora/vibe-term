import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLOUDFLARED_PINNED_VERSION,
  CLOUDFLARED_PINS,
  type CloudflaredPin,
  ManagedBinaryHashCache,
  classifyManagedBinary,
  lookupCloudflaredPin,
  sha256Bytes,
  sha256File,
} from './cloudflared-pins';
import { MemoryTunnelConfigStore } from './config-store';
import { installCloudflaredBinary } from './download';
import { TunnelError, tunnelHttpStatus } from './errors';
import { FakeSpawner, argsInclude } from './fake-spawn';
import { TunnelManager } from './manager';
import { cloudflaredDownloadSpec, isTunnelPlatformSupported } from './platform';
import { CloudflaredProvider, managedBinaryPath } from './provider';

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function pinFor(content: string, tgz = false): CloudflaredPin {
  const hash = sha256Bytes(content);
  return {
    id: 'linux-arm64',
    version: '2025.8.1',
    fileName: tgz ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-linux-arm64',
    url: `https://github.com/cloudflare/cloudflared/releases/download/2025.8.1/${tgz ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-linux-arm64'}`,
    tgz,
    downloadSha256: hash,
    binarySha256: hash,
  };
}

async function waitJob(manager: TunnelManager, timeoutMs = 2_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = manager.status().job;
    if (job && job.state !== 'running') return job;
    await Bun.sleep(5);
  }
  throw new Error(`job did not finish: ${JSON.stringify(manager.status().job)}`);
}

async function setupManager(opts: {
  pin: CloudflaredPin;
  payload?: string;
  downloader?: (url: string, dest: string) => Promise<void>;
}) {
  const dir = await tempDir('vibeterm-pin-');
  const homeDir = await tempDir('vibeterm-pin-home-');
  const payload = opts.payload ?? 'fake-cloudflared';
  const spawner = new FakeSpawner();
  spawner.on((s) => argsInclude(s, '--version'), {
    stdout: 'cloudflared version 2025.8.1 (built 2025-08-01T00:00:00Z)\n',
  });
  const manager = new TunnelManager({
    tunnelDir: dir,
    homeDir,
    originPort: 19883,
    platform: 'linux',
    arch: 'arm64',
    store: new MemoryTunnelConfigStore(),
    spawner: spawner.spawn,
    which: () => null,
    cloudflaredPin: opts.pin,
    downloader:
      opts.downloader ??
      (async (_url, dest) => {
        await Bun.write(dest, payload);
      }),
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
    loginTimeoutMs: 200,
    loginPollMs: 5,
    killTimeoutMs: 20,
    runningWaitMs: 800,
    trustProxy: false,
    loginEnforced: () => true,
    registerAccessGuard: false,
    externalDetectDeps: {
      listProcesses: async () => '',
      readFile: async () => null,
      listDir: async () => [],
      homedir: () => homeDir,
      platform: 'linux',
    },
  });
  return { dir, spawner, manager };
}

describe('cloudflared pins', () => {
  test('download URL is version-pinned and not latest', () => {
    const linux = cloudflaredDownloadSpec('linux', 'x64');
    expect(linux.url).toBe(
      `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_PINNED_VERSION}/cloudflared-linux-amd64`
    );
    expect(linux.url).not.toContain('/latest/');
    expect(lookupCloudflaredPin('linux', 'x64')).toEqual(CLOUDFLARED_PINS['linux-amd64']);
    expect(lookupCloudflaredPin('darwin', 'arm64')?.tgz).toBe(true);
    expect(isTunnelPlatformSupported('linux', 'arm64')).toBe(true);
  });

  test('mismatch on download leaves the installed binary untouched', async () => {
    const dir = await tempDir('vibeterm-pin-dl-');
    const dest = join(dir, 'cloudflared');
    await Bun.write(dest, 'keep-me');
    const pin = pinFor('good-bytes');
    let fetchedUrl = '';
    await expect(
      installCloudflaredBinary({
        tunnelDir: dir,
        destPath: dest,
        platform: 'linux',
        arch: 'arm64',
        pin,
        downloader: async (url, tmp) => {
          fetchedUrl = url;
          await Bun.write(tmp, 'wrong-bytes');
        },
      })
    ).rejects.toMatchObject({ code: 'binary_checksum_mismatch' });
    expect(fetchedUrl).toBe(pin.url);
    expect(await readFile(dest, 'utf8')).toBe('keep-me');
    const leftovers = await readdir(dir);
    expect(leftovers.filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(leftovers).toContain('cloudflared');
  });

  test('darwin download verifies archive then extracted binary', async () => {
    const dir = await tempDir('vibeterm-pin-tgz-');
    const payload = 'darwin-cloudflared';
    const staging = await tempDir('vibeterm-pin-tgz-src-');
    await Bun.write(join(staging, 'cloudflared'), payload);
    const tgz = join(staging, 'archive.tgz');
    const tar = Bun.spawn(['tar', '-czf', tgz, '-C', staging, 'cloudflared'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await tar.exited).toBe(0);
    const archiveBytes = new Uint8Array(await Bun.file(tgz).arrayBuffer());
    const pin: CloudflaredPin = {
      id: 'darwin-arm64',
      version: CLOUDFLARED_PINNED_VERSION,
      fileName: 'cloudflared-darwin-arm64.tgz',
      url: CLOUDFLARED_PINS['darwin-arm64'].url,
      tgz: true,
      downloadSha256: sha256Bytes(archiveBytes),
      binarySha256: sha256Bytes(payload),
    };
    const dest = join(dir, 'cloudflared');
    await installCloudflaredBinary({
      tunnelDir: dir,
      destPath: dest,
      platform: 'darwin',
      arch: 'arm64',
      pin,
      downloader: async (_url, tmp) => {
        await Bun.write(tmp, archiveBytes);
      },
    });
    expect(await readFile(dest, 'utf8')).toBe(payload);
    expect(await sha256File(dest)).toBe(pin.binarySha256);
  });

  test('mismatch before spawn does not start the process', async () => {
    const dir = await tempDir('vibeterm-pin-spawn-');
    const bin = managedBinaryPath(dir);
    const good = 'good-managed';
    const pin = pinFor(good);
    await Bun.write(bin, good);
    const spawner = new FakeSpawner();
    const provider = new CloudflaredProvider(spawner.spawn, dir, async () => 1, { pin });
    provider.spawn(bin, ['--version']);
    expect(spawner.calls).toHaveLength(1);
    await Bun.write(bin, 'tampered');
    expect(() => provider.spawn(bin, ['tunnel', 'run'])).toThrow(TunnelError);
    try {
      provider.spawn(bin, ['tunnel', 'run']);
    } catch (error) {
      expect(error).toBeInstanceOf(TunnelError);
      expect((error as TunnelError).code).toBe('binary_checksum_mismatch');
    }
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls.some((c) => argsInclude(c, 'run'))).toBe(false);
  });

  test('hash cache keys on inode, mtime and size', async () => {
    const dir = await tempDir('vibeterm-pin-cache-');
    const path = join(dir, 'cloudflared');
    await Bun.write(path, 'same-bytes');
    let digestCalls = 0;
    const cache = new ManagedBinaryHashCache(() => {
      digestCalls += 1;
      return 'abc';
    });
    expect(cache.hash(path)).toBe('abc');
    expect(cache.hash(path)).toBe('abc');
    expect(digestCalls).toBe(1);
    await Bun.write(path, 'same-bytes!');
    expect(cache.hash(path)).toBe('abc');
    expect(digestCalls).toBe(2);
  });

  test('unpinned legacy managed binary is reinstalled on start', async () => {
    const pin = pinFor('fake-cloudflared');
    const ctx = await setupManager({ pin });
    const dest = managedBinaryPath(ctx.dir);
    await Bun.write(dest, 'legacy-unpinned');
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://a.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(await readFile(dest, 'utf8')).toBe('fake-cloudflared');
    expect(await sha256File(dest)).toBe(pin.binarySha256);
  });

  test('pinned version with the wrong hash is a mismatch, not a reinstall', async () => {
    const pin = pinFor('fake-cloudflared');
    let downloads = 0;
    const ctx = await setupManager({
      pin,
      downloader: async (_url, tmp) => {
        downloads += 1;
        await Bun.write(tmp, 'fake-cloudflared');
      },
    });
    await ctx.manager.handleAction({ action: 'install' });
    expect((await waitJob(ctx.manager))?.state).toBe('done');
    expect(downloads).toBe(1);
    await Bun.write(managedBinaryPath(ctx.dir), 'tampered-pinned');
    ctx.spawner.on((s) => argsInclude(s, '--url'), { hold: true, stdout: 'x\n' });
    await ctx.manager.handleAction({ action: 'quick_start' });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('error');
    expect(job?.error?.code).toBe('binary_checksum_mismatch');
    expect(ctx.spawner.calls.some((c) => argsInclude(c, '--url'))).toBe(false);
    expect(downloads).toBe(1);
  });

  test('classify treats unknown hash without a pinned claim as outdated', () => {
    const pin = pinFor('good');
    expect(classifyManagedBinary(sha256Bytes('good'), pin, '2025.8.1')).toBe('ok');
    expect(classifyManagedBinary(sha256Bytes('old'), pin, null)).toBe('outdated');
    expect(classifyManagedBinary(sha256Bytes('old'), pin, '2024.1.0')).toBe('outdated');
    expect(classifyManagedBinary(sha256Bytes('evil'), pin, '2025.8.1')).toBe('mismatch');
  });

  test('checksum mismatch maps to HTTP 400', () => {
    expect(tunnelHttpStatus('binary_checksum_mismatch')).toBe(400);
  });
});
