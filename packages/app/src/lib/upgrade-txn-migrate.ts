// 升级事务里的「安装迁移」胶水：逐步把迁移记录写进 journal，失败时整体还原。
// 与 upgrade-migrate-dir.ts 的分工：那边只做文件系统层面的搬迁，这边负责事务状态与服务身份。

import { join } from 'node:path';
import { t } from '../i18n';
import type { InstallMeta } from '../types';
import { readEnvFile } from './env-file';
import { errorMessage } from './error-message';
import { pathExists } from './fs-utils';
import { writeInstallMeta } from './install';
import { createInstallLayout } from './install-layout';
import { readJsonFile } from './json-file';
import { restoreDbTrio } from './upgrade-db';
import {
  type DirMigrationPlan,
  type DirMigrationRecord,
  type MigrationPersist,
  migrateInstallDir,
  revertInstallDirMigration,
} from './upgrade-migrate-dir';
import type { UpgradeServiceControl } from './upgrade-process';
import { restoreRunScript } from './upgrade-run-script';
import { type UpgradeJournal, writeJournal } from './upgrade-state';

export async function runInstallDirMigration(
  ctx: {
    txnId: string;
    migrationPlan: DirMigrationPlan | null;
    log: (message: string) => void;
  },
  journal: UpgradeJournal
): Promise<{ journal: UpgradeJournal; record: DirMigrationRecord | null }> {
  const plan = ctx.migrationPlan;
  if (!plan) return { journal, record: null };

  let current = journal;
  const persist: MigrationPersist = async (record, currentDir) => {
    current = { ...current, dirMigration: record, updatedAt: new Date().toISOString() };
    await writeJournal(currentDir, current);
  };

  const record = await migrateInstallDir(plan, { txnId: ctx.txnId, persist });
  if (!record) {
    // 目录没搬成：把迁移记录撤掉，免得 repair 拿着没发生过的记录去回滚。
    current = { ...current, dirMigration: undefined, updatedAt: new Date().toISOString() };
    await writeJournal(plan.fromDir, current);
    ctx.log(`install dir migration skipped (${plan.toDir} unavailable)`);
    return { journal: current, record: null };
  }
  ctx.log(
    record.moveDir
      ? `install dir migrated ${record.fromDir} -> ${record.toDir}`
      : `app.env keys migrated in ${record.toDir}`
  );
  return { journal: current, record };
}

/**
 * 撤销迁移之前必须确认新身份的服务真的停了：进程还持着库就去改 DB 文件名 / 搬目录，
 * 轻则丢写入，重则把库改坏。停不下来就保留 journal 交给 `--repair`，绝不硬来。
 */
export async function stopBeforeMigrationUndo(
  service: UpgradeServiceControl,
  record: DirMigrationRecord
): Promise<void> {
  await assertServiceStopped(service, record.toDir);
}

async function assertServiceStopped(service: UpgradeServiceControl, dir: string): Promise<void> {
  const fail = (detail: string): never => {
    throw new Error(t('upgrade.migrationStopFailed', { dir, error: detail }));
  };
  try {
    await service.stop();
  } catch (error) {
    fail(errorMessage(error));
  }
  if (await service.isRunning()) fail(t('upgrade.serviceStillRunning'));
}

/**
 * `reverting` 中断后的数据库续做：撤销目录之后、`rollbackToOld()` 还原库之前断电，
 * 旧版本就会跑在被新版本改过的库上，而随后的清理还会把唯一一份备份删掉。
 * 先确认服务真的停了（进程还持着库就动文件只会把库改坏），再按事务备份整体还原。
 */
export async function restoreDbAfterInterruptedRevert(
  installDir: string,
  journal: UpgradeJournal,
  service: UpgradeServiceControl
): Promise<void> {
  await assertServiceStopped(service, installDir);
  if (!journal.dbBackup) return;
  const backupDir = join(installDir, 'backups', journal.txnId);
  if (!(await pathExists(backupDir))) return;
  const env = await readEnvFile(join(installDir, 'app.env')).catch(() => null);
  if (!env?.DATABASE_URL) return;
  await restoreDbTrio(backupDir, env.DATABASE_URL);
}

/** 目录搬回去之后，install-meta.json 里的安装目录与服务名也要跟着回到旧值。 */
async function restoreInstallMeta(record: DirMigrationRecord): Promise<void> {
  const layout = createInstallLayout(record.fromDir);
  if (!(await pathExists(layout.metaPath))) return;
  const meta = await readJsonFile<InstallMeta>(layout.metaPath).catch(() => null);
  if (!meta) return;
  if (meta.installDir === record.fromDir && meta.serviceName === record.oldServiceName) return;
  await writeInstallMeta(layout, {
    ...meta,
    installDir: record.fromDir,
    serviceName: record.oldServiceName,
  });
}

export interface MigrationUndoFinish {
  record: DirMigrationRecord;
  txnId: string;
  bunPath: string;
  skipShims?: boolean;
  /** [localBinDir, bunBinDir]；测试必须给，否则会写到真实的 ~/.local/bin */
  shimDirs?: string[];
}

/**
 * 撤销之后的收尾：install-meta、run.sh 与 shim 都要回到旧目录的形态。
 * 幂等——journal 的 `undone` 是先落盘的，写完到这里之间断电时 `--repair` 必须能原样补做，
 * 否则 run.sh 仍指向已经搬走的新目录，旧服务根本起不来。
 */
export async function finishMigrationUndo(opts: MigrationUndoFinish): Promise<void> {
  const { record, bunPath } = opts;
  await restoreInstallMeta(record).catch(() => null);
  await restoreRunScript(record.fromDir, opts.txnId, bunPath).catch(() => null);
  if (opts.skipShims) return;
  const [localBinDir, bunBinDir] = opts.shimDirs ?? [];
  const { installVibeTermShim } = await import('./cli-shim');
  await installVibeTermShim({
    installLayout: createInstallLayout(record.fromDir),
    bunPath,
    localBinDir,
    bunBinDir,
  }).catch(() => null);
}

export async function revertMigrationAfterFailure(opts: {
  record: DirMigrationRecord;
  journal: UpgradeJournal;
  bunPath: string;
  skipShims?: boolean;
  /** [localBinDir, bunBinDir]；测试必须给，否则会写到真实的 ~/.local/bin */
  shimDirs?: string[];
  log: (message: string) => void;
}): Promise<UpgradeJournal> {
  const { record, journal, bunPath, log } = opts;
  // 先把「正在回退」写下来：撤销目录之后、旧版本收尾之前再断电，repair 必须仍然朝旧版本走，
  // 而不是看到 started 就去启动候选版本（那份布局已经不存在了）。
  const reverting: UpgradeJournal = {
    ...journal,
    phase: 'reverting',
    updatedAt: new Date().toISOString(),
  };
  await writeJournal(record.toDir, reverting).catch(() => null);
  await revertInstallDirMigration(record, { txnId: journal.txnId });
  const reverted: UpgradeJournal = {
    ...reverting,
    // 记录保留到回滚收尾为止，只标记「已撤销」：中途再断电才知道不必重复撤销。
    dirMigration: { ...record, undone: true },
    updatedAt: new Date().toISOString(),
  };
  await writeJournal(record.fromDir, reverted);
  await finishMigrationUndo({
    record,
    txnId: journal.txnId,
    bunPath,
    skipShims: opts.skipShims,
    shimDirs: opts.shimDirs,
  });
  log(
    record.moveDir
      ? `install dir migration reverted ${record.toDir} -> ${record.fromDir}`
      : `app.env key migration reverted in ${record.fromDir}`
  );
  return reverted;
}
