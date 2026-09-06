// 安装迁移：把改名前的默认安装目录整体搬到新默认目录，并把 app.env 的键 / DB 文件名对齐新命名。
//
// 目录搬家的触发条件极窄：installDir 恰好等于当前平台的**旧默认路径**，且新默认路径尚不存在。
// 用 `--install-dir` 指定过自定义目录的安装永远不搬家，但**同样要做 app.env 的键迁移**
// （TMEX_X → VIBETERM_X）——否则像 `relay status` 这类直接读 app.env 的命令会找不到键。
//
// 迁移跑在升级事务里（preflight 通过、旧服务停止之后，切换 current 之前）。每一步做完都把记录写回
// journal，且写在动手之前：崩溃后 `--repair` 拿到的记录一定是实际进度的超集，正反两个方向重跑都幂等。
//
// 注意：迁移完成后不支持手动降回 1.x —— 旧 CLI 只认旧目录、旧 label 与 `TMEX_*` 键。
// 事务内回滚（rollback / repair）靠 backups/<txn>/run.sh 原样还原旧 run.sh，新模板不再写旧前缀。

import { readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULT_SERVICE_NAME, legacyInstallDir, newInstallDir } from '../constants';
import { readEnvFile, stringifyEnv, writeEnvFile } from './env-file';
import { ensureDir, pathExists, writeText } from './fs-utils';

/** 改名前的默认服务名 */
export const LEGACY_SERVICE_NAME = 'tmex';

const ENV_PREFIX = 'VIBETERM_';
const LEGACY_ENV_PREFIX = 'TMEX_';

const LEGACY_PID_FILE = 'tmex.pid';
/** 旧日志改名保存：`.legacy` 后缀不参与轮转，只是留个存档 */
const LEGACY_LOGS: ReadonlyArray<readonly [string, string]> = [
  ['tmex.log', 'vibeterm.log.legacy'],
  ['tmex.err.log', 'vibeterm.err.log.legacy'],
];

const LEGACY_DB_BASENAME = 'tmex.db';
const DB_BASENAME = 'vibeterm.db';
const DB_SUFFIXES = ['', '-wal', '-shm'] as const;

export interface DirMigrationPlan {
  fromDir: string;
  /** 不搬家时等于 fromDir */
  toDir: string;
  /** 是否搬目录：只有旧默认目录才搬，自定义目录只改 app.env 与服务标识 */
  moveDir: boolean;
  oldServiceName: string;
  newServiceName: string;
}

export interface DirMigrationRecord extends DirMigrationPlan {
  /** 迁移前 app.env 的备份（位于 toDir/backups 下），回滚时按它还原 */
  envBackup: string | null;
  envRewritten: boolean;
  dbRenamed: boolean;
  oldLabel: string;
}

/** 每完成一步就落盘；currentDir 是记录当前所在的安装目录（rename 之后 journal 随目录走）。 */
export type MigrationPersist = (record: DirMigrationRecord, currentDir: string) => Promise<void>;

export interface MigrationOptions {
  txnId: string;
  persist?: MigrationPersist;
}

export function legacyLaunchdLabelFor(serviceName: string): string {
  return `com.tmex.${serviceName}`;
}

/**
 * 目录只有「旧默认目录 + 新默认目录不存在」才搬；其余情况退化为原地的 env 键迁移。
 */
export async function planInstallMigration(input: {
  installDir: string;
  platform: NodeJS.Platform;
  serviceName: string;
}): Promise<DirMigrationPlan> {
  const fromDir = resolve(input.installDir);
  const toDir = resolve(newInstallDir(input.platform));
  const movable =
    fromDir === resolve(legacyInstallDir(input.platform)) &&
    fromDir !== toDir &&
    !(await pathExists(toDir));
  if (!movable) {
    return {
      fromDir,
      toDir: fromDir,
      moveDir: false,
      oldServiceName: input.serviceName,
      newServiceName: input.serviceName,
    };
  }
  return {
    fromDir,
    toDir,
    moveDir: true,
    oldServiceName: input.serviceName,
    newServiceName:
      input.serviceName === LEGACY_SERVICE_NAME ? DEFAULT_SERVICE_NAME : input.serviceName,
  };
}

export function createMigrationRecord(plan: DirMigrationPlan): DirMigrationRecord {
  return {
    ...plan,
    envBackup: null,
    envRewritten: false,
    dbRenamed: false,
    oldLabel: legacyLaunchdLabelFor(plan.oldServiceName),
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
      fromDir !== toDir && (rawValue === fromDir || rawValue.startsWith(`${fromDir}/`))
        ? `${toDir}${rawValue.slice(fromDir.length)}`
        : rawValue;
    // 旧键改名后若与已有新键冲突，以已有新键为准（不覆盖显式写过的值）。
    if (key in next && rawKey !== key) continue;
    next[key] = value;
  }
  return next;
}

/**
 * DB 三件套的改名计划；只处理安装目录 data/ 下的 tmex.db。
 * pending 为 false 表示文件已经是新名（重试）或库还没建出来——两种情况都仍要把 DATABASE_URL 写成新名，
 * 否则重跑一次就会把配置指到一个不存在的库上，启动时静默建出空库。
 */
async function planDbRename(
  installDir: string,
  databaseUrl: string | undefined
): Promise<{ newUrl: string; pending: boolean } | null> {
  if (!databaseUrl) return null;
  const dataDir = join(installDir, 'data');
  if (dirname(resolve(databaseUrl)) !== resolve(dataDir)) return null;
  if (basename(databaseUrl) !== LEGACY_DB_BASENAME) return null;
  return {
    newUrl: join(dataDir, DB_BASENAME),
    pending: await pathExists(join(dataDir, LEGACY_DB_BASENAME)),
  };
}

async function renameDbTrio(dataDir: string): Promise<void> {
  for (const suffix of DB_SUFFIXES) {
    const from = join(dataDir, `${LEGACY_DB_BASENAME}${suffix}`);
    if (!(await pathExists(from))) continue;
    await rename(from, join(dataDir, `${DB_BASENAME}${suffix}`));
  }
}

async function renameDbTrioBack(dir: string): Promise<void> {
  for (const suffix of DB_SUFFIXES) {
    const from = join(dir, `${DB_BASENAME}${suffix}`);
    if (!(await pathExists(from))) continue;
    await rename(from, join(dir, `${LEGACY_DB_BASENAME}${suffix}`));
  }
}

/**
 * 迁移收尾：停服时留下的 `tmex.pid` 已经没有意义（新 run.sh 写 `vibeterm.pid`），直接删；
 * 旧日志改名存档，让安装目录里不再有任何叫 tmex 的文件。幂等。
 */
async function cleanLegacyRuntimeFiles(installDir: string): Promise<void> {
  await rm(join(installDir, LEGACY_PID_FILE), { force: true }).catch(() => null);
  for (const [legacy, archived] of LEGACY_LOGS) {
    const source = join(installDir, legacy);
    if (!(await pathExists(source))) continue;
    await rename(source, join(installDir, archived)).catch(() => null);
  }
}

async function restoreLegacyRuntimeFiles(installDir: string): Promise<void> {
  for (const [legacy, archived] of LEGACY_LOGS) {
    const source = join(installDir, archived);
    if (!(await pathExists(source))) continue;
    await rename(source, join(installDir, legacy)).catch(() => null);
  }
}

async function mark(
  record: DirMigrationRecord,
  patch: Partial<DirMigrationRecord>,
  opts: MigrationOptions
): Promise<DirMigrationRecord> {
  const next = { ...record, ...patch };
  await opts.persist?.(next, record.toDir);
  return next;
}

async function backupEnvFile(
  record: DirMigrationRecord,
  envPath: string,
  opts: MigrationOptions
): Promise<DirMigrationRecord> {
  if (record.envBackup && (await pathExists(record.envBackup))) return record;
  const backupPath = record.envBackup ?? join(record.toDir, 'backups', `app.env.${opts.txnId}`);
  await ensureDir(dirname(backupPath));
  await writeText(backupPath, await readFile(envPath, 'utf8'), 0o600);
  return await mark(record, { envBackup: backupPath }, opts);
}

/**
 * 目录 rename 之后的收尾：备份并改写 app.env、改 DB 文件名。幂等——`--repair` 在任意一步之后
 * 崩溃都可以直接再跑一遍补完（包括「DB 已改名、app.env 还没写」这个窗口）。
 */
export async function finishInstallDirMigration(
  record: DirMigrationRecord,
  opts: MigrationOptions
): Promise<DirMigrationRecord> {
  await cleanLegacyRuntimeFiles(record.toDir);
  const envPath = join(record.toDir, 'app.env');
  if (!(await pathExists(envPath))) return await mark(record, { envRewritten: true }, opts);

  const values = await readEnvFile(envPath);
  const next = rewriteEnvValues(values, record.fromDir, record.toDir);
  const db = record.moveDir ? await planDbRename(record.toDir, next.DATABASE_URL) : null;
  if (db) next.DATABASE_URL = db.newUrl;
  if (!db?.pending && stringifyEnv(next) === stringifyEnv(values)) {
    // 没有任何要改的（早就迁过 / 本来就是新键）：不写文件，也不留备份。
    return await mark(record, { envRewritten: true }, opts);
  }

  let state = await backupEnvFile(record, envPath, opts);
  if (db) {
    // 先记意图再改名：中途崩溃时回滚一定会把文件名换回去（renameDbTrioBack 幂等）。
    if (!state.dbRenamed) state = await mark(state, { dbRenamed: true }, opts);
    if (db.pending) await renameDbTrio(join(record.toDir, 'data'));
  }
  await writeEnvFile(envPath, next);
  return await mark(state, { envRewritten: true }, opts);
}

/**
 * 执行迁移：（可选）整目录 rename → 备份并改写 app.env → DB 改名。
 * rename 本身失败（跨卷 / 权限）不算升级失败：返回 null，调用方原地继续升级。
 */
export async function migrateInstallDir(
  plan: DirMigrationPlan,
  opts: MigrationOptions
): Promise<DirMigrationRecord | null> {
  const record = createMigrationRecord(plan);
  // 先落盘再动手：rename 之后崩溃，journal 随目录搬到新路径，repair 才知道该往哪个方向收尾。
  await opts.persist?.(record, plan.fromDir);

  if (plan.moveDir) {
    try {
      await rename(plan.fromDir, plan.toDir);
    } catch {
      return null;
    }
  }

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
  await restoreLegacyRuntimeFiles(record.toDir);
  if (!record.moveDir) return;
  if (await pathExists(record.fromDir)) return;
  await rename(record.toDir, record.fromDir);
}
