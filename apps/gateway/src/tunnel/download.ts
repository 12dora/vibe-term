import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TunnelError } from './errors';
import { cloudflaredDownloadSpec } from './platform';

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

export async function installCloudflaredBinary(opts: {
  tunnelDir: string;
  destPath: string;
  platform: NodeJS.Platform;
  arch: string;
  downloader: Downloader;
}): Promise<void> {
  await mkdir(opts.tunnelDir, { recursive: true });
  const spec = cloudflaredDownloadSpec(opts.platform, opts.arch);
  const tmpPath = `${opts.destPath}.${process.pid}.tmp`;
  try {
    await opts.downloader(spec.url, tmpPath);
    if (spec.tgz) {
      const extractDir = `${tmpPath}.extract`;
      await mkdir(extractDir, { recursive: true });
      const tar = Bun.spawn(['tar', '-xzf', tmpPath, '-C', extractDir], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      const code = await tar.exited;
      if (code !== 0) {
        throw new TunnelError('download_failed', 'failed to extract cloudflared archive');
      }
      const binary = await findExtractedBinary(extractDir);
      await chmod(binary, 0o755);
      await rename(binary, opts.destPath);
      await rm(extractDir, { recursive: true, force: true });
      await rm(tmpPath, { force: true });
    } else {
      await chmod(tmpPath, 0o755);
      await rename(tmpPath, opts.destPath);
    }
    await chmod(opts.destPath, 0o755);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    if (error instanceof TunnelError) throw error;
    throw new TunnelError(
      'download_failed',
      error instanceof Error ? error.message : String(error)
    );
  }
}
