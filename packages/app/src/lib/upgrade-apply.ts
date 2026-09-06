import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { DEFAULT_SERVICE_NAME } from '../constants';
import { t } from '../i18n';
import type { InstallMeta, ServiceMode } from '../types';
import { defaultBunBinDir, defaultLocalBinDir } from './cli-shim';
import { errorMessage } from './error-message';
import { pathExists } from './fs-utils';
import { writeRunScript } from './install';
import { createInstallLayout, hasCurrentLayout, packageLayoutFromRoot } from './install-layout';
import { readJsonFile } from './json-file';
import { restoreDbTrio } from './upgrade-db';
import { finishCommittedCleanup, sweepUpgradeGarbage } from './upgrade-gc';
import type { HealthCheckFn } from './upgrade-health';
import { liveHealthUrl, pollHealthz, verifyOldHealthz } from './upgrade-health';
import { convertLegacyLayout } from './upgrade-legacy';
import { acquireUpgradeLock, releaseUpgradeLock } from './upgrade-lock';
import {
  type DirMigrationRecord,
  type MigrationPersist,
  cleanNewRuntimeFiles,
  finishInstallDirMigration,
  isLegacyLabelVersion,
  planInstallMigration,
} from './upgrade-migrate-dir';
import {
  type UpgradeServiceControl,
  createDirectProcessControl,
  hasLivePidFile,
  hasOwnedLivePidFile,
  pidFilePath,
} from './upgrade-process';
import { backupRunScript } from './upgrade-run-script';
import {
  createManagedServiceControl,
  createServiceControl,
  resolveServiceMode,
} from './upgrade-service-control';
import {
  type RecoveryKind,
  type UpgradeJournal,
  readJournal,
  recoveryAction,
  writeJournal,
} from './upgrade-state';
import { readCurrentVersion, switchCurrent } from './upgrade-switch';
import {
  type ApplyUpgradeOptions,
  HEALTH_TIMEOUT_MS,
  type UpgradeApplyDeps,
  cleanupTxn,
  commitSuccess,
  executeUpgradeTxn,
  killRecordedCandidate,
  removeCandidateVersion,
  rollbackToOld,
} from './upgrade-txn';
import {
  finishMigrationUndo,
  restoreDbAfterInterruptedRevert,
  revertMigrationAfterFailure,
  stopBeforeMigrationUndo,
} from './upgrade-txn-migrate';

export { createManagedServiceControl, createServiceControl, resolveServiceMode };
export type { UpgradeServiceControl };
export { createDirectProcessControl, hasLivePidFile, hasOwnedLivePidFile, pidFilePath };
export type {
  ApplyUpgradeOptions,
  CandidateHandle,
  CandidateRunner,
  UpgradeApplyDeps,
} from './upgrade-txn';
export { allocateEphemeralPort, deployPackageToVersionDir } from './upgrade-txn';

export function createTxnId(): string {
  return `${Date.now().toString(16)}-${randomBytes(4).toString('hex')}`;
}

function repairShimDirs(deps: UpgradeApplyDeps): string[] {
  return deps.shimDirs ?? [defaultLocalBinDir(), defaultBunBinDir()];
}

async function sweepRepairGarbage(installDir: string, deps: UpgradeApplyDeps): Promise<void> {
  await sweepUpgradeGarbage(installDir, {
    keepTxnId: deps.activeTxnId,
    shimDirs: repairShimDirs(deps),
  });
}

async function readInstallMeta(installDir: string): Promise<InstallMeta | null> {
  const layout = createInstallLayout(installDir);
  if (!(await pathExists(layout.metaPath))) return null;
  return await readJsonFile<InstallMeta>(layout.metaPath).catch(() => null);
}

interface ServiceIdentity {
  serviceName?: string;
  legacyServiceName?: string;
  legacyLabel?: boolean;
}

/** repair 期间用到的一切上下文：目录 / 服务身份都可能被迁移回退改写。 */
interface RepairRuntime {
  installDir: string;
  bunPath: string;
  deps: UpgradeApplyDeps;
  log: (message: string) => void;
  meta: InstallMeta | null;
  journal: UpgradeJournal | null;
  service: UpgradeServiceControl;
  /** 仍然生效的安装迁移记录（已回退时为 null） */
  migration: DirMigrationRecord | null;
}

function resolveRepairService(
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

async function verifyOldServiceRunning(
  installDir: string,
  journal: UpgradeJournal,
  service: UpgradeServiceControl,
  healthCheck: HealthCheckFn,
  serviceMode?: ServiceMode
): Promise<void> {
  // 服务还在跑就绝不再 start()：第二个 run.sh 会覆盖 pid 文件后因端口占用退出。
  const alreadyRunning = await service.isRunning();
  let restarted = false;
  let restartAt: string | undefined;
  if (!alreadyRunning) {
    // 拉起 < 2.0.0 之前清掉新命名的 pid / 日志，并用旧 label 的控制器注册（见 restoreService）。
    if (isLegacyLabelVersion(journal.fromVersion)) await cleanNewRuntimeFiles(installDir);
    restartAt = new Date().toISOString();
    await service.start();
    restarted = true;
  }
  if (!(await service.isRunning())) {
    throw new Error(
      t('upgrade.repairStartFailed', {
        version: journal.fromVersion,
        error: 'not running',
      })
    );
  }
  const url = await liveHealthUrl(installDir);
  await verifyOldHealthz(journal, healthCheck, url, {
    serviceMode,
    restarted,
    restartAt,
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
}

async function markAborted(installDir: string, journal: UpgradeJournal): Promise<void> {
  await writeJournal(installDir, {
    ...journal,
    phase: 'aborted',
    // 旧版本已经恢复并验证通过，迁移撤销到此收尾。
    dirMigration: undefined,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * `--repair`：目录已搬到新路径但 app.env / DB / run.sh 还没改完（rename 与改写之间崩溃）时补完。
 * 幂等；每一步都写回 journal，中途再崩仍能继续。
 */
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
  const [localBinDir, bunBinDir] = repairShimDirs(deps);
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
function restoreService(rt: RepairRuntime, journal: UpgradeJournal | null): UpgradeServiceControl {
  const target = repairServiceIdentity(rt.installDir, journal, 'restore');
  if (!target.identity.legacyLabel && !target.identity.serviceName) return rt.service;
  return resolveRepairService(target.installDir, rt.deps, rt.meta, target.identity);
}

/** 撤销迁移并把上下文切回旧目录 / 旧服务身份；新服务停不下来就直接抛。 */
async function undoMigrationInRepair(
  rt: RepairRuntime,
  journal: UpgradeJournal,
  record: DirMigrationRecord
): Promise<RepairRuntime> {
  await stopBeforeMigrationUndo(rt.service, record);
  const reverted = await revertMigrationAfterFailure({
    record,
    journal,
    bunPath: rt.bunPath,
    shimDirs: repairShimDirs(rt.deps),
    log: rt.log,
  });
  const meta = await readInstallMeta(record.fromDir);
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

async function prepareRepair(input: {
  installDir: string;
  bunPath: string;
  deps: UpgradeApplyDeps;
  log: (message: string) => void;
  journal: UpgradeJournal | null;
  action: RecoveryKind;
}): Promise<RepairRuntime> {
  const record = activeMigration(input.installDir, input.journal);
  const identity: ServiceIdentity = record
    ? { serviceName: record.newServiceName, legacyServiceName: record.oldServiceName }
    : {};
  const meta = await readInstallMeta(input.installDir);
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
    if (input.action !== 'restart_old') return rt;
    // 迁移已经撤销（回滚中途断电）或本来就没有迁移：都按「恢复旧版本」的身份收尾。
    const undone = undoneMigration(input.installDir, input.journal);
    // `undone` 是先落盘的：紧接着的 meta / run.sh / shim 恢复可能一步都没做，这里幂等补做。
    if (undone && input.journal) {
      await finishMigrationUndo({
        record: undone,
        txnId: input.journal.txnId,
        bunPath: input.bunPath,
        shimDirs: repairShimDirs(input.deps),
      });
    }
    const meta2 = undone ? await readInstallMeta(undone.fromDir) : meta;
    const target = repairServiceIdentity(input.installDir, input.journal, 'restore');
    return {
      ...rt,
      installDir: target.installDir,
      meta: meta2,
      service: resolveRepairService(target.installDir, input.deps, meta2, target.identity),
    };
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

async function repairAbortCandidate(rt: RepairRuntime, journal: UpgradeJournal): Promise<void> {
  await killRecordedCandidate(rt.installDir, journal);
  await removeCandidateVersion(rt.installDir, journal.toVersion);
  await cleanupTxn(rt.installDir, journal, false, rt.deps.activeTxnId);
  await sweepRepairGarbage(rt.installDir, rt.deps);
  await markAborted(rt.installDir, journal);
}

async function repairRestartOld(
  rt: RepairRuntime,
  journal: UpgradeJournal,
  healthCheck: HealthCheckFn
): Promise<void> {
  // 回退中断：新版本可能已经写过库，必须在拉起旧版本、清理事务之前把备份还回去。
  if (journal.phase === 'reverting') {
    await restoreDbAfterInterruptedRevert(rt.installDir, journal, rt.service);
  }
  const current = await readCurrentVersion(rt.installDir);
  if (current && current !== journal.fromVersion && journal.fromVersion) {
    await switchCurrent(rt.installDir, journal.fromVersion);
  }
  await verifyOldServiceRunning(
    rt.installDir,
    journal,
    rt.service,
    healthCheck,
    rt.meta?.serviceMode
  );
  await removeCandidateVersion(rt.installDir, journal.toVersion);
  await cleanupTxn(rt.installDir, journal, false, rt.deps.activeTxnId);
  await sweepRepairGarbage(rt.installDir, rt.deps);
  await markAborted(rt.installDir, journal);
}

async function repairVerifyOrRollback(
  rt: RepairRuntime,
  journal: UpgradeJournal,
  healthCheck: HealthCheckFn
): Promise<string> {
  const url = await liveHealthUrl(rt.installDir);
  try {
    if (!url) throw new Error(t('upgrade.healthFailed', { status: 'missing-env' }));
    // 服务仍在运行时绝不能再 start()：第二个 run.sh 会覆盖 pid 文件后因端口占用退出，
    // 留下指向死 pid 的记录，使后续 stop/repair 误判「未运行」而在活进程持库时动 DB。
    if (!(await rt.service.isRunning())) {
      await rt.service.start().catch(() => null);
    }
    await healthCheck({
      url,
      expectedVersion: journal.toVersion,
      timeoutMs: HEALTH_TIMEOUT_MS,
      requireTlsListener: true,
    });
    await commitSuccess(
      rt.installDir,
      journal,
      rt.bunPath,
      Boolean(journal.keepBackup),
      rt.log,
      rt.meta?.serviceMode,
      rt.migration?.newServiceName
    );
    return rt.installDir;
  } catch (error) {
    const message = errorMessage(error);
    const back = rt.migration
      ? await undoMigrationInRepair(rt, journal, rt.migration)
      : { ...rt, journal, service: restoreService(rt, journal) };
    await rollbackToOld(
      back.installDir,
      back.journal ?? journal,
      rt.bunPath,
      back.service,
      healthCheck,
      message,
      rt.log,
      back.meta?.serviceMode
    );
    return back.installDir;
  }
}

async function repairTerminalCleanup(rt: RepairRuntime, journal: UpgradeJournal): Promise<void> {
  await cleanupTxn(rt.installDir, journal, Boolean(journal.keepBackup), rt.deps.activeTxnId);
  if (journal.phase === 'committed') {
    await finishCommittedCleanup(rt.installDir, {
      current: journal.toVersion,
      previous: journal.fromVersion !== journal.toVersion ? journal.fromVersion : null,
    });
  }
  await sweepRepairGarbage(rt.installDir, rt.deps);
}

export interface RepairOutcome {
  action: RecoveryKind;
  /** 恢复之后真正生效的安装目录：撤销迁移会把它搬回旧路径，调用方不能再用原来的路径。 */
  installDir: string;
}

export async function repairUpgrade(
  installDir: string,
  bunPath: string,
  deps: UpgradeApplyDeps = {}
): Promise<RepairOutcome> {
  const log = deps.log ?? ((message) => console.log(`[vibeterm] ${message}`));
  const healthCheck = deps.healthCheck ?? pollHealthz;
  const initial = await readJournal(installDir);
  const action = recoveryAction(initial);
  const rt = await prepareRepair({ installDir, bunPath, deps, log, journal: initial, action });
  const journal = rt.journal;

  if (!journal) {
    // 旧布局（没有 current）的转换一律留给 applyUpgrade：它会先把旧 run.sh 备份进事务再重写。
    // 在这里提前转换，事务备份拿到的就是新模板，回滚时旧 runtime 缺 TMEX_* 路径变量起不来。
    await sweepRepairGarbage(rt.installDir, deps);
    return { action, installDir: rt.installDir };
  }
  if (action === 'abort_candidate') {
    await repairAbortCandidate(rt, journal);
    return { action, installDir: rt.installDir };
  }
  if (action === 'restart_old') {
    await repairRestartOld(rt, journal, healthCheck);
    return { action, installDir: rt.installDir };
  }
  if (action === 'verify_or_rollback') {
    const finalDir = await repairVerifyOrRollback(rt, journal, healthCheck);
    return { action, installDir: finalDir };
  }
  await repairTerminalCleanup(rt, journal);
  return { action, installDir: rt.installDir };
}

export async function applyUpgrade(
  options: ApplyUpgradeOptions,
  deps: UpgradeApplyDeps = {}
): Promise<void> {
  const log = deps.log ?? ((message) => console.log(`[vibeterm] ${message}`));
  const healthCheck = deps.healthCheck ?? pollHealthz;
  const { installDir, toVersion, packageLayout, bunPath } = options;
  const layout = createInstallLayout(installDir);
  const meta = await readJsonFile<InstallMeta>(layout.metaPath);
  const fromVersion = (await readCurrentVersion(installDir)) || meta.cliVersion;
  const txnId = options.txnId || createTxnId();
  const keepBackup = options.keepBackup === true;
  const service =
    deps.service ??
    createServiceControl({
      installDir,
      meta,
      noServiceFlag: options.noService,
    });

  // 旧布局（没有 current）转换时会先用新模板重写 run.sh：事务备份必须赶在那之前取，
  // 否则回滚时「逐字节还原」拿到的是新模板，旧 runtime 需要的 TMEX_* 路径变量一个都没有。
  if (!hasCurrentLayout(installDir)) await backupRunScript(installDir, txnId);
  await convertLegacyLayout(installDir, { bunPath, skipShims: options.skipShims });
  const resolvedFrom = (await readCurrentVersion(installDir)) || fromVersion;
  if (resolvedFrom === toVersion) {
    log(t('upgrade.alreadyCurrent', { version: toVersion }));
    return;
  }

  const migrationPlan = await planInstallMigration({
    installDir,
    platform: process.platform,
    serviceName: meta.serviceName,
  });
  const rebuildService: NonNullable<UpgradeApplyDeps['rebuildService']> =
    deps.rebuildService ??
    ((opts) =>
      createServiceControl({
        installDir: opts.installDir,
        meta,
        noServiceFlag: options.noService,
        serviceName: opts.serviceName,
        legacyServiceName: opts.legacyServiceName,
        legacyLabel: opts.legacyLabel,
      }));

  await executeUpgradeTxn(
    options,
    { ...deps, rebuildService },
    {
      installDir,
      toVersion,
      packageLayout,
      bunPath,
      txnId,
      keepBackup,
      resolvedFrom,
      service,
      healthCheck,
      log,
      serviceMode: resolveServiceMode(meta, options.noService),
      serviceName: meta.serviceName,
      migrationPlan,
    }
  );
}

export async function withUpgradeLock<T>(installDir: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireUpgradeLock(installDir);
  try {
    return await fn();
  } finally {
    await releaseUpgradeLock(lock);
  }
}

export { packageLayoutFromRoot, pollHealthz, restoreDbTrio };
export type { HealthCheckFn };
