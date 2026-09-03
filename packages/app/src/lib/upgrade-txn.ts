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
import { ensureDir, pathExists } from './fs-utils';
import { deployRuntimeFiles, writeInstallMeta, writeRunScript } from './install';
import { type PackageLayout, createInstallLayout, createVersionLayout } from './install-layout';
import { readJsonFile } from './json-file';
import { copyDbTrio, copyPreflightDb, restoreDbTrio } from './upgrade-db';
import { finishCommittedCleanup, removeTxnDirs, safeRemoveDir } from './upgrade-gc';
import type { HealthCheckFn } from './upgrade-health';
import { liveHealthUrl, pollHealthz, verifyOldHealthz } from './upgrade-health';
import { isPidAlive } from './upgrade-lock';
import { ensureCandidateNativeAddon } from './upgrade-native';
import {
  type UpgradeServiceControl,
  commandLineContains,
  killPidAndWait,
  waitForPidExit,
} from './upgrade-process';
import {
  type UpgradeJournal,
  advanceJournal,
  createJournal,
  readJournal,
  writeJournal,
} from './upgrade-state';
import { readCurrentVersion, switchCurrent, versionDirPath } from './upgrade-switch';

export const HEALTH_TIMEOUT_MS = 60_000;
export const STOP_TIMEOUT_MS = 20_000;

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

export async function commitSuccess(
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

export async function executeUpgradeTxn(
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
