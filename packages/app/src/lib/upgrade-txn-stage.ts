import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { t } from '../i18n';
import type { ServiceMode } from '../types';
import { type ShimDirs, deployCliPackage } from './cli-shim';
import { readEnvFile } from './env-file';
import { errorMessage } from './error-message';
import { pathExists } from './fs-utils';
import { deployRuntimeFiles, writeRunScript } from './install';
import { type PackageLayout, createInstallLayout, createVersionLayout } from './install-layout';
import { copyDbTrio } from './upgrade-db';
import { removeTxnDirs, safeRemoveDir } from './upgrade-gc';
import type { HealthCheckFn } from './upgrade-health';
import { liveHealthUrl } from './upgrade-health';
import { ensureCandidateNativeAddon } from './upgrade-native';
import type { UpgradeServiceControl } from './upgrade-process';
import { restoreRunScript, runScriptBackupPath } from './upgrade-run-script';
import { type UpgradeJournal, advanceJournal, writeJournal } from './upgrade-state';
import { switchCurrent, versionDirPath } from './upgrade-switch';
import type { ApplyUpgradeOptions, TxnContext, UpgradeApplyDeps } from './upgrade-txn';
import { commitSuccess, killRecordedCandidate, removeCandidateVersion } from './upgrade-txn-commit';
import { HEALTH_TIMEOUT_MS, runPreflight } from './upgrade-txn-preflight';

export async function deployPackageToVersionDir(
  packageLayout: PackageLayout,
  installDir: string,
  version: string
): Promise<void> {
  const layout = createVersionLayout(installDir, version);
  await deployRuntimeFiles(packageLayout, layout);
  await deployCliPackage(packageLayout, layout);
}

async function promoteStagingToVersion(input: {
  installDir: string;
  txnId: string;
  toVersion: string;
  packageLayout: PackageLayout;
}): Promise<void> {
  const dest = versionDirPath(input.installDir, input.toVersion);
  if (await pathExists(dest)) {
    await safeRemoveDir(input.installDir, dest);
  }
  const stagedPkg = join(input.installDir, 'staging', input.txnId, 'pkg');
  if (await pathExists(stagedPkg)) {
    await rename(stagedPkg, dest);
    return;
  }
  await deployPackageToVersionDir(input.packageLayout, input.installDir, input.toVersion);
}

async function stageCandidate(input: {
  installDir: string;
  txnId: string;
  toVersion: string;
  packageLayout: PackageLayout;
}): Promise<void> {
  const pkgVersion = JSON.parse(
    await readFile(join(input.packageLayout.packageRoot, 'package.json'), 'utf8')
  ) as { version?: string };
  if (pkgVersion.version && pkgVersion.version !== input.toVersion) {
    throw new Error(
      t('upgrade.healthVersionMismatch', {
        expected: input.toVersion,
        actual: pkgVersion.version,
      })
    );
  }
  await promoteStagingToVersion(input);
}

export async function backupAndSwitch(input: {
  installDir: string;
  journal: UpgradeJournal;
  toVersion: string;
  bunPath: string;
  shimDirs: ShimDirs;
  skipShims?: boolean;
}): Promise<UpgradeJournal> {
  const layout = createInstallLayout(input.installDir);
  const env = await readEnvFile(layout.envPath).catch(() => null);
  let next = input.journal;
  if (env?.DATABASE_URL) {
    await copyDbTrio(env.DATABASE_URL, join(input.installDir, 'backups', input.journal.txnId));
    next = await advanceJournal(input.installDir, input.journal, 'switching', { dbBackup: true });
  } else {
    next = await advanceJournal(input.installDir, input.journal, 'switching');
  }
  await switchCurrent(input.installDir, input.toVersion);
  await writeRunScript(createInstallLayout(input.installDir), input.bunPath);
  if (!input.skipShims) {
    const [localBinDir, bunBinDir] = input.shimDirs;
    const { installVibeTermShim } = await import('./cli-shim');
    await installVibeTermShim({
      installLayout: createInstallLayout(input.installDir),
      bunPath: input.bunPath,
      localBinDir,
      bunBinDir,
    });
  }
  return next;
}

export async function startNewAndCommit(input: {
  installDir: string;
  journal: UpgradeJournal;
  toVersion: string;
  bunPath: string;
  keepBackup: boolean;
  service: UpgradeServiceControl;
  healthCheck: HealthCheckFn;
  log: (message: string) => void;
  serviceMode?: ServiceMode;
  serviceName?: string;
}): Promise<void> {
  const next = await advanceJournal(input.installDir, input.journal, 'started');
  await input.service.start();
  const url = await liveHealthUrl(input.installDir);
  if (!url) throw new Error(t('upgrade.healthFailed', { status: 'missing-env' }));
  await input.healthCheck({
    url,
    expectedVersion: input.toVersion,
    timeoutMs: HEALTH_TIMEOUT_MS,
    requireTlsListener: true,
  });
  await commitSuccess(
    input.installDir,
    next,
    input.bunPath,
    input.keepBackup,
    input.log,
    input.serviceMode,
    input.serviceName
  );
}

export async function stageAndPreflight(
  installDir: string,
  journal: UpgradeJournal,
  options: ApplyUpgradeOptions,
  deps: UpgradeApplyDeps,
  ctx: TxnContext
): Promise<UpgradeJournal> {
  let next = await advanceJournal(installDir, journal, 'staging', { keepBackup: ctx.keepBackup });
  await stageCandidate({
    installDir,
    txnId: ctx.txnId,
    toVersion: ctx.toVersion,
    packageLayout: ctx.packageLayout,
  });
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
