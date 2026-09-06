import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { DEFAULT_SERVICE_NAME } from '../constants';
import { t } from '../i18n';
import type { InstallMeta, ServiceMode } from '../types';
import { defaultBunBinDir, defaultLocalBinDir } from './cli-shim';
import { errorMessage } from './error-message';
import { pathExists } from './fs-utils';
import { writeRunScript } from './install';
import { createInstallLayout, packageLayoutFromRoot } from './install-layout';
import { readJsonFile } from './json-file';
import {
  getServiceStatus,
  installLegacyLabelledService,
  installService,
  stopService,
} from './service';
import { restoreDbTrio } from './upgrade-db';
import { finishCommittedCleanup, sweepUpgradeGarbage } from './upgrade-gc';
import type { HealthCheckFn } from './upgrade-health';
import { liveHealthUrl, pollHealthz, verifyOldHealthz } from './upgrade-health';
import { convertLegacyLayout } from './upgrade-legacy';
import { acquireUpgradeLock, releaseUpgradeLock } from './upgrade-lock';
import { finishInstallDirMigration, planInstallDirMigration } from './upgrade-migrate-dir';
import {
  type UpgradeServiceControl,
  createDirectProcessControl,
  hasLivePidFile,
  hasOwnedLivePidFile,
  pidFilePath,
  waitUntil,
} from './upgrade-process';
import { type UpgradeJournal, readJournal, recoveryAction, writeJournal } from './upgrade-state';
import { readCurrentVersion, switchCurrent } from './upgrade-switch';
import {
  type ApplyUpgradeOptions,
  HEALTH_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  type UpgradeApplyDeps,
  cleanupTxn,
  commitSuccess,
  executeUpgradeTxn,
  killRecordedCandidate,
  removeCandidateVersion,
  rollbackToOld,
} from './upgrade-txn';

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

export function resolveServiceMode(meta: InstallMeta, noServiceFlag?: boolean): ServiceMode {
  if (meta.serviceMode === 'none' || meta.serviceMode === 'managed') return meta.serviceMode;
  return noServiceFlag ? 'none' : 'managed';
}

export function createManagedServiceControl(opts: {
  serviceName: string;
  installDir: string;
  autostart: boolean;
  runScriptPath: string;
  /** 回滚安装目录迁移时用改名前的 launchd label 重新注册 */
  legacyLabel?: boolean;
}): UpgradeServiceControl {
  return {
    async stop() {
      await stopService(opts.serviceName, opts.installDir);
      await waitUntil(
        async () => {
          const status = await getServiceStatus(opts.serviceName, opts.installDir);
          return !status.running;
        },
        STOP_TIMEOUT_MS,
        t('upgrade.serviceDidNotStop', { timeout: STOP_TIMEOUT_MS })
      );
    },
    async start() {
      const install = opts.legacyLabel ? installLegacyLabelledService : installService;
      await install({
        serviceName: opts.serviceName,
        runScriptPath: opts.runScriptPath,
        installDir: opts.installDir,
        autostart: opts.autostart,
      });
    },
    async isRunning() {
      return (await getServiceStatus(opts.serviceName, opts.installDir)).running;
    },
  };
}

export function createServiceControl(opts: {
  installDir: string;
  meta: InstallMeta;
  noServiceFlag?: boolean;
  serviceName?: string;
  legacyLabel?: boolean;
}): UpgradeServiceControl {
  const layout = createInstallLayout(opts.installDir);
  const mode = resolveServiceMode(opts.meta, opts.noServiceFlag);
  if (mode === 'none') {
    return createDirectProcessControl({
      runScriptPath: layout.runScriptPath,
      pidPath: pidFilePath(opts.installDir),
      installDir: opts.installDir,
    });
  }
  return createManagedServiceControl({
    serviceName: opts.serviceName ?? opts.meta.serviceName,
    installDir: opts.installDir,
    autostart: opts.meta.autostart,
    runScriptPath: layout.runScriptPath,
    legacyLabel: opts.legacyLabel,
  });
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

async function verifyOldServiceRunning(
  installDir: string,
  journal: UpgradeJournal,
  service: UpgradeServiceControl,
  healthCheck: HealthCheckFn,
  serviceMode?: ServiceMode
): Promise<void> {
  const alreadyRunning = await service.isRunning();
  let restarted = false;
  let restartAt: string | undefined;
  if (!alreadyRunning) {
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
    updatedAt: new Date().toISOString(),
  });
}

/**
 * `--repair`：目录已搬到新路径但 app.env / DB / run.sh 还没改完（rename 与改写之间崩溃）时补完。
 * 幂等；目录没搬成或已搬回时什么也不做。
 */
async function completeInterruptedMigration(
  installDir: string,
  journal: UpgradeJournal,
  bunPath: string,
  deps: UpgradeApplyDeps
): Promise<UpgradeJournal> {
  const record = journal.dirMigration;
  if (!record || resolve(installDir) !== resolve(record.toDir)) return journal;

  const finished = record.envRewritten
    ? record
    : await finishInstallDirMigration(record, { txnId: journal.txnId });
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

  const next: UpgradeJournal = {
    ...journal,
    dirMigration: finished,
    updatedAt: new Date().toISOString(),
  };
  await writeJournal(installDir, next);
  return next;
}

async function repairMissingJournal(
  installDir: string,
  bunPath: string,
  deps: UpgradeApplyDeps
): Promise<void> {
  await convertLegacyLayout(installDir, { bunPath }).catch(() => false);
  await sweepRepairGarbage(installDir, deps);
}

async function repairAbortCandidate(
  installDir: string,
  journal: UpgradeJournal,
  deps: UpgradeApplyDeps
): Promise<void> {
  await killRecordedCandidate(installDir, journal);
  await removeCandidateVersion(installDir, journal.toVersion);
  await cleanupTxn(installDir, journal, false, deps.activeTxnId);
  await sweepRepairGarbage(installDir, deps);
  await markAborted(installDir, journal);
}

async function repairRestartOld(
  installDir: string,
  journal: UpgradeJournal,
  service: UpgradeServiceControl,
  healthCheck: HealthCheckFn,
  deps: UpgradeApplyDeps,
  serviceMode?: ServiceMode
): Promise<void> {
  const current = await readCurrentVersion(installDir);
  if (current && current !== journal.fromVersion && journal.fromVersion) {
    await switchCurrent(installDir, journal.fromVersion);
  }
  await verifyOldServiceRunning(installDir, journal, service, healthCheck, serviceMode);
  await removeCandidateVersion(installDir, journal.toVersion);
  await cleanupTxn(installDir, journal, false, deps.activeTxnId);
  await sweepRepairGarbage(installDir, deps);
  await markAborted(installDir, journal);
}

async function repairVerifyOrRollback(
  installDir: string,
  journal: UpgradeJournal,
  bunPath: string,
  service: UpgradeServiceControl,
  healthCheck: HealthCheckFn,
  log: (message: string) => void,
  serviceMode?: ServiceMode
): Promise<void> {
  const url = await liveHealthUrl(installDir);
  try {
    if (!url) throw new Error(t('upgrade.healthFailed', { status: 'missing-env' }));
    // 服务仍在运行时绝不能再 start()：第二个 run.sh 会覆盖 pid 文件后因端口占用退出，
    // 留下指向死 pid 的记录，使后续 stop/repair 误判「未运行」而在活进程持库时动 DB。
    if (!(await service.isRunning())) {
      await service.start().catch(() => null);
    }
    await healthCheck({
      url,
      expectedVersion: journal.toVersion,
      timeoutMs: HEALTH_TIMEOUT_MS,
      requireTlsListener: true,
    });
    await commitSuccess(
      installDir,
      journal,
      bunPath,
      Boolean(journal.keepBackup),
      log,
      serviceMode
    );
  } catch (error) {
    const message = errorMessage(error);
    await rollbackToOld(
      installDir,
      journal,
      bunPath,
      service,
      healthCheck,
      message,
      log,
      serviceMode
    );
  }
}

async function repairTerminalCleanup(
  installDir: string,
  journal: UpgradeJournal,
  deps: UpgradeApplyDeps
): Promise<void> {
  await cleanupTxn(installDir, journal, Boolean(journal.keepBackup), deps.activeTxnId);
  if (journal.phase === 'committed') {
    await finishCommittedCleanup(installDir, {
      current: journal.toVersion,
      previous: journal.fromVersion !== journal.toVersion ? journal.fromVersion : null,
    });
  }
  await sweepRepairGarbage(installDir, deps);
}

function resolveRepairService(
  installDir: string,
  deps: UpgradeApplyDeps,
  meta: InstallMeta | null,
  layout: ReturnType<typeof createInstallLayout>
): UpgradeServiceControl {
  if (deps.service) return deps.service;
  if (meta) return createServiceControl({ installDir, meta });
  return createManagedServiceControl({
    serviceName: DEFAULT_SERVICE_NAME,
    installDir,
    autostart: true,
    runScriptPath: layout.runScriptPath,
  });
}

export async function repairUpgrade(
  installDir: string,
  bunPath: string,
  deps: UpgradeApplyDeps = {}
): Promise<string> {
  const log = deps.log ?? ((message) => console.log(`[vibeterm] ${message}`));
  const healthCheck = deps.healthCheck ?? pollHealthz;
  const readJournalResult = await readJournal(installDir);
  const journal = readJournalResult?.dirMigration
    ? await completeInterruptedMigration(installDir, readJournalResult, bunPath, deps)
    : readJournalResult;
  const action = recoveryAction(journal);
  const layout = createInstallLayout(installDir);
  const meta = (await pathExists(layout.metaPath))
    ? await readJsonFile<InstallMeta>(layout.metaPath).catch(() => null)
    : null;
  const service = resolveRepairService(installDir, deps, meta, layout);

  if (!journal) {
    await repairMissingJournal(installDir, bunPath, deps);
    return action;
  }
  if (action === 'abort_candidate') {
    await repairAbortCandidate(installDir, journal, deps);
    return action;
  }
  if (action === 'restart_old') {
    await repairRestartOld(installDir, journal, service, healthCheck, deps, meta?.serviceMode);
    return action;
  }
  if (action === 'verify_or_rollback') {
    await repairVerifyOrRollback(
      installDir,
      journal,
      bunPath,
      service,
      healthCheck,
      log,
      meta?.serviceMode
    );
    return action;
  }
  await repairTerminalCleanup(installDir, journal, deps);
  return action;
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

  await convertLegacyLayout(installDir, { bunPath, skipShims: options.skipShims });
  const resolvedFrom = (await readCurrentVersion(installDir)) || fromVersion;
  if (resolvedFrom === toVersion) {
    log(t('upgrade.alreadyCurrent', { version: toVersion }));
    return;
  }

  const migrationPlan = await planInstallDirMigration({
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
