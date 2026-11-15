import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '@vibeterm/shared';
import {
  type CloudflaredPin,
  checksumMismatch,
  classifyManagedBinary,
  hashesEqual,
  lookupCloudflaredPin,
  sha256File,
} from './cloudflared-pins';
import { TunnelError } from './errors';

export type Downloader = (url: string, destPath: string) => Promise<void>;

export async function defaultDownloader(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new TunnelError('download_failed', `download failed: HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Bun.write(destPath, bytes);
}

async function findExtractedBinary(dir: string): Promise<string> {
  const entries = await readdir(dir);
  if (entries.includes('cloudflared')) {
    return join(dir, 'cloudflared');
  }
  for (const name of entries) {
    const full = join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) {
      try {
        return await findExtractedBinary(full);
      } catch {
        // 继续扫其他子目录
      }
    }
  }
  throw new TunnelError('download_failed', 'extracted archive does not contain cloudflared');
}

async function assertFileSha256(path: string, expected: string): Promise<void> {
  const actual = await sha256File(path);
  if (!hashesEqual(actual, expected)) throw checksumMismatch();
}

async function extractArchive(archive: string, extractDir: string): Promise<string> {
  await mkdir(extractDir, { recursive: true });
  const tar = Bun.spawn(['tar', '-xzf', archive, '-C', extractDir], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const code = await tar.exited;
  if (code !== 0) {
    throw new TunnelError('download_failed', 'failed to extract cloudflared archive');
  }
  return findExtractedBinary(extractDir);
}

function resolveInstallPin(opts: {
  platform: NodeJS.Platform;
  arch: string;
  pin?: CloudflaredPin | null;
}): CloudflaredPin {
  const pin = opts.pin ?? lookupCloudflaredPin(opts.platform, opts.arch);
  if (!pin) {
    throw new TunnelError(
      'unsupported_platform',
      `unsupported platform ${opts.platform}-${opts.arch}`
    );
  }
  return pin;
}

export async function installCloudflaredBinary(opts: {
  tunnelDir: string;
  destPath: string;
  platform: NodeJS.Platform;
  arch: string;
  downloader: Downloader;
  pin?: CloudflaredPin | null;
}): Promise<void> {
  const pin = resolveInstallPin(opts);
  await mkdir(opts.tunnelDir, { recursive: true });
  const tmpPath = `${opts.destPath}.${process.pid}.tmp`;
  const extractDir = `${tmpPath}.extract`;
  try {
    await opts.downloader(pin.url, tmpPath);
    await assertFileSha256(tmpPath, pin.downloadSha256);
    let binaryPath = tmpPath;
    if (pin.tgz) {
      binaryPath = await extractArchive(tmpPath, extractDir);
      await assertFileSha256(binaryPath, pin.binarySha256);
    }
    await chmod(binaryPath, 0o755);
    await rename(binaryPath, opts.destPath);
    await chmod(opts.destPath, 0o755);
    await rm(extractDir, { recursive: true, force: true });
    await rm(tmpPath, { force: true });
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof TunnelError) throw error;
    throw new TunnelError('download_failed', errorMessage(error));
  }
}

export async function reconcileManagedCloudflared(opts: {
  tunnelDir: string;
  destPath: string;
  platform: NodeJS.Platform;
  arch: string;
  downloader: Downloader;
  pin: CloudflaredPin;
  claimedVersion: string | null;
}): Promise<void> {
  const hash = await sha256File(opts.destPath).catch(() => null);
  const verdict = classifyManagedBinary(hash, opts.pin, opts.claimedVersion);
  if (verdict === 'ok') return;
  if (verdict === 'mismatch') throw checksumMismatch();
  await installCloudflaredBinary(opts);
}
