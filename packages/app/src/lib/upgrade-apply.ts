import { randomBytes } from 'node:crypto';
import { t } from '../i18n';
import type { InstallMeta } from '../types';
import { createInstallLayout, hasCurrentLayout, packageLayoutFromRoot } from './install-layout';
import { readJsonFile } from './json-file';
import { restoreDbTrio } from './upgrade-db';
import type { HealthCheckFn } from './upgrade-health';
import { pollHealthz } from './upgrade-health';
import { convertLegacyLayout } from './upgrade-legacy';
import { acquireUpgradeLock, releaseUpgradeLock } from './upgrade-lock';
import { planInstallMigration } from './upgrade-migrate-dir';
import {
  type UpgradeServiceControl,
  createDirectProcessControl,
  hasLivePidFile,
  hasOwnedLivePidFile,
  pidFilePath,
} from './upgrade-process';
import { repairServiceIdentity, repairUpgrade } from './upgrade-repair';
import { backupRunScript } from './upgrade-run-script';
import {
  createManagedServiceControl,
  createServiceControl,
  resolveServiceMode,
} from './upgrade-service-control';
import { readCurrentVersion } from './upgrade-switch';
import { type ApplyUpgradeOptions, type UpgradeApplyDeps, executeUpgradeTxn } from './upgrade-txn';

export { resolveRepairMeta } from './upgrade-repair-meta';
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
export { repairServiceIdentity, repairUpgrade };
export type { RepairOutcome } from './upgrade-repair';

export function createTxnId(): string {
  return `${Date.now().toString(16)}-${randomBytes(4).toString('hex')}`;
}

export async function applyUpgrade(
  options: ApplyUpgradeOptions,
  deps: UpgradeApplyDeps
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
  await convertLegacyLayout(installDir, {
    bunPath,
    skipShims: options.skipShims,
    shimDirs: deps.shimDirs,
  });
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
