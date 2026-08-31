import type { DirectEnableResult, EnableDirectOptions } from '../commands/direct';
import { t } from '../i18n';
import { pathExists } from './fs-utils';
import { createVersionLayout } from './install-layout';
import { nativeAddonPath, readInstalledNativeManifest } from './native-datachannel';

export async function currentHasNativeAddon(installDir: string, version: string): Promise<boolean> {
  const layout = createVersionLayout(installDir, version);
  const installed = await readInstalledNativeManifest(layout.nativeDir);
  return Boolean(installed);
}

export async function ensureCandidateNativeAddon(opts: {
  installDir: string;
  fromVersion: string;
  toVersion: string;
  allowMissingNative?: boolean;
  enableDirect?: (options: EnableDirectOptions) => Promise<DirectEnableResult>;
  log?: (message: string) => void;
}): Promise<void> {
  if (!(await currentHasNativeAddon(opts.installDir, opts.fromVersion))) return;

  const toLayout = createVersionLayout(opts.installDir, opts.toVersion);
  const enable = opts.enableDirect ?? (await import('../commands/direct')).enableDirect;
  const result = await enable({
    installDir: opts.installDir,
    layout: toLayout,
  });
  const addonOk =
    result.ok &&
    (await pathExists(nativeAddonPath(toLayout.nativeDir))) &&
    Boolean(await readInstalledNativeManifest(toLayout.nativeDir));
  if (addonOk) return;

  const error = result.ok ? 'manifest or addon missing after install' : result.reason;
  if (opts.allowMissingNative) {
    opts.log?.(
      t('upgrade.nativeRequired', {
        fromVersion: opts.fromVersion,
        toVersion: opts.toVersion,
        error,
      })
    );
    return;
  }
  throw new Error(
    t('upgrade.nativeRequired', {
      fromVersion: opts.fromVersion,
      toVersion: opts.toVersion,
      error,
    })
  );
}
