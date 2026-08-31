import { spawnSync } from 'node:child_process';
import { copyFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ensureDir, fsyncDirBestEffort, fsyncPath, pathExists } from './fs-utils';

export const DB_SUFFIXES = ['', '-wal', '-shm'] as const;

export async function copyDbTrio(srcDb: string, destDir: string): Promise<string[]> {
  await ensureDir(destDir);
  const copied: string[] = [];
  const base = basename(srcDb);
  for (const suffix of DB_SUFFIXES) {
    const src = `${srcDb}${suffix}`;
    if (!(await pathExists(src))) continue;
    const dest = join(destDir, `${base}${suffix}`);
    await copyFile(src, dest);
    fsyncPath(dest);
    copied.push(dest);
  }
  fsyncDirBestEffort(destDir);
  return copied;
}

export async function restoreDbTrio(backupDir: string, destDb: string): Promise<void> {
  await ensureDir(dirname(destDb));
  const base = basename(destDb);
  for (const suffix of DB_SUFFIXES) {
    await rm(`${destDb}${suffix}`, { force: true });
  }
  for (const suffix of DB_SUFFIXES) {
    const src = join(backupDir, `${base}${suffix}`);
    if (!(await pathExists(src))) continue;
    const dest = `${destDb}${suffix}`;
    await copyFile(src, dest);
    fsyncPath(dest);
  }
  fsyncDirBestEffort(dirname(destDb));
}

function vacuumIntoScript(): string {
  return [
    'import { Database } from "bun:sqlite";',
    'const src = process.argv[2];',
    'const dest = process.argv[3];',
    'const db = new Database(src);',
    'try { db.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}',
    'const escaped = dest.replaceAll("\'", "\'\'");',
    'db.run("VACUUM INTO \'" + escaped + "\'");',
    'db.close();',
  ].join('\n');
}

export async function copyPreflightDb(
  srcDb: string,
  destDir: string,
  bunPath: string
): Promise<void> {
  await ensureDir(destDir);
  const dest = join(destDir, basename(srcDb));
  const result = spawnSync(bunPath, ['-e', vacuumIntoScript(), srcDb, dest], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status === 0 && (await pathExists(dest))) {
    fsyncPath(dest);
    fsyncDirBestEffort(destDir);
    return;
  }
  await copyDbTrio(srcDb, destDir);
}
