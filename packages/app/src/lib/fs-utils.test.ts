import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTALL_PRIVATE_SUBDIRS,
  chmodDbTrio,
  chmodPrivateFile,
  ensurePrivateDir,
  hardenInstallTree,
} from './fs-utils';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-fs-utils-'));
  tempDirs.push(dir);
  return dir;
}

describe('ensurePrivateDir', () => {
  test('creates 0700 and repairs a world-writable existing dir', async () => {
    const root = await tempRoot();
    const path = join(root, 'data');
    await mkdir(path, { recursive: true, mode: 0o775 });
    await chmod(path, 0o775);
    await ensurePrivateDir(path);
    expect((await lstat(path)).mode & 0o777).toBe(0o700);
  });

  test('chmods an owned symlink target and leaves the link itself', async () => {
    const root = await tempRoot();
    const real = join(root, 'real');
    const link = join(root, 'link');
    await mkdir(real, { recursive: true, mode: 0o755 });
    await chmod(real, 0o755);
    await symlink(real, link);
    await ensurePrivateDir(link);
    expect((await lstat(real)).mode & 0o777).toBe(0o700);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});

describe('chmodPrivateFile / chmodDbTrio', () => {
  test('sets 0600 on a regular file and skips a symlink', async () => {
    const root = await tempRoot();
    const file = join(root, 'vibeterm.log');
    const target = join(root, 'secret');
    const link = join(root, 'linked.log');
    await writeFile(file, 'log', { mode: 0o644 });
    await writeFile(target, 'secret', { mode: 0o644 });
    await symlink(target, link);
    await chmodPrivateFile(file);
    await chmodPrivateFile(link);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(target)).mode & 0o777).toBe(0o644);
  });

  test('sets 0600 on db / wal / shm', async () => {
    const root = await tempRoot();
    const db = join(root, 'vibeterm.db');
    await writeFile(db, 'db', { mode: 0o644 });
    await writeFile(`${db}-wal`, 'wal', { mode: 0o644 });
    await writeFile(`${db}-shm`, 'shm', { mode: 0o644 });
    await chmodDbTrio(db);
    expect((await lstat(db)).mode & 0o777).toBe(0o600);
    expect((await lstat(`${db}-wal`)).mode & 0o777).toBe(0o600);
    expect((await lstat(`${db}-shm`)).mode & 0o777).toBe(0o600);
  });
});

describe('hardenInstallTree', () => {
  test('forces install root and private subdirs to 0700 and logs/pid/db to 0600', async () => {
    const installDir = await tempRoot();
    const databasePath = join(installDir, 'data', 'vibeterm.db');
    await mkdir(join(installDir, 'data'), { recursive: true });
    await writeFile(join(installDir, 'vibeterm.pid'), '1', { mode: 0o644 });
    await writeFile(join(installDir, 'vibeterm.log'), 'log', { mode: 0o644 });
    await writeFile(databasePath, 'db', { mode: 0o644 });
    await chmod(installDir, 0o755);
    await hardenInstallTree(installDir, databasePath);
    expect((await lstat(installDir)).mode & 0o777).toBe(0o700);
    for (const name of INSTALL_PRIVATE_SUBDIRS) {
      expect((await lstat(join(installDir, name))).mode & 0o777).toBe(0o700);
    }
    expect((await lstat(join(installDir, 'vibeterm.pid'))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(installDir, 'vibeterm.log'))).mode & 0o777).toBe(0o600);
    expect((await lstat(databasePath)).mode & 0o777).toBe(0o600);
  });

  test('chmods an owned data symlink target and does not throw', async () => {
    const installDir = await tempRoot();
    const realData = join(installDir, 'real-data');
    await mkdir(realData, { recursive: true, mode: 0o755 });
    await chmod(realData, 0o755);
    await symlink(realData, join(installDir, 'data'));
    await hardenInstallTree(installDir);
    expect((await lstat(realData)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(installDir, 'data'))).isSymbolicLink()).toBe(true);
  });

  test('warns and continues when a dir is owned by another uid', async () => {
    const installDir = await tempRoot();
    const warns: string[] = [];
    const uid = process.getuid?.() ?? 0;
    await hardenInstallTree(installDir, undefined, {
      lstat: async (path) => {
        const st = await lstat(path);
        return {
          isSymbolicLink: () => st.isSymbolicLink(),
          isDirectory: () => st.isDirectory(),
          uid: path === installDir ? uid + 1 : st.uid,
        };
      },
      stat: async (path) => {
        const st = await lstat(path);
        return { isDirectory: () => st.isDirectory(), uid: st.uid };
      },
      mkdir,
      chmodDir: () => {
        throw new Error('chmodDir should not run on a foreign-owned dir');
      },
      chmodFollow: async () => {
        throw new Error('chmodFollow should not run on a foreign-owned dir');
      },
      getuid: () => uid,
      warn: (message) => warns.push(message),
    });
    expect(warns.some((line) => line.includes(installDir) && line.includes('owned by uid'))).toBe(
      true
    );
    expect((await lstat(installDir)).isDirectory()).toBe(true);
  });

  test('warns and continues when chmod hits EPERM', async () => {
    const installDir = await tempRoot();
    const warns: string[] = [];
    const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    await hardenInstallTree(installDir, undefined, {
      lstat,
      stat,
      mkdir,
      chmodDir: () => {
        throw denied;
      },
      chmodFollow: async () => {
        throw denied;
      },
      getuid: () => process.getuid?.() ?? 0,
      warn: (message) => warns.push(message),
    });
    expect(warns.some((line) => line.includes('permission denied'))).toBe(true);
  });
});
