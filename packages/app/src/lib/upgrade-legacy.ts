import { readlink, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_SERVICE_NAME } from '../constants';
import { t } from '../i18n';
import type { InstallMeta } from '../types';
import type { ShimDirs } from './cli-shim';
import { copyDirectory, pathExists } from './fs-utils';
import { writeRunScript } from './install';
import { createLegacyLayout, createVersionLayout, hasCurrentLayout } from './install-layout';
import { readJsonFile } from './json-file';
import { LEGACY_SERVICE_NAME, isLegacyLabelVersion } from './upgrade-migrate-dir';
import { readCurrentVersion, switchCurrent } from './upgrade-switch';

const LEGACY_DIRS = ['cli', 'runtime', 'resources', 'native'] as const;

export async function readRepairInstallMeta(
  installDir: string,
  bunPath?: string
): Promise<{ meta: InstallMeta; rebuilt: boolean } | null> {
  const raw = await readJsonFile<Partial<InstallMeta> | null>(
    join(installDir, 'install-meta.json')
  ).catch(() => null);
  if (typeof raw?.cliVersion === 'string' && raw.cliVersion.trim()) {
    return { meta: raw as InstallMeta, rebuilt: false };
  }
  const fromVersion = await readRecoverableCurrentVersion(installDir);
  if (!fromVersion) return null;
  return { rebuilt: true, meta: rebuildInstallMeta(installDir, fromVersion, raw, bunPath) };
}

async function readRecoverableCurrentVersion(installDir: string): Promise<string | null> {
  const version = await readCurrentVersion(installDir);
  if (!version) return null;
  const target = await readlink(join(installDir, 'current')).catch(() => null);
  if (!target || dirname(resolve(installDir, target)) !== resolve(installDir, 'versions')) {
    return null;
  }
  const root = await realpath(installDir);
  const expected = join(root, 'versions', version);
  const resolved = await realpath(join(installDir, 'current')).catch(() => null);
  if (resolved !== expected) return null;
  return (await stat(resolved)).isDirectory() ? version : null;
}

function rebuildInstallMeta(
  installDir: string,
  fromVersion: string,
  raw: Partial<InstallMeta> | null,
  bunPath?: string
): InstallMeta {
  return {
    serviceName:
      typeof raw?.serviceName === 'string' && raw.serviceName.trim()
        ? raw.serviceName
        : isLegacyLabelVersion(fromVersion)
          ? LEGACY_SERVICE_NAME
          : DEFAULT_SERVICE_NAME,
    platform: process.platform,
    autostart: typeof raw?.autostart === 'boolean' ? raw.autostart : true,
    installDir,
    updatedAt: new Date().toISOString(),
    cliVersion: fromVersion,
    bunPath: bunPath ?? (typeof raw?.bunPath === 'string' ? raw.bunPath : undefined),
    serviceMode: raw?.serviceMode === 'none' ? 'none' : 'managed',
    ...(raw?.installSource === 'install-script' ||
    raw?.installSource === 'npx' ||
    raw?.installSource === 'cli'
      ? { installSource: raw.installSource }
      : {}),
  };
}

export async function convertLegacyLayout(
  installDir: string,
  options: { bunPath: string; skipShims?: boolean; shimDirs: ShimDirs }
): Promise<boolean> {
  if (hasCurrentLayout(installDir)) return false;

  const metaPath = join(installDir, 'install-meta.json');
  if (!(await pathExists(metaPath))) {
    throw new Error(t('upgrade.missingMeta', { path: metaPath }));
  }
  const meta = await readJsonFile<InstallMeta>(metaPath);
  const fromVersion = meta.cliVersion?.trim();
  if (!fromVersion) {
    throw new Error(t('upgrade.legacyMissingVersion', { path: metaPath }));
  }

  const dest = createVersionLayout(installDir, fromVersion);
  const src = createLegacyLayout(installDir);
  for (const name of LEGACY_DIRS) {
    const from = join(src.installDir, name);
    const to = join(dest.installDir, 'versions', fromVersion, name);
    if (await pathExists(from)) {
      await copyDirectory(from, to);
    }
  }

  await switchCurrent(installDir, fromVersion);
  await writeRunScript(dest, options.bunPath);

  const cliJs = join(installDir, 'current', 'cli', 'bin', 'vibeterm.js');
  if (!options.skipShims && (await pathExists(cliJs))) {
    const { installVibeTermShim } = await import('./cli-shim');
    const [localBinDir, bunBinDir] = options.shimDirs;
    await installVibeTermShim({
      installLayout: dest,
      bunPath: options.bunPath,
      localBinDir,
      bunBinDir,
    });
  }

  return true;
}
