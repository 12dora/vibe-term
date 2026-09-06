import { spawn } from 'node:child_process';
import { readFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { formatHttpEndpoint } from '../../../shared/src/network';
import type { DirectEnableResult, EnableDirectOptions } from '../commands/direct';
import { t } from '../i18n';
import { RUNTIME_MODE_ENV } from '../runtime/mode';
import type { InstallMeta, ServiceMode } from '../types';
import { deployCliPackage } from './cli-shim';
import { readEnvFile } from './env-file';
import { errorMessage } from './error-message';
import { ensureDir, pathExists } from './fs-utils';
import { deployRuntimeFiles, writeInstallMeta, writeRunScript } from './install';
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
import type { DirMigrationPlan, DirMigrationRecord } from './upgrade-migrate-dir';
import { ensureCandidateNativeAddon } from './upgrade-native';
import {
  type UpgradeServiceControl,
  commandLineContains,
  killPidAndWait,
  waitForPidExit,
} from './upgrade-process';
import { backupRunScript, restoreRunScript } from './upgrade-run-script';
import {
  type UpgradeJournal,
  advanceJournal,
  createJournal,
  readJournal,
  writeJournal,
} from './upgrade-state';
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
  shimDirs?: string[];
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
  serviceName?: string
): Promise<void> {
  const layout = createInstallLayout(installDir);
  if (!(await pathExists(layout.metaPath))) return;
  const meta = await readJsonFile<InstallMeta>(layout.metaPath);
  meta.updatedAt = new Date().toISOString();
  meta.cliVersion = toVersion;
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
  serviceName?: string
): Promise<void> {
  await persistUpgradeMeta(installDir, journal.toVersion, bunPath, serviceMode, serviceName);
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
    const { installVibeTermShim } = await import('./cli-shim');
    await installVibeTermShim({
      installLayout: createInstallLayout(installDir),
      bunPath,
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
        legacyLabel: true,
      }) ?? state.service;
    state.migration = null;
  }
  if (latest.phase !== 'started' && latest.phase !== 'switching') return;
  await rollbackToOld(
    state.installDir,
    latest,
    ctx.bunPath,
    state.service,
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
    journal = await backupAndSwitch(
      state.installDir,
      journal,
      ctx.toVersion,
      ctx.bunPath,
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
