import { resolve } from 'node:path';
import { DEFAULT_SERVICE_NAME } from '../constants';
import { t } from '../i18n';
import type { InstallMeta, ServiceMode } from '../types';
import { writeRunScript } from './install';
import { createInstallLayout } from './install-layout';
import type { HealthCheckFn } from './upgrade-health';
import { liveHealthUrl, verifyOldHealthz } from './upgrade-health';
import {
  type DirMigrationRecord,
  type MigrationPersist,
  cleanNewRuntimeFiles,
  finishInstallDirMigration,
  isLegacyLabelVersion,
} from './upgrade-migrate-dir';
import type { UpgradeServiceControl } from './upgrade-process';
import { type RepairMetaOptions, readInstallMeta } from './upgrade-repair-meta';
import { createManagedServiceControl, createServiceControl } from './upgrade-service-control';
import { type RecoveryKind, type UpgradeJournal, writeJournal } from './upgrade-state';
import { HEALTH_TIMEOUT_MS, type UpgradeApplyDeps } from './upgrade-txn';
import {
  finishMigrationUndo,
  revertMigrationAfterFailure,
  stopBeforeMigrationUndo,
} from './upgrade-txn-migrate';

export type RepairDeps = UpgradeApplyDeps & RepairMetaOptions;

export interface ServiceIdentity {
  serviceName?: string;
  legacyServiceName?: string;
  legacyLabel?: boolean;
}

/** repair 期间用到的一切上下文：目录 / 服务身份都可能被迁移回退改写。 */
export interface RepairRuntime {
  installDir: string;
  bunPath: string;
  deps: RepairDeps;
  log: (message: string) => void;
  meta: InstallMeta | null;
  journal: UpgradeJournal | null;
  service: UpgradeServiceControl;
  /** 仍然生效的安装迁移记录（已回退时为 null） */
  migration: DirMigrationRecord | null;
}

export function resolveRepairService(
  installDir: string,
  deps: UpgradeApplyDeps,
  meta: InstallMeta | null,
  identity: ServiceIdentity
): UpgradeServiceControl {
  // 工厂优先：CLI 在知道 journal 之前就建好的 deps.service 用的是旧身份 / 旧目录，
  // 迁移中断后拿它去停服务会漏掉 com.vibeterm.*，搬回目录后又会去启动已经不存在的 run.sh。
  const serviceName = identity.serviceName ?? meta?.serviceName ?? DEFAULT_SERVICE_NAME;
  // 没发生迁移时新旧服务名相同：装旧 label 那份时照样要拆掉同名的新 label 注册。
  const legacyServiceName = identity.legacyServiceName ?? serviceName;
  const rebuilt = deps.rebuildService?.({
    installDir,
    serviceName,
    legacyServiceName,
    legacyLabel: identity.legacyLabel,
  });
  if (rebuilt) return rebuilt;
  if (deps.service) return deps.service;
  if (meta) {
    return createServiceControl({
      installDir,
      meta,
      serviceName,
      legacyServiceName,
      legacyLabel: identity.legacyLabel,
    });
  }
  return createManagedServiceControl({
    serviceName,
    legacyServiceName,
    installDir,
    autostart: true,
    runScriptPath: createInstallLayout(installDir).runScriptPath,
    legacyLabel: identity.legacyLabel,
  });
}

/** 迁移记录只有当前确实站在它的目标目录上、且尚未撤销才算「还在生效」。 */
function activeMigration(
  installDir: string,
  journal: UpgradeJournal | null
): DirMigrationRecord | null {
  const record = journal?.dirMigration;
  if (!record || record.undone) return null;
  return resolve(installDir) === resolve(record.toDir) ? record : null;
}

/** 已经撤销、目录也搬回旧位置的记录：还要按旧身份把回滚收尾。 */
function undoneMigration(
  installDir: string,
  journal: UpgradeJournal | null
): DirMigrationRecord | null {
  const record = journal?.dirMigration;
  if (!record?.undone) return null;
  return resolve(installDir) === resolve(record.fromDir) ? record : null;
}

export async function verifyOldServiceRunning(input: {
  installDir: string;
  journal: UpgradeJournal;
  service: UpgradeServiceControl;
  healthCheck: HealthCheckFn;
  serviceMode?: ServiceMode;
}): Promise<void> {
  // 服务还在跑就绝不再 start()：第二个 run.sh 会覆盖 pid 文件后因端口占用退出。
  const alreadyRunning = await input.service.isRunning();
  let restarted = false;
  let restartAt: string | undefined;
  if (!alreadyRunning) {
    // 拉起 < 2.0.0 之前清掉新命名的 pid / 日志，并用旧 label 的控制器注册（见 restoreService）。
    if (isLegacyLabelVersion(input.journal.fromVersion)) {
      await cleanNewRuntimeFiles(input.installDir);
    }
    restartAt = new Date().toISOString();
    await input.service.start();
    restarted = true;
  }
  if (!(await input.service.isRunning())) {
    throw new Error(
      t('upgrade.repairStartFailed', {
        version: input.journal.fromVersion,
        error: 'not running',
      })
    );
  }
  const url = await liveHealthUrl(input.installDir);
  await verifyOldHealthz(input.journal, input.healthCheck, url, {
    serviceMode: input.serviceMode,
    restarted,
    restartAt,
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
}

export async function markAborted(installDir: string, journal: UpgradeJournal): Promise<void> {
  await writeJournal(installDir, {
    ...journal,
    phase: 'aborted',
    // 旧版本已经恢复并验证通过，迁移撤销到此收尾。
    dirMigration: undefined,
    updatedAt: new Date().toISOString(),
  });
}

/** 补完目录迁移；每一步落 journal，便于崩溃后继续。 */
async function completeInterruptedMigration(
  installDir: string,
  journal: UpgradeJournal,
  bunPath: string,
  deps: UpgradeApplyDeps
): Promise<UpgradeJournal> {
  const record = journal.dirMigration;
  if (!record) return journal;

  let current = journal;
  const persist: MigrationPersist = async (next, currentDir) => {
    current = { ...current, dirMigration: next, updatedAt: new Date().toISOString() };
    await writeJournal(currentDir, current);
  };
  if (!record.envRewritten) {
    await finishInstallDirMigration(record, { txnId: journal.txnId, persist });
  }
  // run.sh 里是旧目录的绝对路径，不重写服务起不来。
  await writeRunScript(createInstallLayout(installDir), bunPath).catch(() => null);
  const [localBinDir, bunBinDir] = deps.shimDirs;
  const { installVibeTermShim } = await import('./cli-shim');
  await installVibeTermShim({
    installLayout: createInstallLayout(installDir),
    bunPath,
    localBinDir,
    bunBinDir,
  }).catch(() => null);
  await writeJournal(installDir, current);
  return current;
}

/** 恢复旧版本时该用的控制器：< 2.0.0 一律换成旧 label / 旧日志名那一份。 */
export function restoreService(
  rt: RepairRuntime,
  journal: UpgradeJournal | null
): UpgradeServiceControl {
  const target = repairServiceIdentity(rt.installDir, journal, 'restore');
  if (!target.identity.legacyLabel && !target.identity.serviceName) return rt.service;
  return resolveRepairService(target.installDir, rt.deps, rt.meta, target.identity);
}

/** 撤销迁移并把上下文切回旧目录 / 旧服务身份；新服务停不下来就直接抛。 */
export async function undoMigrationInRepair(
  rt: RepairRuntime,
  journal: UpgradeJournal,
  record: DirMigrationRecord
): Promise<RepairRuntime> {
  await stopBeforeMigrationUndo(rt.service, record);
  const reverted = await revertMigrationAfterFailure({
    record,
    journal,
    bunPath: rt.bunPath,
    shimDirs: rt.deps.shimDirs,
    log: rt.log,
  });
  const meta = await readInstallMeta(record.fromDir, rt.bunPath, rt.deps, record.oldServiceName);
  const target = repairServiceIdentity(rt.installDir, journal, 'restart_old');
  return {
    ...rt,
    installDir: record.fromDir,
    journal: reverted,
    meta,
    migration: null,
    service: resolveRepairService(record.fromDir, rt.deps, meta, target.identity),
  };
}

/**
 * repair 最终要操作的目录与服务身份。迁移已经落地时按新身份走；事务还没起过新版本
 * （restart_old）时整体回退，按旧目录 + 旧 label 走——绝不拿旧服务名去启动新前缀的 label。
 */
export function repairServiceIdentity(
  installDir: string,
  journal: UpgradeJournal | null,
  action: RecoveryKind | 'restore'
): { installDir: string; identity: ServiceIdentity } {
  const record = activeMigration(installDir, journal) ?? undoneMigration(installDir, journal);
  if (action === 'restart_old' || action === 'restore') {
    // 恢复 < 2.0.0 就必须注册回旧 label / 旧日志名，否则旧 CLI 管不了自己的 job。
    const legacyLabel = isLegacyLabelVersion(journal?.fromVersion);
    if (!record) return { installDir, identity: legacyLabel ? { legacyLabel } : {} };
    return {
      installDir: record.fromDir,
      identity: {
        serviceName: record.oldServiceName,
        legacyServiceName: record.newServiceName,
        legacyLabel,
      },
    };
  }
  if (!record) return { installDir, identity: {} };
  return {
    installDir,
    identity: { serviceName: record.newServiceName, legacyServiceName: record.oldServiceName },
  };
}

async function prepareWithoutRecord(input: {
  rt: RepairRuntime;
  action: RecoveryKind;
  installDir: string;
  journal: UpgradeJournal | null;
  bunPath: string;
  deps: RepairDeps;
  meta: InstallMeta | null;
}): Promise<RepairRuntime> {
  if (input.action !== 'restart_old') return input.rt;
  // 迁移已经撤销（回滚中途断电）或本来就没有迁移：都按「恢复旧版本」的身份收尾。
  const undone = undoneMigration(input.installDir, input.journal);
  // `undone` 是先落盘的：紧接着的 meta / run.sh / shim 恢复可能一步都没做，这里幂等补做。
  if (undone && input.journal) {
    await finishMigrationUndo({
      record: undone,
      txnId: input.journal.txnId,
      bunPath: input.bunPath,
      shimDirs: input.deps.shimDirs,
    });
  }
  const meta2 = undone
    ? await readInstallMeta(undone.fromDir, input.bunPath, input.deps, undone.oldServiceName)
    : input.meta;
  const target = repairServiceIdentity(input.installDir, input.journal, 'restore');
  return {
    ...input.rt,
    installDir: target.installDir,
    meta: meta2,
    service: resolveRepairService(target.installDir, input.deps, meta2, target.identity),
  };
}

export async function prepareRepair(input: {
  installDir: string;
  bunPath: string;
  deps: RepairDeps;
  log: (message: string) => void;
  journal: UpgradeJournal | null;
  action: RecoveryKind;
}): Promise<RepairRuntime> {
  const record = activeMigration(input.installDir, input.journal);
  const identity: ServiceIdentity = record
    ? { serviceName: record.newServiceName, legacyServiceName: record.oldServiceName }
    : {};
  const meta = await readInstallMeta(
    input.installDir,
    input.bunPath,
    input.deps,
    identity.serviceName
  );
  const rt: RepairRuntime = {
    installDir: input.installDir,
    bunPath: input.bunPath,
    deps: input.deps,
    log: input.log,
    meta,
    journal: input.journal,
    migration: record,
    service: resolveRepairService(input.installDir, input.deps, meta, identity),
  };
  if (!record) {
    return prepareWithoutRecord({
      rt,
      action: input.action,
      installDir: input.installDir,
      journal: input.journal,
      bunPath: input.bunPath,
      deps: input.deps,
      meta,
    });
  }
  if (!input.journal) return rt;

  // 新版本还没起来过（stopping / migrate / backup / switching 中断）：整体撤回迁移，
  // 回到旧目录与旧 label 上恢复旧版本，绝不拿旧服务名去启动新前缀的 label。
  if (input.action === 'restart_old') {
    return await undoMigrationInRepair(rt, input.journal, record);
  }
  const journal = await completeInterruptedMigration(
    input.installDir,
    input.journal,
    input.bunPath,
    input.deps
  );
  return { ...rt, journal, migration: journal.dirMigration ?? record };
}
