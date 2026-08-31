import { readFile } from 'node:fs/promises';
import type { DirectEnableResult, EnableDirectOptions } from '../commands/direct';
import { t } from '../i18n';
import { sha256Hex } from './artifacts-manifest';
import { copyDirectory, pathExists } from './fs-utils';
import { createVersionLayout } from './install-layout';
import {
  nativeAddonPath,
  nativeManifestPath,
  readInstalledNativeManifest,
} from './native-datachannel';
import { type NativePin, detectCurrentNativePin } from './native-manifest';

export async function currentHasNativeAddon(installDir: string, version: string): Promise<boolean> {
  const layout = createVersionLayout(installDir, version);
  const installed = await readInstalledNativeManifest(layout.nativeDir);
  return Boolean(installed);
}

export async function oldNativeMatchesPin(nativeDir: string, pin: NativePin): Promise<boolean> {
  const addon = nativeAddonPath(nativeDir);
  if (!(await pathExists(addon))) return false;
  const manifest = await readInstalledNativeManifest(nativeDir);
  if (!manifest) return false;
  if (!(await pathExists(nativeManifestPath(nativeDir)))) return false;
  const digest = sha256Hex(new Uint8Array(await readFile(addon)));
  return (
    digest === manifest.sha256 &&
    manifest.platform === pin.platformId &&
    manifest.version === pin.version &&
    manifest.napiVersion === pin.napiVersion
  );
}

export async function ensureCandidateNativeAddon(opts: {
  installDir: string;
  fromVersion: string;
  toVersion: string;
  allowMissingNative?: boolean;
  enableDirect?: (options: EnableDirectOptions) => Promise<DirectEnableResult>;
  log?: (message: string) => void;
  pin?: NativePin | null;
}): Promise<void> {
  if (!(await currentHasNativeAddon(opts.installDir, opts.fromVersion))) return;

  const fromLayout = createVersionLayout(opts.installDir, opts.fromVersion);
  const toLayout = createVersionLayout(opts.installDir, opts.toVersion);
  const pin =
    opts.pin === undefined
      ? detectCurrentNativePin({
          platform: process.platform,
          arch: process.arch,
        })
      : opts.pin;

  if (pin && (await oldNativeMatchesPin(fromLayout.nativeDir, pin))) {
    await copyDirectory(fromLayout.nativeDir, toLayout.nativeDir);
    return;
  }

  const enable = opts.enableDirect ?? (await import('../commands/direct')).enableDirect;
  const result = await enable({
    installDir: opts.installDir,
    layout: toLayout,
    pin: pin ?? undefined,
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
