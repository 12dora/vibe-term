import { constants, closeSync, fsyncSync, openSync } from 'node:fs';
import { access, cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function copyDirectory(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, force: true });
}

export function fsyncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function fsyncDirBestEffort(path: string): void {
  try {
    fsyncPath(path);
  } catch {
    // directory fsync is best-effort (some FS/OS combinations refuse it)
  }
}

export async function writeText(path: string, content: string, mode?: number): Promise<void> {
  await writeTextAtomic(path, content, mode);
}

export async function writeTextAtomic(path: string, content: string, mode?: number): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: 'utf8', mode });
    fsyncPath(tmp);
    await rename(tmp, path);
    fsyncDirBestEffort(dirname(path));
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => null);
    throw error;
  }
}

export async function writeBytesAtomic(
  path: string,
  data: Uint8Array,
  mode?: number
): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, data, { mode });
    fsyncPath(tmp);
    await rename(tmp, path);
    fsyncDirBestEffort(dirname(path));
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => null);
    throw error;
  }
}

export async function atomicSymlink(target: string, linkPath: string): Promise<void> {
  const tmp = `${linkPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await rm(tmp, { force: true });
    await symlink(target, tmp);
    await rename(tmp, linkPath);
    fsyncDirBestEffort(dirname(linkPath));
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => null);
    throw error;
  }
}

export async function readText(path: string): Promise<string> {
  return await readFile(path, 'utf8');
}

export function resolvePath(...parts: string[]): string {
  return resolve(...parts);
}
