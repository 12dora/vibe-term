import { lstat, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { atomicSymlink, pathExists } from './fs-utils';

export function currentLinkPath(installDir: string): string {
  return join(installDir, 'current');
}

export function versionDirPath(installDir: string, version: string): string {
  return join(installDir, 'versions', version);
}

export function currentRelativeTarget(version: string): string {
  return join('versions', version);
}

export async function readCurrentVersion(installDir: string): Promise<string | null> {
  const link = currentLinkPath(installDir);
  try {
    const st = await lstat(link);
    if (!st.isSymbolicLink()) return null;
    const target = await readlink(link);
    const version = basename(target);
    return version || null;
  } catch {
    return null;
  }
}

export async function switchCurrent(installDir: string, version: string): Promise<void> {
  const target = currentRelativeTarget(version);
  const dest = join(installDir, 'versions', version);
  if (!(await pathExists(dest))) {
    throw new Error(`version directory missing: ${dest}`);
  }
  await atomicSymlink(target, currentLinkPath(installDir));
}
