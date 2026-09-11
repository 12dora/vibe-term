import { spawn } from 'node:child_process';
import { readFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { formatHttpEndpoint } from '../../../shared/src/network';
import type { DirectEnableResult, EnableDirectOptions } from '../commands/direct';
import { t } from '../i18n';
import { RUNTIME_MODE_ENV } from '../runtime/mode';
import type { InstallMeta, ServiceMode } from '../types';
import { type ShimDirs, deployCliPackage } from './cli-shim';
import { readEnvFile } from './env-file';
import { errorMessage } from './error-message';
import { ensureDir, pathExists } from './fs-utils';
import { deployRuntimeFiles, writeInstallMeta, writeRunScript } from './install';
import { detectInstallSource } from './install-source';
import {
  type CandidateHandle,
  type CandidateRunner,
  HEALTH_TIMEOUT_MS,
  allocateEphemeralPort,
  runPreflight,
} from './upgrade-txn-preflight';

export { HEALTH_TIMEOUT_MS, allocateEphemeralPort };
export type { CandidateHandle, CandidateRunner };
import { type PackageLayout, createInstallLayout, createVersionLayout } from './install-layout';
import { readJsonFile } from './json-file';
import { copyDbTrio, copyPreflightDb, restoreDbTrio } from './upgrade-db';
import { finishCommittedCleanup, removeTxnDirs, safeRemoveDir } from './upgrade-gc';
import type { HealthCheckFn } from './upgrade-health';
import { liveHealthUrl, pollHealthz, verifyOldHealthz } from './upgrade-health';
import { isPidAlive } from './upgrade-lock';
import {
  type DirMigrationPlan,
  type DirMigrationRecord,
  cleanNewRuntimeFiles,
  isLegacyLabelVersion,
} from './upgrade-migrate-dir';
import { ensureCandidateNativeAddon } from './upgrade-native';
import {
  type UpgradeServiceControl,
  commandLineContains,
  killPidAndWait,
  waitForPidExit,
} from './upgrade-process';
import { backupRunScript, restoreRunScript, runScriptBackupPath } from './upgrade-run-script';
import {
  type UpgradeJournal,
  advanceJournal,
  createJournal,
  readJournal,
  writeJournal,
} from './upgrade-state';
import { applyStunEnvMigration, backupEnvFile, restoreEnvFile } from './upgrade-stun-env';
import { readCurrentVersion, switchCurrent, versionDirPath } from './upgrade-switch';
import {
  revertMigrationAfterFailure,
  runInstallDirMigration,
  stopBeforeMigrationUndo,
} from './upgrade-txn-migrate';

export const STOP_TIMEOUT_MS = 20_000;

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

export async function removeCandidateVersion(installDir: string, version: string): Promise<void> {
  const current = await readCurrentVersion(installDir);
  if (current === version) return;
  const dir = versionDirPath(installDir, version);
  if (await pathExists(dir)) {
    await safeRemoveDir(installDir, dir);
  }
}

export async function deployPackageToVersionDir(
  packageLayout: PackageLayout,
  installDir: string,
  version: string
): Promise<void> {
  const layout = createVersionLayout(installDir, version);
  await deployRuntimeFiles(packageLayout, layout);
  await deployCliPackage(packageLayout, layout);
}

async function promoteStagingToVersion(
  installDir: string,
  txnId: string,
  toVersion: string,
  packageLayout: PackageLayout
): Promise<void> {
  const dest = versionDirPath(installDir, toVersion);
  if (await pathExists(dest)) {
    await safeRemoveDir(installDir, dest);
  }
  const stagedPkg = join(installDir, 'staging', txnId, 'pkg');
  if (await pathExists(stagedPkg)) {
    await rename(stagedPkg, dest);
    return;
  }
  await deployPackageToVersionDir(packageLayout, installDir, toVersion);
}

export async function cleanupTxn(
  installDir: string,
  journal: UpgradeJournal,
  keepBackup: boolean,
  activeTxnId?: string | null
): Promise<void> {
  const keepStaging = Boolean(activeTxnId && journal.txnId === activeTxnId);
  if (keepStaging) {
    if (!(keepBackup || journal.keepBackup)) {
      await rm(join(installDir, 'backups', journal.txnId), { recursive: true, force: true }).catch(
        () => null
      );
    }
    return;
  }
  if (keepBackup || journal.keepBackup) {
    await rm(join(installDir, 'staging', journal.txnId), { recursive: true, force: true }).catch(
      () => null
    );
    return;
  }
  await removeTxnDirs(installDir, journal.txnId);
}

async function persistUpgradeMeta(
  installDir: string,
  toVersion: string,
  bunPath: string,
  serviceMode?: ServiceMode,
  serviceName?: string,
  repairedMeta?: InstallMeta
): Promise<void> {
  const layout = createInstallLayout(installDir);
  if (!repairedMeta && !(await pathExists(layout.metaPath))) return;
  const meta = repairedMeta ?? (await readJsonFile<InstallMeta>(layout.metaPath));
  meta.updatedAt = new Date().toISOString();
  meta.cliVersion = toVersion;
  // 老安装的 meta 里没有安装来源，借这次升级补上；已记过的一律保留（升级方式不代表安装方式）。
  if (!meta.installSource) meta.installSource = detectInstallSource();
  meta.bunPath = bunPath;
  // 迁移把目录搬走后，meta 必须指向自己所在的目录：网页卸载 / 外部工具都按它找安装。
  meta.installDir = installDir;
  if (serviceMode === 'none' || serviceMode === 'managed') {
    meta.serviceMode = serviceMode;
  }
  // 服务名只在健康检查通过后才落盘（迁移把默认 tmex 改成 vibeterm）。
  if (serviceName) meta.serviceName = serviceName;
  await writeInstallMeta(layout, meta);
}

export async function commitSuccess(
  installDir: string,
  journal: UpgradeJournal,
  bunPath: string,
  keepBackup: boolean,
  log: (message: string) => void,
  serviceMode?: ServiceMode,
  serviceName?: string,
  repairedMeta?: InstallMeta
): Promise<void> {
  await persistUpgradeMeta(
    installDir,
    journal.toVersion,
    bunPath,
    serviceMode,
    serviceName,
    repairedMeta
  );
  const committed: UpgradeJournal = {
    ...journal,
    phase: 'committed',
    keepBackup: keepBackup || journal.keepBackup,
    updatedAt: new Date().toISOString(),
    error: undefined,
  };
  await writeJournal(installDir, committed);
  await cleanupTxn(installDir, committed, keepBackup);
  await finishCommittedCleanup(installDir, {
    current: journal.toVersion,
    previous: journal.fromVersion !== journal.toVersion ? journal.fromVersion : null,
  });
  if (repairedMeta) log(`install-meta.json rebuilt from current: ${journal.toVersion}`);
  log(`upgrade committed ${journal.fromVersion} -> ${journal.toVersion}`);
}

async function assertStopped(service: UpgradeServiceControl): Promise<void> {
  if (await service.isRunning()) {
    throw new Error(t('upgrade.serviceDidNotStop', { timeout: STOP_TIMEOUT_MS }));
  }
}

export async function rollbackToOld(
  installDir: string,
  journal: UpgradeJournal,
  bunPath: string,
  service: UpgradeServiceControl,
  healthCheck: HealthCheckFn,
  error: string,
  log: (message: string) => void,
  serviceMode?: ServiceMode
): Promise<void> {
  await service.stop();
  await assertStopped(service);
  const backupDir = join(installDir, 'backups', journal.txnId);
  const env = await readEnvFile(join(installDir, 'app.env')).catch(() => null);
  const dbPath = env?.DATABASE_URL;
  if (dbPath && (await pathExists(backupDir))) {
    await restoreDbTrio(backupDir, dbPath);
  }
  if (journal.fromVersion) {
    await switchCurrent(installDir, journal.fromVersion);
  }
  const current = await readCurrentVersion(installDir);
  if (journal.fromVersion && current !== journal.fromVersion) {
    throw new Error(
      t('upgrade.healthVersionMismatch', {
        expected: journal.fromVersion,
        actual: current ?? '',
      })
    );
  }
  await restoreRunScript(installDir, journal.txnId, bunPath);
  await restoreEnvFile(installDir, journal.txnId);
  if (isLegacyLabelVersion(journal.fromVersion)) await cleanNewRuntimeFiles(installDir);
  const restartAt = new Date().toISOString();
  await service.start();
  const url = await liveHealthUrl(installDir);
  await verifyOldHealthz(journal, healthCheck, url, {
    serviceMode,
    restarted: true,
    restartAt,
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
  await removeCandidateVersion(installDir, journal.toVersion);
  await writeJournal(installDir, {
    ...journal,
    phase: 'rolled_back',
    // 旧版本已经切回并验证通过，迁移撤销到此收尾。
    dirMigration: undefined,
    updatedAt: new Date().toISOString(),
    error,
  });
  log(t('upgrade.rolledBack', { version: journal.fromVersion, error }));
}

export async function killRecordedCandidate(
  installDir: string,
  journal: UpgradeJournal
): Promise<void> {
  const pid = journal.candidatePid;
  if (!pid) return;
  const serverJs = join(versionDirPath(installDir, journal.toVersion), 'runtime', 'server.js');
  const owned = () => commandLineContains(pid, serverJs);
  if (isPidAlive(pid) && owned()) {
    await killPidAndWait(pid, 15_000, {
      assertOwned: () => {
        if (!owned()) throw new Error(t('upgrade.pidNotOwned', { pid: String(pid), installDir }));
      },
    });
  }
  if (isPidAlive(pid) && owned()) await waitForPidExit(pid, 5_000);
}

async function stageCandidate(
  installDir: string,
  txnId: string,
  toVersion: string,
  packageLayout: PackageLayout
): Promise<void> {
  const pkgVersion = JSON.parse(
    await readFile(join(packageLayout.packageRoot, 'package.json'), 'utf8')
  ) as { version?: string };
  if (pkgVersion.version && pkgVersion.version !== toVersion) {
    throw new Error(
      t('upgrade.healthVersionMismatch', {
        expected: toVersion,
        actual: pkgVersion.version,
      })
    );
  }
  await promoteStagingToVersion(installDir, txnId, toVersion, packageLayout);
}

async function backupAndSwitch(
  installDir: string,
  journal: UpgradeJournal,
  toVersion: string,
  bunPath: string,
  shimDirs: ShimDirs,
  skipShims?: boolean
): Promise<UpgradeJournal> {
  const layout = createInstallLayout(installDir);
  const env = await readEnvFile(layout.envPath).catch(() => null);
  let next = journal;
  if (env?.DATABASE_URL) {
    await copyDbTrio(env.DATABASE_URL, join(installDir, 'backups', journal.txnId));
    next = await advanceJournal(installDir, journal, 'switching', { dbBackup: true });
  } else {
    next = await advanceJournal(installDir, journal, 'switching');
  }
  await switchCurrent(installDir, toVersion);
  await writeRunScript(createInstallLayout(installDir), bunPath);
  if (!skipShims) {
    const [localBinDir, bunBinDir] = shimDirs;
    const { installVibeTermShim } = await import('./cli-shim');
    await installVibeTermShim({
      installLayout: createInstallLayout(installDir),
      bunPath,
      localBinDir,
      bunBinDir,
    });
  }
  return next;
}

async function startNewAndCommit(
  installDir: string,
  journal: UpgradeJournal,
  toVersion: string,
  bunPath: string,
  keepBackup: boolean,
  service: UpgradeServiceControl,
  healthCheck: HealthCheckFn,
  log: (message: string) => void,
  serviceMode?: ServiceMode,
  serviceName?: string
): Promise<void> {
  const next = await advanceJournal(installDir, journal, 'started');
  await service.start();
  const url = await liveHealthUrl(installDir);
  if (!url) throw new Error(t('upgrade.healthFailed', { status: 'missing-env' }));
  await healthCheck({
    url,
    expectedVersion: toVersion,
    timeoutMs: HEALTH_TIMEOUT_MS,
    requireTlsListener: true,
  });
  await commitSuccess(installDir, next, bunPath, keepBackup, log, serviceMode, serviceName);
}

async function stageAndPreflight(
  installDir: string,
  journal: UpgradeJournal,
  options: ApplyUpgradeOptions,
  deps: UpgradeApplyDeps,
  ctx: TxnContext
): Promise<UpgradeJournal> {
  let next = await advanceJournal(installDir, journal, 'staging', { keepBackup: ctx.keepBackup });
  await stageCandidate(installDir, ctx.txnId, ctx.toVersion, ctx.packageLayout);
  await ensureCandidateNativeAddon({
    installDir,
    fromVersion: ctx.resolvedFrom,
    toVersion: ctx.toVersion,
    allowMissingNative: options.allowMissingNative,
    enableDirect: deps.enableDirect,
    log: ctx.log,
  });

  next = await advanceJournal(installDir, next, 'preflight', { keepBackup: ctx.keepBackup });
  try {
    return await runPreflight(installDir, ctx.toVersion, ctx.bunPath, ctx.txnId, next, deps);
  } catch (error) {
    const message = errorMessage(error);
    await killRecordedCandidate(installDir, next);
    await removeCandidateVersion(installDir, ctx.toVersion);
    // 旧布局转换已经用新模板重写过 run.sh：中止前把事务备份还回去，
    // 否则一次失败的升级会把还在跑 1.x 的安装留在起不来的状态。
    if (await pathExists(runScriptBackupPath(installDir, ctx.txnId))) {
      await restoreRunScript(installDir, ctx.txnId, ctx.bunPath).catch(() => null);
    }
    await removeTxnDirs(installDir, ctx.txnId);
    await writeJournal(installDir, {
      ...next,
      phase: 'aborted',
      updatedAt: new Date().toISOString(),
      error: message,
    });
    throw new Error(t('upgrade.preflightFailed', { version: ctx.toVersion, error: message }));
  }
}

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
async function handleTxnFailure(
  state: {
    installDir: string;
    service: UpgradeServiceControl;
    migration: DirMigrationRecord | null;
  },
  journal: UpgradeJournal,
  error: unknown,
  options: ApplyUpgradeOptions,
  deps: UpgradeApplyDeps,
  ctx: TxnContext
): Promise<void> {
  let latest = (await readJournal(state.installDir)) ?? journal;
  // 迁移撤销会把 phase 改成 reverting，先按撤销前的阶段决定要不要回滚版本。
  const needsRollback = latest.phase === 'started' || latest.phase === 'switching';
  const { migration } = state;
  if (migration) {
    try {
      await stopBeforeMigrationUndo(state.service, migration);
    } catch (stopError) {
      // 新服务没停下就动目录 / DB 只会把库改坏；把 journal 留给 --repair，抛出可操作的原因。
      ctx.log(`upgrade failed: ${errorMessage(error)}`);
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
    errorMessage(error),
    ctx.log,
    ctx.serviceMode
  );
}

export async function executeUpgradeTxn(
  options: ApplyUpgradeOptions,
  deps: UpgradeApplyDeps,
  ctx: TxnContext
): Promise<string> {
  const state = {
    installDir: ctx.installDir,
    service: ctx.service,
    migration: null as DirMigrationRecord | null,
  };
  let serviceName: string | undefined;

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

    journal = await advanceJournal(state.installDir, journal, 'stopping', {
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
    // 目录迁移备份之后、切 current 之前：revert 拿回原 STUN 键，新 runtime 启动时键已去掉。
    await applyStunEnvMigration(state.installDir, ctx.log);
    journal = await backupAndSwitch(
      state.installDir,
      journal,
      ctx.toVersion,
      ctx.bunPath,
      deps.shimDirs,
      options.skipShims
    );
    await startNewAndCommit(
      state.installDir,
      journal,
      ctx.toVersion,
      ctx.bunPath,
      ctx.keepBackup,
      state.service,
      ctx.healthCheck,
      ctx.log,
      ctx.serviceMode,
      serviceName
    );
    return state.installDir;
  } catch (error) {
    await handleTxnFailure(state, journal, error, options, deps, ctx);
    throw error;
  }
}
