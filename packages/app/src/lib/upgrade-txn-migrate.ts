// 升级事务里的「安装目录迁移」胶水：迁移成功后 journal / 路径改写，失败时整体还原。
// 与 upgrade-migrate-dir.ts 的分工：那边只做文件系统层面的搬迁，这边负责事务状态。

import { writeRunScript } from './install';
import { createInstallLayout } from './install-layout';
import {
  type DirMigrationPlan,
  type DirMigrationRecord,
  migrateInstallDir,
  revertInstallDirMigration,
} from './upgrade-migrate-dir';
import { type UpgradeJournal, writeJournal } from './upgrade-state';

export async function runInstallDirMigration(
  ctx: {
    txnId: string;
    migrationPlan: DirMigrationPlan | null;
    log: (message: string) => void;
  },
  journal: UpgradeJournal
): Promise<{ journal: UpgradeJournal; record: DirMigrationRecord | null }> {
  if (!ctx.migrationPlan) return { journal, record: null };
  const record = await migrateInstallDir(ctx.migrationPlan, { txnId: ctx.txnId });
  if (!record) {
    ctx.log(`install dir migration skipped (${ctx.migrationPlan.toDir} unavailable)`);
    return { journal, record: null };
  }
  const next: UpgradeJournal = {
    ...journal,
    dirMigration: record,
    updatedAt: new Date().toISOString(),
  };
  // 目录已经搬走，journal 必须写到新路径。
  await writeJournal(record.toDir, next);
  ctx.log(`install dir migrated ${record.fromDir} -> ${record.toDir}`);
  return { journal: next, record };
}

export async function revertMigrationAfterFailure(
  record: DirMigrationRecord,
  journal: UpgradeJournal,
  bunPath: string,
  skipShims: boolean | undefined,
  log: (message: string) => void
): Promise<UpgradeJournal> {
  await revertInstallDirMigration(record, { txnId: journal.txnId });
  const reverted: UpgradeJournal = {
    ...journal,
    dirMigration: undefined,
    updatedAt: new Date().toISOString(),
  };
  await writeJournal(record.fromDir, reverted);
  await writeRunScript(createInstallLayout(record.fromDir), bunPath).catch(() => null);
  if (!skipShims) {
    const { installVibeTermShim } = await import('./cli-shim');
    await installVibeTermShim({
      installLayout: createInstallLayout(record.fromDir),
      bunPath,
    }).catch(() => null);
  }
  log(`install dir migration reverted ${record.toDir} -> ${record.fromDir}`);
  return reverted;
}
