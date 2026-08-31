import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from './fs-utils';
import { copyDbTrio, copyPreflightDb, restoreDbTrio, vacuumIntoScript } from './upgrade-db';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('restoreDbTrio', () => {
  test('removes leftover WAL/SHM then restores exactly the backed-up set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmex-db-'));
    tempDirs.push(root);
    const live = join(root, 'data');
    const backup = join(root, 'backup');
    await mkdir(live, { recursive: true });
    await mkdir(backup, { recursive: true });
    const destDb = join(live, 'tmex.db');
    await writeFile(destDb, 'new-db');
    await writeFile(`${destDb}-wal`, 'new-wal');
    await writeFile(`${destDb}-shm`, 'new-shm');
    await writeFile(join(backup, 'tmex.db'), 'old-db');

    await restoreDbTrio(backup, destDb);

    expect(await readFile(destDb, 'utf8')).toBe('old-db');
    expect(await pathExists(`${destDb}-wal`)).toBe(false);
    expect(await pathExists(`${destDb}-shm`)).toBe(false);
  });

  test('restores wal and shm when the backup contains them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmex-db-full-'));
    tempDirs.push(root);
    const live = join(root, 'data');
    const backup = join(root, 'backup');
    await mkdir(live, { recursive: true });
    await mkdir(backup, { recursive: true });
    const destDb = join(live, 'tmex.db');
    await writeFile(destDb, 'new-db');
    await writeFile(`${destDb}-wal`, 'new-wal');
    await writeFile(join(backup, 'tmex.db'), 'old-db');
    await writeFile(join(backup, 'tmex.db-wal'), 'old-wal');

    await restoreDbTrio(backup, destDb);

    expect(await readFile(destDb, 'utf8')).toBe('old-db');
    expect(await readFile(`${destDb}-wal`, 'utf8')).toBe('old-wal');
    expect(await pathExists(`${destDb}-shm`)).toBe(false);
  });
});

describe('copyDbTrio', () => {
  test('copies only existing members of the trio', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmex-db-copy-'));
    tempDirs.push(root);
    const srcDb = join(root, 'tmex.db');
    await writeFile(srcDb, 'db');
    await writeFile(`${srcDb}-wal`, 'wal');
    const dest = join(root, 'out');
    const copied = await copyDbTrio(srcDb, dest);
    expect(copied).toHaveLength(2);
    expect(await readFile(join(dest, 'tmex.db'), 'utf8')).toBe('db');
    expect(await pathExists(join(dest, 'tmex.db-shm'))).toBe(false);
  });
});

describe('copyPreflightDb', () => {
  test('vacuum script reads argv[1] and argv[2] and rejects empty paths', () => {
    expect(vacuumIntoScript()).toContain('process.argv[1]');
    expect(vacuumIntoScript()).toContain('process.argv[2]');
    expect(vacuumIntoScript()).toContain('if (!src || !dest)');
  });

  test('VACUUM INTO copies a real sqlite database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmex-db-vacuum-'));
    tempDirs.push(root);
    const srcDb = join(root, 'tmex.db');
    const db = new Database(srcDb);
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    db.run("INSERT INTO items (name) VALUES ('alpha')");
    db.close();
    const destDir = join(root, 'out');
    await copyPreflightDb(srcDb, destDir, process.execPath);
    const dest = new Database(join(destDir, 'tmex.db'));
    try {
      expect(dest.query('SELECT name FROM items').get()).toEqual({ name: 'alpha' });
    } finally {
      dest.close();
    }
  });

  test('passes src and dest after -e to spawnSync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmex-db-argv-'));
    tempDirs.push(root);
    const srcDb = join(root, 'tmex.db');
    await writeFile(srcDb, 'db');
    let captured: string[] = [];
    await copyPreflightDb(srcDb, join(root, 'out'), '/usr/bin/bun', ((cmd, args) => {
      captured = args as string[];
      return { status: 1, stdout: '', stderr: 'fail' };
    }) as typeof import('node:child_process').spawnSync);
    expect(captured[0]).toBe('-e');
    expect(captured[2]).toBe(srcDb);
    expect(captured[3]).toBe(join(root, 'out', 'tmex.db'));
  });
});
