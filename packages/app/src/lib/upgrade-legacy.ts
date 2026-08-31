import { join } from 'node:path';
import { t } from '../i18n';
import type { InstallMeta } from '../types';
import { copyDirectory, pathExists } from './fs-utils';
import { writeRunScript } from './install';
import { createLegacyLayout, createVersionLayout, hasCurrentLayout } from './install-layout';
import { readJsonFile } from './json-file';
import { switchCurrent } from './upgrade-switch';

const LEGACY_DIRS = ['cli', 'runtime', 'resources', 'native'] as const;

export async function convertLegacyLayout(
  installDir: string,
  options: { bunPath: string; skipShims?: boolean; localBinDir?: string; bunBinDir?: string }
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

  const cliJs = join(installDir, 'current', 'cli', 'bin', 'tmex.js');
  if (!options.skipShims && (await pathExists(cliJs))) {
    const { installTmexShim } = await import('./cli-shim');
    await installTmexShim({
      installLayout: dest,
      bunPath: options.bunPath,
      localBinDir: options.localBinDir,
      bunBinDir: options.bunBinDir,
    });
  }

  return true;
}
