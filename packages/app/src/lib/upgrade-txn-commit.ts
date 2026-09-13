import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { t } from '../i18n';
import type { InstallMeta, ServiceMode } from '../types';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import { writeInstallMeta } from './install';
import { createInstallLayout } from './install-layout';
import { detectInstallSource } from './install-source';
import { readJsonFile } from './json-file';
import { restoreDbTrio } from './upgrade-db';
import { finishCommittedCleanup, removeTxnDirs, safeRemoveDir } from './upgrade-gc';
import type { HealthCheckFn } from './upgrade-health';
import { liveHealthUrl, verifyOldHealthz } from './upgrade-health';
import { isPidAlive } from './upgrade-lock';
import { cleanNewRuntimeFiles, isLegacyLabelVersion } from './upgrade-migrate-dir';
import {
  type UpgradeServiceControl,
  commandLineContains,
  killPidAndWait,
  waitForPidExit,
} from './upgrade-process';
import { restoreRunScript } from './upgrade-run-script';
import { type UpgradeJournal, writeJournal } from './upgrade-state';
import { restoreEnvFile } from './upgrade-stun-env';
import { readCurrentVersion, switchCurrent, versionDirPath } from './upgrade-switch';
import { HEALTH_TIMEOUT_MS } from './upgrade-txn-preflight';

export const STOP_TIMEOUT_MS = 20_000;

export async function removeCandidateVersion(installDir: string, version: string): Promise<void> {
  const current = await readCurrentVersion(installDir);
  if (current === version) return;
  const dir = versionDirPath(installDir, version);
  if (await pathExists(dir)) {
    await safeRemoveDir(installDir, dir);
  }
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

async function persistUpgradeMeta(input: {
  installDir: string;
  toVersion: string;
  bunPath: string;
  serviceMode?: ServiceMode;
  serviceName?: string;
  repairedMeta?: InstallMeta;
}): Promise<void> {
  const layout = createInstallLayout(input.installDir);
  if (!input.repairedMeta && !(await pathExists(layout.metaPath))) return;
  const meta = input.repairedMeta ?? (await readJsonFile<InstallMeta>(layout.metaPath));
  meta.updatedAt = new Date().toISOString();
  meta.cliVersion = input.toVersion;
  // 老安装的 meta 里没有安装来源，借这次升级补上；已记过的一律保留（升级方式不代表安装方式）。
  if (!meta.installSource) meta.installSource = detectInstallSource();
  meta.bunPath = input.bunPath;
  // 迁移把目录搬走后，meta 必须指向自己所在的目录：网页卸载 / 外部工具都按它找安装。
  meta.installDir = input.installDir;
  if (input.serviceMode === 'none' || input.serviceMode === 'managed') {
    meta.serviceMode = input.serviceMode;
  }
  // 服务名只在健康检查通过后才落盘（迁移把默认 tmex 改成 vibeterm）。
  if (input.serviceName) meta.serviceName = input.serviceName;
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
  await persistUpgradeMeta({
    installDir,
    toVersion: journal.toVersion,
    bunPath,
    serviceMode,
    serviceName,
    repairedMeta,
  });
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

export async function assertStopped(service: UpgradeServiceControl): Promise<void> {
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
