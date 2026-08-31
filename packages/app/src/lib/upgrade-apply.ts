import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { formatHttpEndpoint } from '../../../shared/src/network';
import type { DirectEnableResult, EnableDirectOptions } from '../commands/direct';
import { t } from '../i18n';
import { RUNTIME_MODE_ENV } from '../runtime/mode';
import type { InstallMeta, ServiceMode } from '../types';
import { defaultBunBinDir, defaultLocalBinDir, deployCliPackage } from './cli-shim';
import { readEnvFile } from './env-file';
import { ensureDir, pathExists } from './fs-utils';
import { deployRuntimeFiles, writeInstallMeta, writeRunScript } from './install';
import {
  type PackageLayout,
  createInstallLayout,
  createVersionLayout,
  packageLayoutFromRoot,
} from './install-layout';
import { readJsonFile } from './json-file';
import { getServiceStatus, installService, stopService } from './service';
import { copyDbTrio, copyPreflightDb, restoreDbTrio } from './upgrade-db';
import {
  finishCommittedCleanup,
  removeTxnDirs,
  safeRemoveDir,
  sweepUpgradeGarbage,
} from './upgrade-gc';
import type { HealthCheckFn } from './upgrade-health';
import { liveHealthUrl, pollHealthz, verifyOldHealthz } from './upgrade-health';
import { convertLegacyLayout } from './upgrade-legacy';
import { acquireUpgradeLock, isPidAlive, releaseUpgradeLock } from './upgrade-lock';
import { ensureCandidateNativeAddon } from './upgrade-native';
import {
  type UpgradeServiceControl,
  commandLineContains,
  createDirectProcessControl,
  hasLivePidFile,
  hasOwnedLivePidFile,
  killPidAndWait,
  pidFilePath,
  waitForPidExit,
  waitUntil,
} from './upgrade-process';
import {
  type UpgradeJournal,
  advanceJournal,
  createJournal,
  readJournal,
  recoveryAction,
  writeJournal,
} from './upgrade-state';
import { readCurrentVersion, switchCurrent, versionDirPath } from './upgrade-switch';

export type { UpgradeServiceControl };
export { createDirectProcessControl, hasLivePidFile, hasOwnedLivePidFile, pidFilePath };

const HEALTH_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 20_000;

export type CandidateHandle = { stop: () => Promise<void>; logTail?: () => string; pid?: number };

export type CandidateRunner = (opts: {
  bunPath: string;
  serverJs: string;
  env: NodeJS.ProcessEnv;
}) => Promise<CandidateHandle>;

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
      await installService({
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
    serviceName: opts.meta.serviceName,
    installDir: opts.installDir,
    autostart: opts.meta.autostart,
    runScriptPath: layout.runScriptPath,
  });
}

const CANDIDATE_LOG_TAIL_LINES = 20;

const defaultCandidateRunner: CandidateRunner = async ({ bunPath, serverJs, env }) => {
  const child = spawn(bunPath, [serverJs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail: string[] = [];
  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > CANDIDATE_LOG_TAIL_LINES) tail.shift();
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return {
    pid: child.pid,
    logTail: () => tail.join('\n'),
    async stop() {
      if (child.pid && isPidAlive(child.pid)) {
        const ownedPid = child.pid;
        await killPidAndWait(ownedPid, 8_000, {
          assertOwned: () => {
            if (!commandLineContains(ownedPid, serverJs)) {
              throw new Error(t('upgrade.pidNotOwned', { pid: String(ownedPid), installDir: '' }));
            }
          },
        });
      }
    },
  };
};

export async function allocateEphemeralPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function removeCandidateVersion(installDir: string, version: string): Promise<void> {
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

function repairShimDirs(deps: UpgradeApplyDeps): string[] {
  return deps.shimDirs ?? [defaultLocalBinDir(), defaultBunBinDir()];
}

async function sweepRepairGarbage(installDir: string, deps: UpgradeApplyDeps): Promise<void> {
  await sweepUpgradeGarbage(installDir, {
    keepTxnId: deps.activeTxnId,
    shimDirs: repairShimDirs(deps),
  });
}

async function cleanupTxn(
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
  serviceMode?: ServiceMode
): Promise<void> {
  const layout = createInstallLayout(installDir);
  if (!(await pathExists(layout.metaPath))) return;
  const meta = await readJsonFile<InstallMeta>(layout.metaPath);
  meta.updatedAt = new Date().toISOString();
  meta.cliVersion = toVersion;
  meta.bunPath = bunPath;
  if (serviceMode === 'none' || serviceMode === 'managed') {
    meta.serviceMode = serviceMode;
  }
  await writeInstallMeta(layout, meta);
}

async function commitSuccess(
  installDir: string,
  journal: UpgradeJournal,
  bunPath: string,
  keepBackup: boolean,
  log: (message: string) => void,
  serviceMode?: ServiceMode
): Promise<void> {
  await persistUpgradeMeta(installDir, journal.toVersion, bunPath, serviceMode);
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

async function rollbackToOld(
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
  await writeRunScript(createInstallLayout(installDir), bunPath);
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

async function killRecordedCandidate(installDir: string, journal: UpgradeJournal): Promise<void> {
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
    // 服务仍在运行时绝不能再 start()：第二个 run.sh 会覆盖 tmex.pid 后因端口占用退出，
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
    const message = error instanceof Error ? error.message : String(error);
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
    serviceName: 'tmex',
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
  const log = deps.log ?? ((message) => console.log(`[tmex] ${message}`));
  const healthCheck = deps.healthCheck ?? pollHealthz;
  const journal = await readJournal(installDir);
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

async function runPreflight(
  installDir: string,
  toVersion: string,
  bunPath: string,
  txnId: string,
  journal: UpgradeJournal,
  deps: UpgradeApplyDeps
): Promise<UpgradeJournal> {
  const healthCheck = deps.healthCheck ?? pollHealthz;
  const runCandidate = deps.runCandidate ?? defaultCandidateRunner;
  const envPath = join(installDir, 'app.env');
  const env = (await pathExists(envPath)) ? await readEnvFile(envPath) : {};
  const versionDir = versionDirPath(installDir, toVersion);
  const port = await allocateEphemeralPort();
  const preflightDir = join(installDir, 'staging', txnId, 'preflight-db');
  const liveDb = env.DATABASE_URL;
  let preflightDb = join(preflightDir, 'tmex.db');
  if (liveDb && (await pathExists(liveDb))) {
    await copyPreflightDb(liveDb, preflightDir, bunPath);
    preflightDb = join(preflightDir, basename(liveDb));
  } else {
    await ensureDir(preflightDir);
  }

  const candidateEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    TMEX_BIND_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    TMEX_BASE_URL: formatHttpEndpoint('127.0.0.1', port),
    DATABASE_URL: preflightDb,
    TMEX_ROLES: 'standalone',
    [RUNTIME_MODE_ENV]: 'preflight',
    TMEX_HUB_URL: '',
    TMEX_PEER_PORT: String(await allocateEphemeralPort()),
    TMEX_FE_DIST_DIR: join(versionDir, 'resources', 'fe-dist'),
    TMEX_MIGRATIONS_DIR: join(versionDir, 'resources', 'gateway-drizzle'),
    TMEX_NATIVE_DIR: join(versionDir, 'native'),
    NODE_ENV: 'production',
  };

  const handle = await runCandidate({
    bunPath,
    serverJs: join(versionDir, 'runtime', 'server.js'),
    env: candidateEnv,
  });
  let next = journal;
  if (handle.pid) {
    next = await advanceJournal(installDir, journal, 'preflight', {
      candidatePid: handle.pid,
      candidateStartedAt: new Date().toISOString(),
    });
  }
  try {
    await healthCheck({
      url: formatHttpEndpoint('127.0.0.1', port, '/healthz'),
      expectedVersion: toVersion,
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
  } catch (err) {
    const detail = handle.logTail?.();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(detail ? `${message}\n${detail}` : message);
  } finally {
    await handle.stop();
    await rm(preflightDir, { recursive: true, force: true }).catch(() => null);
  }
  return next;
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
    const { installTmexShim } = await import('./cli-shim');
    await installTmexShim({
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
  serviceMode?: ServiceMode
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
  await commitSuccess(installDir, next, bunPath, keepBackup, log, serviceMode);
}

async function executeUpgradeTxn(
  options: ApplyUpgradeOptions,
  deps: UpgradeApplyDeps,
  ctx: {
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
  }
): Promise<void> {
  let journal = createJournal({
    txnId: ctx.txnId,
    fromVersion: ctx.resolvedFrom,
    toVersion: ctx.toVersion,
    now: deps.now?.(),
  });
  journal.keepBackup = ctx.keepBackup;
  await writeJournal(ctx.installDir, journal);

  try {
    journal = await advanceJournal(ctx.installDir, journal, 'staging', {
      keepBackup: ctx.keepBackup,
    });
    await stageCandidate(ctx.installDir, ctx.txnId, ctx.toVersion, ctx.packageLayout);
    await ensureCandidateNativeAddon({
      installDir: ctx.installDir,
      fromVersion: ctx.resolvedFrom,
      toVersion: ctx.toVersion,
      allowMissingNative: options.allowMissingNative,
      enableDirect: deps.enableDirect,
      log: ctx.log,
    });

    journal = await advanceJournal(ctx.installDir, journal, 'preflight', {
      keepBackup: ctx.keepBackup,
    });
    try {
      journal = await runPreflight(
        ctx.installDir,
        ctx.toVersion,
        ctx.bunPath,
        ctx.txnId,
        journal,
        deps
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await killRecordedCandidate(ctx.installDir, journal);
      await removeCandidateVersion(ctx.installDir, ctx.toVersion);
      await removeTxnDirs(ctx.installDir, ctx.txnId);
      await writeJournal(ctx.installDir, {
        ...journal,
        phase: 'aborted',
        updatedAt: new Date().toISOString(),
        error: message,
      });
      throw new Error(t('upgrade.preflightFailed', { version: ctx.toVersion, error: message }));
    }

    journal = await advanceJournal(ctx.installDir, journal, 'stopping', {
      keepBackup: ctx.keepBackup,
    });
    await ctx.service.stop();
    await assertStopped(ctx.service);
    journal = await advanceJournal(ctx.installDir, journal, 'backup', {
      keepBackup: ctx.keepBackup,
    });
    journal = await backupAndSwitch(
      ctx.installDir,
      journal,
      ctx.toVersion,
      ctx.bunPath,
      options.skipShims
    );
    await startNewAndCommit(
      ctx.installDir,
      journal,
      ctx.toVersion,
      ctx.bunPath,
      ctx.keepBackup,
      ctx.service,
      ctx.healthCheck,
      ctx.log,
      ctx.serviceMode
    );
  } catch (error) {
    const latest = (await readJournal(ctx.installDir)) ?? journal;
    if (latest.phase === 'started' || latest.phase === 'switching') {
      const message = error instanceof Error ? error.message : String(error);
      await rollbackToOld(
        ctx.installDir,
        latest,
        ctx.bunPath,
        ctx.service,
        ctx.healthCheck,
        message,
        ctx.log,
        ctx.serviceMode
      );
    }
    throw error;
  }
}

export async function applyUpgrade(
  options: ApplyUpgradeOptions,
  deps: UpgradeApplyDeps = {}
): Promise<void> {
  const log = deps.log ?? ((message) => console.log(`[tmex] ${message}`));
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

  await executeUpgradeTxn(options, deps, {
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
  });
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
