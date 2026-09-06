// 安装目录迁移：把改名前的默认安装目录整体搬到新默认目录，并把 app.env / DB 文件名对齐新命名。
//
// 触发条件极窄：installDir 恰好等于当前平台的**旧默认路径**，且新默认路径尚不存在。
// 自定义 `--install-dir` 的安装永远不搬家。
//
// 迁移在升级事务里进行（preflight 通过、旧服务停止之后，切换 current 之前），整目录 rename
// 是同卷原子操作；之后的每一个路径都必须按新目录重新推导。
//
// 注意：迁移完成后不支持手动降回 1.x —— 旧 CLI 只认旧目录、旧 label 与 `TMEX_*` 键。
// 本版 run.sh 会把 `VIBETERM_*` 镜像回 `TMEX_*`，因此事务内回滚（rollback / repair）仍安全。

import { readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULT_SERVICE_NAME, legacyInstallDir, newInstallDir } from '../constants';
import { readEnvFile, writeEnvFile } from './env-file';
import { ensureDir, pathExists, writeText } from './fs-utils';

/** 改名前的默认服务名 */
export const LEGACY_SERVICE_NAME = 'tmex';

const ENV_PREFIX = 'VIBETERM_';
const LEGACY_ENV_PREFIX = 'TMEX_';

const LEGACY_DB_BASENAME = 'tmex.db';
const DB_BASENAME = 'vibeterm.db';
const DB_SUFFIXES = ['', '-wal', '-shm'] as const;

export interface DirMigrationPlan {
  fromDir: string;
  toDir: string;
  oldServiceName: string;
  newServiceName: string;
}

export interface DirMigrationRecord {
  fromDir: string;
  toDir: string;
  /** 迁移前 app.env 的备份（位于 toDir/backups 下），回滚时按它还原 */
  envBackup: string | null;
  envRewritten: boolean;
  dbRenamed: boolean;
  oldServiceName: string;
  newServiceName: string;
  oldLabel: string;
}

export function legacyLaunchdLabelFor(serviceName: string): string {
  return `com.tmex.${serviceName}`;
}

/**
 * 判断是否要迁移。只有「旧默认目录 + 新默认目录不存在」才迁移；其余一律返回 null。
 */
export async function planInstallDirMigration(input: {
  installDir: string;
  platform: NodeJS.Platform;
  serviceName: string;
}): Promise<DirMigrationPlan | null> {
  const fromDir = resolve(input.installDir);
  if (fromDir !== resolve(legacyInstallDir(input.platform))) return null;
  const toDir = resolve(newInstallDir(input.platform));
  if (fromDir === toDir) return null;
  if (await pathExists(toDir)) return null;
  return {
    fromDir,
    toDir,
    oldServiceName: input.serviceName,
    newServiceName:
      input.serviceName === LEGACY_SERVICE_NAME ? DEFAULT_SERVICE_NAME : input.serviceName,
  };
}

/** app.env 键改前缀 + 把指向旧目录的值重写到新目录 */
export function rewriteEnvValues(
  values: Record<string, string>,
  fromDir: string,
  toDir: string
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(values)) {
    const key = rawKey.startsWith(LEGACY_ENV_PREFIX)
      ? `${ENV_PREFIX}${rawKey.slice(LEGACY_ENV_PREFIX.length)}`
      : rawKey;
    const value =
      rawValue === fromDir || rawValue.startsWith(`${fromDir}/`)
        ? `${toDir}${rawValue.slice(fromDir.length)}`
        : rawValue;
    // 旧键改名后若与已有新键冲突，以已有新键为准（不覆盖显式写过的值）。
    if (key in next && rawKey !== key) continue;
    next[key] = value;
  }
  return next;
}

/** DB 三件套改名；只处理安装目录 data/ 下的 tmex.db。返回新的 DATABASE_URL，未改名返回 null。 */
async function renameDbTrio(installDir: string, databaseUrl: string | undefined) {
  if (!databaseUrl) return null;
  const dataDir = join(installDir, 'data');
  if (dirname(resolve(databaseUrl)) !== resolve(dataDir)) return null;
  if (basename(databaseUrl) !== LEGACY_DB_BASENAME) return null;
  if (!(await pathExists(join(dataDir, LEGACY_DB_BASENAME)))) return null;
  for (const suffix of DB_SUFFIXES) {
    const from = join(dataDir, `${LEGACY_DB_BASENAME}${suffix}`);
    if (!(await pathExists(from))) continue;
    await rename(from, join(dataDir, `${DB_BASENAME}${suffix}`));
  }
  return join(dataDir, DB_BASENAME);
}

async function renameDbTrioBack(dir: string): Promise<void> {
  for (const suffix of DB_SUFFIXES) {
    const from = join(dir, `${DB_BASENAME}${suffix}`);
    if (!(await pathExists(from))) continue;
    await rename(from, join(dir, `${LEGACY_DB_BASENAME}${suffix}`));
  }
}

/**
 * 目录 rename 之后的收尾：备份并改写 app.env、改 DB 文件名。幂等——`--repair` 在
 * rename 与 env 改写之间崩溃后可以直接再跑一遍补完。
 */
export async function finishInstallDirMigration(
  record: DirMigrationRecord,
  opts: { txnId: string }
): Promise<DirMigrationRecord> {
  const envPath = join(record.toDir, 'app.env');
  if (!(await pathExists(envPath))) return { ...record, envRewritten: true };

  const values = await readEnvFile(envPath);
  const backupPath = record.envBackup ?? join(record.toDir, 'backups', `app.env.${opts.txnId}`);
  if (!(await pathExists(backupPath))) {
    await ensureDir(dirname(backupPath));
    await writeText(backupPath, await readFile(envPath, 'utf8'), 0o600);
  }

  const next = rewriteEnvValues(values, record.fromDir, record.toDir);
  const renamedDb = await renameDbTrio(record.toDir, next.DATABASE_URL);
  if (renamedDb) next.DATABASE_URL = renamedDb;
  await writeEnvFile(envPath, next);

  return {
    ...record,
    envBackup: backupPath,
    envRewritten: true,
    dbRenamed: record.dbRenamed || renamedDb !== null,
  };
}

/**
 * 执行迁移：整目录 rename → 备份并改写 app.env → DB 改名。
 * rename 本身失败（跨卷 / 权限）不算升级失败：返回 null，调用方原地继续升级。
 */
export async function migrateInstallDir(
  plan: DirMigrationPlan,
  opts: { txnId: string }
): Promise<DirMigrationRecord | null> {
  try {
    await rename(plan.fromDir, plan.toDir);
  } catch {
    return null;
  }

  const record: DirMigrationRecord = {
    fromDir: plan.fromDir,
    toDir: plan.toDir,
    envBackup: null,
    envRewritten: false,
    dbRenamed: false,
    oldServiceName: plan.oldServiceName,
    newServiceName: plan.newServiceName,
    oldLabel: legacyLaunchdLabelFor(plan.oldServiceName),
  };

  try {
    return await finishInstallDirMigration(record, opts);
  } catch (error) {
    await revertInstallDirMigration(record).catch(() => null);
    throw error;
  }
}

/**
 * 回滚：还原 DB 文件名与 app.env，再把目录搬回旧路径。
 *
 * 升级事务在迁移之后才做 DB 备份，备份文件用的是改名后的库名；回滚后 `restoreDbTrio`
 * 按 `DATABASE_URL` 的 basename（已还原成旧名）去备份目录找文件，因此备份也必须一起改回来，
 * 否则它会先删掉线上库再找不到备份。
 */
export async function revertInstallDirMigration(
  record: DirMigrationRecord,
  opts?: { txnId?: string }
): Promise<void> {
  if (!(await pathExists(record.toDir))) return;

  if (record.dbRenamed) {
    await renameDbTrioBack(join(record.toDir, 'data')).catch(() => null);
    if (opts?.txnId) {
      await renameDbTrioBack(join(record.toDir, 'backups', opts.txnId)).catch(() => null);
    }
  }
  if (record.envBackup && (await pathExists(record.envBackup))) {
    await writeText(join(record.toDir, 'app.env'), await readFile(record.envBackup, 'utf8'), 0o600);
    await rm(record.envBackup, { force: true }).catch(() => null);
  }
  if (await pathExists(record.fromDir)) return;
  await rename(record.toDir, record.fromDir);
}
