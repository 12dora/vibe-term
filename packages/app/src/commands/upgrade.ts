import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { formatHttpEndpoint, rewriteWildcardBindHost } from '../../../shared/src/network';
import { releaseTarballName } from '../../../shared/src/release/source';
import { defaultInstallDir } from '../constants';
import { t } from '../i18n';
import { checkBunVersion, readExplicitBunPath } from '../lib/bun';
import { getInstallHint } from '../lib/dep-install';
import { mergeMissingEnvFileKeys, readEnvFile } from '../lib/env-file';
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
  resolveReleaseVersion,
} from '../lib/release-fetch';
import {
  applyUpgrade,
  createServiceControl,
  createTxnId,
  repairUpgrade,
  resolveServiceMode,
  withUpgradeLock,
} from '../lib/upgrade-apply';
import { verifyTarballSha256 } from '../lib/upgrade-verify';
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
  const log = deps.log ?? ((message: string) => console.log(`[tmex] ${message}`));
  try {
    const result = await reenable({ installDir });
    if (!result.ok) {
      log(`direct re-enable skipped: ${result.reason}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
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

function passthroughUpgradeFlags(
  parsed: ParsedArgs,
  extra: Record<string, string | boolean>
): string[] {
  const args: string[] = [];
  const merged = { ...parsed.flags, ...extra };
  const passthrough = [
    'install-dir',
    'service-name',
    'yes',
    'lang',
    'bun-path',
    'keep-backup',
    'no-service',
    'txn',
    'version',
    'allow-missing-native',
  ];
  for (const key of passthrough) {
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

export async function delegateUpgrade(
  parsed: ParsedArgs,
  targetVersion: string,
  deps: DelegateUpgradeDeps = {}
): Promise<void> {
  const fetchFn = deps.fetch ?? fetch;
  const run = deps.runCommand ?? runCommand;
  const execPath = deps.execPath ?? process.execPath;
  const log = deps.log ?? ((message: string) => console.log(`[tmex] ${message}`));
  const version = await resolveReleaseVersion(targetVersion, fetchFn);
  const installDir = resolveInstallDir(
    asString(parsed.flags['install-dir']) || defaultInstallDir(process.platform)
  );
  const txnId = createTxnId();
  const stagingDir = join(installDir, 'staging', txnId);
  await ensureDir(stagingDir);

  try {
    const tarballPath = join(stagingDir, releaseTarballName(version));
    await downloadReleaseTarball(version, tarballPath, fetchFn);
    const bytes = await readFile(tarballPath);
    const sums = await fetchReleaseSha256Sums(version, releaseTarballName(version), fetchFn);
    if (sums.missing || !sums.hex) {
      log(t('upgrade.integrityUnverified'));
    } else if (!verifyTarballSha256(bytes, sums.hex)) {
      throw new Error(t('upgrade.integrityMismatch', { file: releaseTarballName(version) }));
    }

    const extractDir = join(stagingDir, 'extract');
    await ensureDir(extractDir);
    const tarResult = await run('tar', ['-xzf', tarballPath, '-C', extractDir]);
    if (tarResult.code !== 0) {
      throw new Error(t('upgrade.extractFailed', { code: tarResult.code }));
    }

    const packageRoot = join(extractDir, 'package');
    const cliJs = join(packageRoot, 'bin', 'tmex.js');
    if (!(await pathExists(cliJs))) {
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
  };
}

function printUpgradeDone(
  installDir: string,
  targetVersion: string,
  env: Record<string, string>
): void {
  const host = rewriteWildcardBindHost(String(env.TMEX_BIND_HOST || '127.0.0.1'));
  const port = String(env.GATEWAY_PORT || '9883');
  console.log(`[tmex] ${t('upgrade.done')}`);
  console.log(`- ${t('upgrade.summary.targetVersion')}: ${targetVersion}`);
  console.log(`- ${t('upgrade.summary.installDir')}: ${installDir}`);
  console.log(`- healthz: ${formatHttpEndpoint(host, port, '/healthz')}`);
}

const UPGRADE_FLAGS = new Set([
  'apply-current-package',
  'version',
  'install-dir',
  'service-name',
  'yes',
  'lang',
  'bun-path',
  'help',
  'repair',
  'keep-backup',
  'allow-missing-native',
]);

const UPGRADE_USAGE =
  'Usage: tmex upgrade [--version <version>] [--install-dir <path>] [--bun-path <path>] [--yes] [--lang <code>] [--repair] [--keep-backup] [--allow-missing-native]';

function assertKnownUpgradeFlags(parsed: ParsedArgs): void {
  const unknown = Object.keys(parsed.flags).filter((key) => !UPGRADE_FLAGS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown option(s): ${unknown.map((key) => `--${key}`).join(', ')}\n${UPGRADE_USAGE}`);
  }
}

export async function runUpgrade(parsed: ParsedArgs): Promise<void> {
  assertKnownUpgradeFlags(parsed);
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

  if (!(await pathExists(installLayout.metaPath))) {
    throw new Error(t('upgrade.missingMeta', { path: installLayout.metaPath }));
  }

  const meta = await readJsonFile<InstallMeta>(installLayout.metaPath);
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
    });
  });

  if (flags.repairOnly) return;

  const env = (await pathExists(installLayout.envPath))
    ? await readEnvFile(installLayout.envPath).catch(() => ({}) as Record<string, string>)
    : {};
  printUpgradeDone(installDir, flags.targetVersion, env);
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
}): Promise<void> {
  const service = createServiceControl({
    installDir: opts.installDir,
    meta: opts.meta,
    noServiceFlag: asBoolean(opts.parsed.flags['no-service']) ?? false,
  });
  const action = await repairUpgrade(opts.installDir, opts.bunPath, { service });
  if (opts.repairOnly) {
    console.log(`[tmex] ${t('upgrade.repairDone', { action })}`);
    return;
  }

  const packageLayout = asString(opts.parsed.flags.txn)
    ? await packageLayoutFromStaged(opts.installDir, asString(opts.parsed.flags.txn) as string)
    : await resolvePackageLayout(import.meta.url);
  const cliVersion = await readPackageVersion(packageLayout.packageRoot);
  const toVersion = asString(opts.parsed.flags.version) || cliVersion;

  if (await pathExists(opts.installLayout.envPath)) {
    await mergeMissingEnvFileKeys(opts.installLayout.envPath, hubEnvDefaults());
  }

  await applyUpgrade(
    {
      installDir: opts.installDir,
      toVersion,
      packageLayout,
      bunPath: opts.bunPath,
      keepBackup: opts.keepBackup,
      noService:
        resolveServiceMode(opts.meta, asBoolean(opts.parsed.flags['no-service']) ?? false) ===
        'none',
      allowMissingNative: opts.allowMissingNative,
      txnId: asString(opts.parsed.flags.txn),
      serviceName: opts.meta.serviceName,
      autostart: opts.meta.autostart,
    },
    { service }
  );
}

async function packageLayoutFromStaged(installDir: string, txnId: string) {
  const extract = join(installDir, 'staging', txnId, 'extract', 'package');
  if (await pathExists(join(extract, 'package.json'))) {
    return await packageLayoutFromRoot(extract);
  }
  return await resolvePackageLayout(import.meta.url);
}
