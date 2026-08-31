import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { formatHttpEndpoint } from '../../../shared/src/network';
import type { DirectEnableResult, EnableDirectOptions } from '../commands/direct';
import { t } from '../i18n';
import type { InstallMeta, ServiceMode } from '../types';
import { deployCliPackage } from './cli-shim';
import { readEnvFile } from './env-file';
import { ensureDir, pathExists, writeTextAtomic } from './fs-utils';
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
  removeLegacyTopLevelDirs,
  removeTxnDirs,
  safeRemoveDir,
  sweepUpgradeGarbage,
} from './upgrade-gc';
import type { HealthCheckFn } from './upgrade-health';
import { pollHealthz } from './upgrade-health';
import { convertLegacyLayout } from './upgrade-legacy';
import { acquireUpgradeLock, isPidAlive, releaseUpgradeLock } from './upgrade-lock';
import { ensureCandidateNativeAddon } from './upgrade-native';
import { commandLineContains, killPidAndWait, waitForPidExit, waitUntil } from './upgrade-process';
import {
  type UpgradeJournal,
  advanceJournal,
  createJournal,
  readJournal,
  recoveryAction,
  writeJournal,
} from './upgrade-state';
import { readCurrentVersion, switchCurrent, versionDirPath } from './upgrade-switch';

const HEALTH_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 20_000;

export type UpgradeServiceControl = {
  stop: () => Promise<void>;
  start: () => Promise<void>;
  isRunning: () => Promise<boolean>;
};

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

export function pidFilePath(installDir: string): string {
  return join(installDir, 'tmex.pid');
}

function readPidFile(pidPath: string): number | null {
  try {
    const raw = readFileSync(pidPath, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function hasLivePidFile(installDir: string): boolean {
  const pid = readPidFile(pidFilePath(installDir));
  return pid !== null && isPidAlive(pid);
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

export function createDirectProcessControl(opts: {
  runScriptPath: string;
  pidPath: string;
  env?: NodeJS.ProcessEnv;
}): UpgradeServiceControl {
  return {
    async stop() {
      const pid = readPidFile(opts.pidPath);
      if (pid && isPidAlive(pid)) {
        await killPidAndWait(pid, STOP_TIMEOUT_MS);
      }
      if (pid && isPidAlive(pid)) {
        throw new Error(t('upgrade.serviceDidNotStop', { timeout: STOP_TIMEOUT_MS }));
      }
      await rm(opts.pidPath, { force: true }).catch(() => null);
    },
    async start() {
      const child = spawn('bash', [opts.runScriptPath], {
        detached: true,
        stdio: 'ignore',
        env: opts.env ?? process.env,
      });
      child.unref();
      if (child.pid) {
        await writeTextAtomic(opts.pidPath, `${child.pid}\n`);
      }
    },
    async isRunning() {
      const pid = readPidFile(opts.pidPath);
      return pid !== null && isPidAlive(pid);
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
        await killPidAndWait(child.pid, 8_000);
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

async function liveHealthUrl(installDir: string): Promise<string | null> {
  const envPath = join(installDir, 'app.env');
  if (!(await pathExists(envPath))) return null;
  const env = await readEnvFile(envPath).catch(() => null);
  if (!env) return null;
  const port = String(env.GATEWAY_PORT || '9883');
  const host = String(env.TMEX_BIND_HOST || '127.0.0.1');
  const bind = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return formatHttpEndpoint(bind, port, '/healthz');
}

async function cleanupTxn(
  installDir: string,
  journal: UpgradeJournal,
  keepBackup: boolean
): Promise<void> {
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
  log: (message: string) => void
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
  if (url) {
    await healthCheck({ url, minStartedAt: restartAt, timeoutMs: HEALTH_TIMEOUT_MS });
  }
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
  if (isPidAlive(pid) && commandLineContains(pid, serverJs)) {
    await killPidAndWait(pid, 15_000);
  }
  if (isPidAlive(pid) && commandLineContains(pid, serverJs)) {
    await waitForPidExit(pid, 5_000);
  }
}

async function verifyOldServiceRunning(
  installDir: string,
  journal: UpgradeJournal,
  service: UpgradeServiceControl,
  healthCheck: HealthCheckFn
): Promise<void> {
  const restartAt = new Date().toISOString();
  await service.start();
  if (!(await service.isRunning())) {
    throw new Error(
      t('upgrade.repairStartFailed', {
        version: journal.fromVersion,
        error: 'not running',
      })
    );
  }
  const url = await liveHealthUrl(installDir);
  if (url) {
    await healthCheck({ url, minStartedAt: restartAt, timeoutMs: HEALTH_TIMEOUT_MS });
  }
}

async function markAborted(installDir: string, journal: UpgradeJournal): Promise<void> {
  await writeJournal(installDir, {
    ...journal,
    phase: 'aborted',
    updatedAt: new Date().toISOString(),
  });
}

async function repairMissingJournal(installDir: string, bunPath: string): Promise<void> {
  await convertLegacyLayout(installDir, { bunPath }).catch(() => false);
  await sweepUpgradeGarbage(installDir);
  if (await readCurrentVersion(installDir)) {
    await removeLegacyTopLevelDirs(installDir);
  }
}

async function repairAbortCandidate(installDir: string, journal: UpgradeJournal): Promise<void> {
  await killRecordedCandidate(installDir, journal);
  await removeCandidateVersion(installDir, journal.toVersion);
  await cleanupTxn(installDir, journal, false);
  await sweepUpgradeGarbage(installDir);
  await markAborted(installDir, journal);
}

async function repairRestartOld(
  installDir: string,
  journal: UpgradeJournal,
  service: UpgradeServiceControl,
  healthCheck: HealthCheckFn
): Promise<void> {
  const current = await readCurrentVersion(installDir);
  if (current && current !== journal.fromVersion && journal.fromVersion) {
    await switchCurrent(installDir, journal.fromVersion);
  }
  await verifyOldServiceRunning(installDir, journal, service, healthCheck);
  await removeCandidateVersion(installDir, journal.toVersion);
  await cleanupTxn(installDir, journal, false);
  await sweepUpgradeGarbage(installDir);
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
    await service.start().catch(() => null);
    await healthCheck({
      url,
      expectedVersion: journal.toVersion,
      timeoutMs: HEALTH_TIMEOUT_MS,
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
    await rollbackToOld(installDir, journal, bunPath, service, healthCheck, message, log);
  }
}

async function repairTerminalCleanup(installDir: string, journal: UpgradeJournal): Promise<void> {
  await cleanupTxn(installDir, journal, Boolean(journal.keepBackup));
  if (journal.phase === 'committed') {
    await finishCommittedCleanup(installDir, {
      current: journal.toVersion,
      previous: journal.fromVersion !== journal.toVersion ? journal.fromVersion : null,
    });
  }
  await sweepUpgradeGarbage(installDir);
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
    await repairMissingJournal(installDir, bunPath);
    return action;
  }
  if (action === 'abort_candidate') {
    await repairAbortCandidate(installDir, journal);
    return action;
  }
  if (action === 'restart_old') {
    await repairRestartOld(installDir, journal, service, healthCheck);
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
  await repairTerminalCleanup(installDir, journal);
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
  service: UpgradeServiceControl,
  skipShims?: boolean
): Promise<UpgradeJournal> {
  await service.stop();
  await assertStopped(service);
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
  await healthCheck({ url, expectedVersion: toVersion, timeoutMs: HEALTH_TIMEOUT_MS });
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

    journal = await advanceJournal(ctx.installDir, journal, 'backup', {
      keepBackup: ctx.keepBackup,
    });
    journal = await backupAndSwitch(
      ctx.installDir,
      journal,
      ctx.toVersion,
      ctx.bunPath,
      ctx.service,
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
        ctx.log
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
