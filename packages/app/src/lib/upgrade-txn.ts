import type { DirectEnableResult, EnableDirectOptions } from '../commands/direct';
import type { InstallMeta, ServiceMode } from '../types';
import type { ShimDirs } from './cli-shim';
import { errorMessage } from './error-message';
import type { PackageLayout } from './install-layout';
import type { HealthCheckFn } from './upgrade-health';
import {
  type DirMigrationPlan,
  type DirMigrationRecord,
  isLegacyLabelVersion,
} from './upgrade-migrate-dir';
import { applyPortPlanEnvMigration } from './upgrade-port-env';
import type { UpgradeServiceControl } from './upgrade-process';
import { backupRunScript } from './upgrade-run-script';
import {
  type UpgradeJournal,
  advanceJournal,
  createJournal,
  readJournal,
  writeJournal,
} from './upgrade-state';
import { applyStunEnvMigration, backupEnvFile, restoreEnvFile } from './upgrade-stun-env';
import {
  STOP_TIMEOUT_MS,
  assertStopped,
  cleanupTxn,
  commitSuccess,
  killRecordedCandidate,
  removeCandidateVersion,
  rollbackToOld,
} from './upgrade-txn-commit';
import {
  revertMigrationAfterFailure,
  runInstallDirMigration,
  stopBeforeMigrationUndo,
} from './upgrade-txn-migrate';
import {
  type CandidateHandle,
  type CandidateRunner,
  HEALTH_TIMEOUT_MS,
  allocateEphemeralPort,
} from './upgrade-txn-preflight';
import {
  backupAndSwitch,
  deployPackageToVersionDir,
  stageAndPreflight,
  startNewAndCommit,
} from './upgrade-txn-stage';

export { HEALTH_TIMEOUT_MS, allocateEphemeralPort };
export type { CandidateHandle, CandidateRunner };
export { STOP_TIMEOUT_MS };
export { cleanupTxn, commitSuccess, killRecordedCandidate, removeCandidateVersion, rollbackToOld };
export { deployPackageToVersionDir };

export type UpgradeApplyDeps = {
  log?: (message: string) => void;
  service?: UpgradeServiceControl;
  runCandidate?: CandidateRunner;
  healthCheck?: HealthCheckFn;
  sleep?: (ms: number) => Promise<void>;
  reenableDirect?: (installDir: string) => Promise<void>;
  enableDirect?: (options: EnableDirectOptions) => Promise<DirectEnableResult>;
  now?: () => Date;
  activeTxnId?: string | null;
  /** shim 落点，必填：不给就会写到真实主目录，测试与临时实例必须注入自己的临时目录。 */
  shimDirs: ShimDirs;
  /** 安装迁移后按新路径 / 新服务名重建服务控制器；不给则迁移后沿用原控制器。 */
  rebuildService?: (opts: {
    installDir: string;
    serviceName: string;
    /** 改名前注册用的服务名，安装 / 停止时要一并拆掉它留下的注册 */
    legacyServiceName?: string;
    legacyLabel?: boolean;
  }) => UpgradeServiceControl;
};

export type ApplyUpgradeOptions = {
  installDir: string;
  toVersion: string;
  packageLayout: PackageLayout;
  bunPath: string;
  keepBackup?: boolean;
  noService?: boolean;
  allowMissingNative?: boolean;
  txnId?: string;
  serviceName?: string;
  autostart?: boolean;
  skipShims?: boolean;
};

export interface TxnContext {
  installDir: string;
  toVersion: string;
  packageLayout: PackageLayout;
  bunPath: string;
  txnId: string;
  keepBackup: boolean;
  resolvedFrom: string;
  service: UpgradeServiceControl;
  healthCheck: HealthCheckFn;
  log: (message: string) => void;
  serviceMode: ServiceMode;
  migrationPlan?: DirMigrationPlan | null;
  /** 当前注册用的服务名；回滚到 < 2.0.0 时要用它重建成旧 label 的控制器 */
  serviceName?: string;
}

type TxnState = {
  installDir: string;
  service: UpgradeServiceControl;
  migration: DirMigrationRecord | null;
};

/**
 * 恢复 < 2.0.0 时一律换成旧 label 的控制器：旧 runtime 只认 `com.tmex.<服务名>`，
 * 用新 label 注册它，1.1.x 的 CLI 就找不到自己的 job，下一次升级会因端口占用失败。
 * 迁移分支已经重建过控制器，这里只处理「没发生迁移」的情况。
 */
function restoreServiceControl(
  state: { installDir: string; service: UpgradeServiceControl },
  journal: UpgradeJournal,
  deps: UpgradeApplyDeps,
  ctx: TxnContext
): UpgradeServiceControl {
  if (!isLegacyLabelVersion(journal.fromVersion)) return state.service;
  if (!ctx.serviceName || !deps.rebuildService) return state.service;
  return deps.rebuildService({
    installDir: state.installDir,
    serviceName: ctx.serviceName,
    legacyServiceName: ctx.serviceName,
    legacyLabel: true,
  });
}

/** 失败收尾：先把可能已经搬走的安装目录还原，再决定要不要回滚版本。 */
async function handleTxnFailure(input: {
  state: TxnState;
  journal: UpgradeJournal;
  error: unknown;
  options: ApplyUpgradeOptions;
  deps: UpgradeApplyDeps;
  ctx: TxnContext;
}): Promise<void> {
  const { state, options, deps, ctx } = input;
  let latest = (await readJournal(state.installDir)) ?? input.journal;
  // 迁移撤销会把 phase 改成 reverting，先按撤销前的阶段决定要不要回滚版本。
  const needsRollback = latest.phase === 'started' || latest.phase === 'switching';
  const { migration } = state;
  if (migration) {
    try {
      await stopBeforeMigrationUndo(state.service, migration);
    } catch (stopError) {
      // 新服务没停下就动目录 / DB 只会把库改坏；把 journal 留给 --repair，抛出可操作的原因。
      ctx.log(`upgrade failed: ${errorMessage(input.error)}`);
      throw stopError;
    }
    latest = await revertMigrationAfterFailure({
      record: migration,
      journal: latest,
      bunPath: ctx.bunPath,
      skipShims: options.skipShims,
      shimDirs: deps.shimDirs,
      log: ctx.log,
    });
    state.installDir = migration.fromDir;
    state.service =
      deps.rebuildService?.({
        installDir: migration.fromDir,
        serviceName: migration.oldServiceName,
        legacyServiceName: migration.newServiceName,
        legacyLabel: isLegacyLabelVersion(latest.fromVersion),
      }) ?? state.service;
    state.migration = null;
  }
  await restoreEnvFile(state.installDir, ctx.txnId).catch(() => null);
  if (!needsRollback) return;
  // 迁移分支已经重建成旧 label 的控制器（还带着要拆掉的新服务名），别再覆盖它。
  const service = migration ? state.service : restoreServiceControl(state, latest, deps, ctx);
  await rollbackToOld(
    state.installDir,
    latest,
    ctx.bunPath,
    service,
    ctx.healthCheck,
    errorMessage(input.error),
    ctx.log,
    ctx.serviceMode
  );
}

async function stopMigrateAndCommit(input: {
  state: TxnState;
  journal: UpgradeJournal;
  options: ApplyUpgradeOptions;
  deps: UpgradeApplyDeps;
  ctx: TxnContext;
}): Promise<string> {
  const { state, options, deps, ctx } = input;
  let journal = await advanceJournal(state.installDir, input.journal, 'stopping', {
    keepBackup: ctx.keepBackup,
  });
  await backupRunScript(state.installDir, ctx.txnId);
  await backupEnvFile(state.installDir, ctx.txnId);
  await ctx.service.stop();
  await assertStopped(ctx.service);

  journal = await advanceJournal(state.installDir, journal, 'migrate-install-dir', {
    keepBackup: ctx.keepBackup,
  });
  const migrated = await runInstallDirMigration(
    { txnId: ctx.txnId, migrationPlan: ctx.migrationPlan ?? null, log: ctx.log },
    journal
  );
  journal = migrated.journal;
  let serviceName: string | undefined;
  if (migrated.record) {
    state.migration = migrated.record;
    if (migrated.record.moveDir) {
      state.installDir = migrated.record.toDir;
      serviceName = migrated.record.newServiceName;
      state.service =
        deps.rebuildService?.({
          installDir: state.installDir,
          serviceName,
          legacyServiceName: migrated.record.oldServiceName,
        }) ?? state.service;
    }
  }
  journal = await advanceJournal(state.installDir, journal, 'backup', {
    keepBackup: ctx.keepBackup,
  });
  await applyStunEnvMigration(state.installDir, ctx.log);
  await applyPortPlanEnvMigration(state.installDir, ctx.log);
  journal = await backupAndSwitch({
    installDir: state.installDir,
    journal,
    toVersion: ctx.toVersion,
    bunPath: ctx.bunPath,
    shimDirs: deps.shimDirs,
    skipShims: options.skipShims,
  });
  await startNewAndCommit({
    installDir: state.installDir,
    journal,
    toVersion: ctx.toVersion,
    bunPath: ctx.bunPath,
    keepBackup: ctx.keepBackup,
    service: state.service,
    healthCheck: ctx.healthCheck,
    log: ctx.log,
    serviceMode: ctx.serviceMode,
    serviceName,
  });
  return state.installDir;
}

export async function executeUpgradeTxn(
  options: ApplyUpgradeOptions,
  deps: UpgradeApplyDeps,
  ctx: TxnContext
): Promise<string> {
  const state: TxnState = {
    installDir: ctx.installDir,
    service: ctx.service,
    migration: null,
  };

  let journal = createJournal({
    txnId: ctx.txnId,
    fromVersion: ctx.resolvedFrom,
    toVersion: ctx.toVersion,
    now: deps.now?.(),
  });
  journal.keepBackup = ctx.keepBackup;
  await writeJournal(state.installDir, journal);

  try {
    journal = await stageAndPreflight(state.installDir, journal, options, deps, ctx);
    return await stopMigrateAndCommit({ state, journal, options, deps, ctx });
  } catch (error) {
    await handleTxnFailure({ state, journal, error, options, deps, ctx });
    throw error;
  }
}
