import { constants, closeSync, fchmodSync, fsyncSync, openSync } from 'node:fs';
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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

export const INSTALL_PRIVATE_SUBDIRS = ['data', 'versions', 'backups', 'staging'] as const;
const INSTALL_PRIVATE_FILES = [
  'vibeterm.pid',
  'tmex.pid',
  'vibeterm.log',
  'vibeterm.err.log',
  'tmex.log',
  'tmex.err.log',
  'upgrade.log',
] as const;

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function chmodDirNoFollow(path: string, mode: number): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW);
  try {
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

function chmodFileNoFollow(path: string, mode: number): void {
  const fd = openSync(path, constants.O_WRONLY | O_NOFOLLOW);
  try {
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

function isPermDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EACCES';
}

export type HardenDirOps = {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; uid: number }>;
  stat(path: string): Promise<{ isDirectory(): boolean; uid: number }>;
  mkdir(path: string, opts: { recursive: boolean; mode: number }): Promise<unknown>;
  chmodDir(path: string, mode: number): void;
  chmodFollow(path: string, mode: number): Promise<unknown>;
  getuid(): number;
  warn(message: string): void;
};

const defaultHardenOps: HardenDirOps = {
  lstat,
  stat,
  mkdir,
  chmodDir: chmodDirNoFollow,
  chmodFollow: (path, mode) => chmod(path, mode),
  getuid: () => process.getuid?.() ?? 0,
  warn: (message) => console.warn(`[install] ${message}`),
};

/** 安装树私有目录：显式 0700。新建失败才抛；已有路径（含符号链接、他人所有）只告警。 */
export async function ensurePrivateDir(
  path: string,
  ops: HardenDirOps = defaultHardenOps
): Promise<void> {
  let st: Awaited<ReturnType<HardenDirOps['lstat']>>;
  try {
    st = await ops.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await ops.mkdir(path, { recursive: true, mode: 0o700 });
      return;
    }
    if (isPermDenied(error)) {
      ops.warn(`skipping chmod of ${path}: permission denied`);
      return;
    }
    ops.warn(
      `skipping chmod of ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  await chmodExistingPrivateDir(path, st, ops);
}

async function chmodExistingPrivateDir(
  path: string,
  st: Awaited<ReturnType<HardenDirOps['lstat']>>,
  ops: HardenDirOps
): Promise<void> {
  const uid = ops.getuid();
  try {
    if (st.isSymbolicLink()) {
      const target = await ops.stat(path);
      if (!target.isDirectory()) {
        ops.warn(`skipping chmod of ${path}: symlink target is not a directory`);
        return;
      }
      if (target.uid !== uid) {
        ops.warn(
          `skipping chmod of ${path}: symlink target uid ${target.uid} is not the current user`
        );
        return;
      }
      await ops.chmodFollow(path, 0o700);
      return;
    }
    if (!st.isDirectory()) {
      ops.warn(`skipping chmod of ${path}: not a directory`);
      return;
    }
    if (st.uid !== uid) {
      ops.warn(`skipping chmod of ${path}: owned by uid ${st.uid}`);
      return;
    }
    ops.chmodDir(path, 0o700);
  } catch (error) {
    if (isPermDenied(error)) {
      ops.warn(`skipping chmod of ${path}: permission denied`);
      return;
    }
    ops.warn(
      `skipping chmod of ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function chmodPrivateFile(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink() || !st.isFile()) return;
    chmodFileNoFollow(path, 0o600);
  } catch {
    // missing, symlink, or raced
  }
}

export async function chmodDbTrio(dbPath: string): Promise<void> {
  if (!dbPath || dbPath === ':memory:' || dbPath.includes(':memory:')) return;
  for (const suffix of ['', '-wal', '-shm'] as const) {
    await chmodPrivateFile(`${dbPath}${suffix}`);
  }
}

/** init / upgrade apply 都走这里：安装根与 data/versions/backups/staging 一律 0700。 */
export async function hardenInstallTree(
  installDir: string,
  databasePath?: string,
  ops: HardenDirOps = defaultHardenOps
): Promise<void> {
  await ensurePrivateDir(installDir, ops);
  for (const name of INSTALL_PRIVATE_SUBDIRS) {
    await ensurePrivateDir(join(installDir, name), ops);
  }
  for (const name of INSTALL_PRIVATE_FILES) {
    await chmodPrivateFile(join(installDir, name));
  }
  if (databasePath) {
    await ensurePrivateDir(dirname(databasePath), ops);
    await chmodDbTrio(databasePath);
  }
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
