import { t } from '../i18n';
import { errorMessage } from './error-message';
import { finishCommittedCleanup, sweepUpgradeGarbage } from './upgrade-gc';
import type { HealthCheckFn } from './upgrade-health';
import { liveHealthUrl, pollHealthz } from './upgrade-health';
import { persistRepairMeta, resolveRepairMeta } from './upgrade-repair-meta';
import {
  type RepairDeps,
  type RepairRuntime,
  markAborted,
  prepareRepair,
  restoreService,
  undoMigrationInRepair,
  verifyOldServiceRunning,
} from './upgrade-repair-prepare';
import {
  type RecoveryKind,
  type UpgradeJournal,
  readJournal,
  recoveryAction,
  writeJournal,
} from './upgrade-state';
import { readCurrentVersion, switchCurrent } from './upgrade-switch';
import {
  HEALTH_TIMEOUT_MS,
  type UpgradeApplyDeps,
  cleanupTxn,
  commitSuccess,
  killRecordedCandidate,
  removeCandidateVersion,
  rollbackToOld,
} from './upgrade-txn';
import { restoreDbAfterInterruptedRevert } from './upgrade-txn-migrate';

export { repairServiceIdentity } from './upgrade-repair-prepare';

async function sweepRepairGarbage(installDir: string, deps: UpgradeApplyDeps): Promise<void> {
  await sweepUpgradeGarbage(installDir, {
    keepTxnId: deps.activeTxnId,
    shimDirs: deps.shimDirs,
  });
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
  await verifyOldServiceRunning({
    installDir: rt.installDir,
    journal,
    service: rt.service,
    healthCheck,
    serviceMode: rt.meta?.serviceMode,
  });
  await removeCandidateVersion(rt.installDir, journal.toVersion);
  await cleanupTxn(rt.installDir, journal, false, rt.deps.activeTxnId);
  await sweepRepairGarbage(rt.installDir, rt.deps);
  await markAborted(rt.installDir, journal);
}

async function repairVerifyOrRollback(
  rt: RepairRuntime,
  journal: UpgradeJournal,
  healthCheck: HealthCheckFn
): Promise<RepairRuntime> {
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
    const recovered = await resolveRepairMeta(rt.installDir, rt.deps, rt.bunPath);
    await commitSuccess(
      rt.installDir,
      journal,
      rt.bunPath,
      Boolean(journal.keepBackup),
      rt.log,
      rt.meta?.serviceMode,
      rt.migration?.newServiceName,
      recovered?.rebuilt ? recovered.meta : undefined
    );
    return rt;
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
    return back;
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
  deps: RepairDeps
): Promise<RepairOutcome> {
  const log = deps.log ?? ((message) => console.log(`[vibeterm] ${message}`));
  const healthCheck = deps.healthCheck ?? pollHealthz;
  const initial = await readJournal(installDir);
  const action = recoveryAction(initial);
  const rt = await prepareRepair({ installDir, bunPath, deps, log, journal: initial, action });
  const journal = rt.journal;

  let finalRuntime = rt;
  if (!journal) {
    // 旧布局（没有 current）的转换一律留给 applyUpgrade：它会先把旧 run.sh 备份进事务再重写。
    // 在这里提前转换，事务备份拿到的就是新模板，回滚时旧 runtime 缺 TMEX_* 路径变量起不来。
    await sweepRepairGarbage(rt.installDir, deps);
  } else if (action === 'abort_candidate') {
    await repairAbortCandidate(rt, journal);
  } else if (action === 'restart_old') {
    await repairRestartOld(rt, journal, healthCheck);
  } else if (action === 'verify_or_rollback') {
    finalRuntime = await repairVerifyOrRollback(rt, journal, healthCheck);
  } else {
    await repairTerminalCleanup(rt, journal);
  }
  await persistRepairMeta(
    finalRuntime.installDir,
    bunPath,
    deps,
    log,
    finalRuntime.meta?.serviceName
  );
  return { action, installDir: finalRuntime.installDir };
}
