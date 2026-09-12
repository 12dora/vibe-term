import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { formatHttpEndpoint, rewriteWildcardBindHost } from '../../../shared/src/network';
import { releaseTarballName } from '../../../shared/src/release/source';
import { defaultInstallDir } from '../constants';
import { t } from '../i18n';
import { checkBunVersion, readExplicitBunPath } from '../lib/bun';
import { defaultShimDirs } from '../lib/cli-shim';
import { getInstallHint } from '../lib/dep-install';
import { mergeMissingEnvFileKeys, readEnvFile } from '../lib/env-file';
import { errorMessage } from '../lib/error-message';
import { ensureDir, pathExists } from '../lib/fs-utils';
import { hubEnvDefaults } from '../lib/install';
import {
  type InstallLayout,
  createInstallLayout,
  packageLayoutFromRoot,
  resolveInstallDir,
  resolvePackageLayout,
} from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import { type RunCommandResult, runCommand } from '../lib/process';
import {
  type ReleaseFetch,
  downloadReleaseTarball,
  fetchReleaseSha256Sums,
  fetchReleaseSumsSignature,
  resolveReleaseVersion,
} from '../lib/release-fetch';
import {
  applyUpgrade,
  createServiceControl,
  createTxnId,
  repairUpgrade,
  resolveRepairMeta,
  resolveServiceMode,
  withUpgradeLock,
} from '../lib/upgrade-apply';
import { UPGRADE_FLAGS, UPGRADE_PASSTHROUGH_FLAGS, UPGRADE_USAGE } from '../lib/upgrade-flags';
import {
  clearWrittenPortEnvKeys,
  printRtcPortRangeFixedNotice,
  takeWrittenPortEnvKeys,
} from '../lib/upgrade-port-env';
import { assertReleaseIntegrity, assertReleaseSignature } from '../lib/upgrade-verify';
import { asBoolean, asString } from '../lib/validate';
import { readPackageVersion } from '../lib/version';
import type { InstallMeta, ParsedArgs } from '../types';
import {
  type DirectEnableResult,
  type EnableDirectOptions,
  reenableDirectIfNeeded,
} from './direct';

export type ReenableDirectAfterUpgradeDeps = {
  reenableDirectIfNeeded?: (options: EnableDirectOptions) => Promise<DirectEnableResult>;
  log?: (message: string) => void;
};

export async function reenableDirectAfterUpgrade(
  installDir: string,
  deps: ReenableDirectAfterUpgradeDeps = {}
): Promise<void> {
  const reenable = deps.reenableDirectIfNeeded ?? reenableDirectIfNeeded;
  const log = deps.log ?? ((message: string) => console.log(`[vibeterm] ${message}`));
  try {
    const result = await reenable({ installDir });
    if (!result.ok) {
      log(`direct re-enable skipped: ${result.reason}`);
    }
  } catch (error) {
    const reason = errorMessage(error);
    log(`direct re-enable skipped: ${reason}`);
  }
}

export type DelegateUpgradeDeps = {
  fetch?: ReleaseFetch;
  runCommand?: (
    command: string,
    args: string[],
    options?: { cwd?: string; stdio?: 'inherit' | 'pipe' }
  ) => Promise<RunCommandResult>;
  execPath?: string;
  log?: (message: string) => void;
};

export function passthroughUpgradeFlags(
  parsed: ParsedArgs,
  extra: Record<string, string | boolean>
): string[] {
  const args: string[] = [];
  const merged = { ...parsed.flags, ...extra };
  for (const key of UPGRADE_PASSTHROUGH_FLAGS) {
    const value = merged[key];
    if (value === undefined) continue;
    if (value === true) {
      args.push(`--${key}`);
    } else {
      args.push(`--${key}`, String(value));
    }
  }
  return args;
}

async function firstExistingPath(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

export async function delegateUpgrade(
  parsed: ParsedArgs,
  targetVersion: string,
  deps: DelegateUpgradeDeps = {}
): Promise<void> {
  const fetchFn = deps.fetch ?? fetch;
  const run = deps.runCommand ?? runCommand;
  const execPath = deps.execPath ?? process.execPath;
  const log = deps.log ?? ((message: string) => console.log(`[vibeterm] ${message}`));
  const version = await resolveReleaseVersion(targetVersion, fetchFn);
  const installDir = resolveInstallDir(
    asString(parsed.flags['install-dir']) || defaultInstallDir(process.platform)
  );
  const txnId = createTxnId();
  const stagingDir = join(installDir, 'staging', txnId);
  await ensureDir(stagingDir);

  try {
    const tarballPath = join(stagingDir, releaseTarballName(version));
    const assetName = await downloadReleaseTarball(version, tarballPath, fetchFn);
    const bytes = await readFile(tarballPath);
    const sums = await fetchReleaseSha256Sums(version, assetName, fetchFn);
    const allowUnverified = asBoolean(parsed.flags['allow-unverified']) === true;
    assertReleaseIntegrity(version, bytes, sums, {
      allowUnverified,
      fileName: assetName,
    });
    // 摘要对上了只说明字节没被中途改；签名才回答「这份 SHA256SUMS 是不是发布方给的」。
    if (!sums.unpublished) {
      assertReleaseSignature(version, sums.text, await fetchReleaseSumsSignature(version, fetchFn));
    }
    if (sums.unpublished === true) {
      log(t('upgrade.integrityUnverified'));
    }

    const extractDir = join(stagingDir, 'extract');
    await ensureDir(extractDir);
    const tarResult = await run('tar', ['-xzf', tarballPath, '-C', extractDir]);
    if (tarResult.code !== 0) {
      throw new Error(t('upgrade.extractFailed', { code: tarResult.code }));
    }

    const packageRoot = join(extractDir, 'package');
    // 桥接期的旧名资产里两个 bin 都在；再老的包只有 `bin/tmex.js`。
    const cliJs = await firstExistingPath([
      join(packageRoot, 'bin', 'vibeterm.js'),
      join(packageRoot, 'bin', 'tmex.js'),
    ]);
    if (cliJs === null) {
      throw new Error(t('upgrade.assetMissing', { version }));
    }

    const args = [
      cliJs,
      'upgrade',
      '--apply-current-package',
      ...passthroughUpgradeFlags(parsed, { txn: txnId, version }),
    ];
    const result = await run(execPath, args, { stdio: 'inherit' });
    if (result.code !== 0) {
      process.exitCode = result.code;
      throw new Error(t('upgrade.delegateFailed', { code: result.code }));
    }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => null);
    throw error;
  }
}

function parseUpgradeRunFlags(parsed: ParsedArgs) {
  return {
    applyCurrent: asBoolean(parsed.flags['apply-current-package']) === true,
    repairOnly: asBoolean(parsed.flags.repair) === true,
    targetVersion: asString(parsed.flags.version) || 'latest',
    keepBackup: asBoolean(parsed.flags['keep-backup']) === true,
    allowMissingNative: asBoolean(parsed.flags['allow-missing-native']) === true,
    allowUnverified: asBoolean(parsed.flags['allow-unverified']) === true,
  };
}

function printUpgradeDone(
  installDir: string,
  targetVersion: string,
  env: Record<string, string>
): void {
  const host = rewriteWildcardBindHost(String(env.VIBETERM_BIND_HOST || '127.0.0.1'));
  const port = String(env.GATEWAY_PORT || '9883');
  console.log(`[vibeterm] ${t('upgrade.done')}`);
  console.log(`- ${t('upgrade.summary.targetVersion')}: ${targetVersion}`);
  console.log(`- ${t('upgrade.summary.installDir')}: ${installDir}`);
  console.log(`- healthz: ${formatHttpEndpoint(host, port, '/healthz')}`);
  printRtcPortRangeFixedNotice(takeWrittenPortEnvKeys(), (message) =>
    console.log(`[vibeterm] ${message}`)
  );
}

export function assertKnownUpgradeFlags(parsed: ParsedArgs): void {
  const unknown = Object.keys(parsed.flags).filter((key) => !UPGRADE_FLAGS.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option(s): ${unknown.map((key) => `--${key}`).join(', ')}\n${UPGRADE_USAGE}`
    );
  }
}

export type RunUpgradeDeps = {
  repair?: typeof repairUpgrade;
  apply?: typeof applyUpgrade;
};

export async function runUpgrade(parsed: ParsedArgs, deps: RunUpgradeDeps = {}): Promise<void> {
  assertKnownUpgradeFlags(parsed);
  clearWrittenPortEnvKeys();
  if (parsed.flags.help) {
    console.log(UPGRADE_USAGE);
    return;
  }
  const flags = parseUpgradeRunFlags(parsed);
  if (!flags.applyCurrent && !flags.repairOnly) {
    await delegateUpgrade(parsed, flags.targetVersion);
    return;
  }

  const installDir = resolveInstallDir(
    asString(parsed.flags['install-dir']) || defaultInstallDir(process.platform)
  );
  const installLayout = createInstallLayout(installDir);

  const recovered = flags.repairOnly
    ? await resolveRepairMeta(installDir, {
        repairServiceName: asString(parsed.flags['service-name']),
        repairNoService: asBoolean(parsed.flags['no-service']) === true,
      })
    : null;
  if (!recovered && !(await pathExists(installLayout.metaPath))) {
    throw new Error(t('upgrade.missingMeta', { path: installLayout.metaPath }));
  }

  const meta = recovered?.meta ?? (await readJsonFile<InstallMeta>(installLayout.metaPath));
  const bunPath = await requireUpgradeBun(parsed, meta);

  await withUpgradeLock(installDir, async () => {
    await runLockedUpgrade({
      parsed,
      installDir,
      installLayout,
      meta,
      bunPath,
      repairOnly: flags.repairOnly,
      keepBackup: flags.keepBackup,
      allowMissingNative: flags.allowMissingNative,
      repair: deps.repair,
      apply: deps.apply,
    });
  });

  if (flags.repairOnly) return;

  const finalDir = await resolvePostUpgradeInstallDir(installDir);
  const finalEnvPath = createInstallLayout(finalDir).envPath;
  const env = (await pathExists(finalEnvPath))
    ? await readEnvFile(finalEnvPath).catch(() => ({}) as Record<string, string>)
    : {};
  printUpgradeDone(finalDir, flags.targetVersion, env);
}

/** 升级可能把安装目录搬到新默认路径，摘要要按搬完之后的位置打印。 */
async function resolvePostUpgradeInstallDir(installDir: string): Promise<string> {
  if (await pathExists(join(installDir, 'install-meta.json'))) return installDir;
  const migrated = defaultInstallDir(process.platform);
  return (await pathExists(join(migrated, 'install-meta.json'))) ? migrated : installDir;
}

async function requireUpgradeBun(parsed: ParsedArgs, meta: InstallMeta): Promise<string> {
  const bun = await checkBunVersion(undefined, {
    explicitPath: readExplicitBunPath(parsed.flags),
    metaBunPath: meta.bunPath,
  });
  if (bun.ok && bun.path) return bun.path;
  const hint = getInstallHint('bun');
  const reason = bun.reason || t('bun.checkFailed');
  throw new Error(`${reason}\n${t('deps.install.hint', { command: hint })}`);
}

async function runLockedUpgrade(opts: {
  parsed: ParsedArgs;
  installDir: string;
  installLayout: InstallLayout;
  meta: InstallMeta;
  bunPath: string;
  repairOnly: boolean;
  keepBackup: boolean;
  allowMissingNative: boolean;
  repair?: typeof repairUpgrade;
  apply?: typeof applyUpgrade;
}): Promise<void> {
  const noServiceFlag = asBoolean(opts.parsed.flags['no-service']) ?? false;
  // repair 会改写磁盘上的 meta（提交迁移后的服务名、把安装搬回旧目录），闭包里这份随之过期，
  // 因此它是可变的：repair 之后重新读盘，后续控制器与 apply 参数一律用新值。
  let meta = opts.meta;
  // repair 必须能按 journal 推导出的目录 / 服务身份重建控制器：在读 journal 之前建好的那一个
  // 用的是旧身份，迁移中断后会漏停 com.vibeterm.*，撤销迁移后又会去启动已经搬走的 run.sh。
  const buildService = (o: {
    installDir: string;
    serviceName?: string;
    legacyServiceName?: string;
    legacyLabel?: boolean;
  }) =>
    createServiceControl({
      installDir: o.installDir,
      meta,
      noServiceFlag,
      serviceName: o.serviceName,
      legacyServiceName: o.legacyServiceName,
      legacyLabel: o.legacyLabel,
    });
  const repair = opts.repair ?? repairUpgrade;
  const apply = opts.apply ?? applyUpgrade;
  const activeTxnId = asString(opts.parsed.flags.txn) ?? null;
  const shimDirs = defaultShimDirs();
  const repaired = await repair(opts.installDir, opts.bunPath, {
    repairServiceName: asString(opts.parsed.flags['service-name']),
    repairNoService: noServiceFlag,
    rebuildService: buildService,
    activeTxnId,
    shimDirs,
  });
  if (opts.repairOnly) {
    console.log(`[vibeterm] ${t('upgrade.repairDone', { action: repaired.action })}`);
    return;
  }

  // 撤销迁移会把安装搬回旧目录，后面的一切都要按恢复之后的路径来。
  const installDir = repaired.installDir;
  const installLayout =
    installDir === opts.installDir ? opts.installLayout : createInstallLayout(installDir);
  meta = await readMetaAfterRepair(installLayout, meta);
  const service = buildService({ installDir });

  const packageLayout = asString(opts.parsed.flags.txn)
    ? await packageLayoutFromStaged(installDir, asString(opts.parsed.flags.txn) as string)
    : await resolvePackageLayout(import.meta.url);
  const cliVersion = await readPackageVersion(packageLayout.packageRoot);
  const toVersion = asString(opts.parsed.flags.version) || cliVersion;

  if (await pathExists(installLayout.envPath)) {
    await mergeMissingEnvFileKeys(installLayout.envPath, hubEnvDefaults());
  }

  await apply(
    {
      installDir,
      toVersion,
      packageLayout,
      bunPath: opts.bunPath,
      keepBackup: opts.keepBackup,
      noService: resolveServiceMode(meta, noServiceFlag) === 'none',
      allowMissingNative: opts.allowMissingNative,
      txnId: asString(opts.parsed.flags.txn),
      serviceName: meta.serviceName,
      autostart: meta.autostart,
    },
    { service, shimDirs }
  );
}

/** repair 之后磁盘上的 meta 才是权威的（服务名可能刚被提交为 vibeterm，目录也可能已搬回）。 */
async function readMetaAfterRepair(
  layout: InstallLayout,
  fallback: InstallMeta
): Promise<InstallMeta> {
  if (!(await pathExists(layout.metaPath))) return fallback;
  return await readJsonFile<InstallMeta>(layout.metaPath).catch(() => fallback);
}

async function packageLayoutFromStaged(installDir: string, txnId: string) {
  const extract = join(installDir, 'staging', txnId, 'extract', 'package');
  if (await pathExists(join(extract, 'package.json'))) {
    return await packageLayoutFromRoot(extract);
  }
  return await resolvePackageLayout(import.meta.url);
}
