import { rm } from 'node:fs/promises';
import { defaultInstallDir } from '../constants';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import { errorMessage } from '../lib/error-message';
import type { FetchLike } from '../lib/fetch-like';
import { pathExists } from '../lib/fs-utils';
import { type InstallLayout, createInstallLayout, resolveInstallDir } from '../lib/install-layout';
import { nativeAddonPath, readInstalledNativeManifest } from '../lib/native-datachannel';
import { type NativePin, detectCurrentNativePin } from '../lib/native-manifest';
import { asString } from '../lib/validate';
import type { ParsedArgs } from '../types';
import { enableDirect, promoteNativeDirectory } from './direct-enable';

export interface EnableDirectOptions {
  installDir: string;
  layout?: InstallLayout;
  pin?: NativePin | null;
  platform?: NodeJS.Platform | string;
  arch?: string;
  libc?: 'gnu' | 'glibc' | 'musl' | null | 'detect';
  fetchImpl?: FetchLike;
  log?: (message: string) => void;
  signal?: AbortSignal;
  skipExisting?: boolean;
}

export type DirectEnableFailureKind = 'unsupported' | 'download' | 'integrity' | 'install';

export type DirectEnableResult =
  | { ok: true; platformId: string; version: string; addonPath: string; skipped?: boolean }
  | { ok: false; kind?: DirectEnableFailureKind; reason: string; unsupported?: boolean };

export interface DisableDirectOptions {
  installDir: string;
}

export const DIRECT_ENABLE_TIMEOUT_MS = 60_000;

export type DirectOnboardingDeps = {
  enableDirect?: (options: EnableDirectOptions) => Promise<DirectEnableResult>;
  log?: (message: string) => void;
};

export { enableDirect, promoteNativeDirectory };

export async function enableDirectForOnboarding(
  installDir: string,
  deps: DirectOnboardingDeps = {},
  envPath?: string
): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(`[vibeterm] ${message}`));
  try {
    const result = await (deps.enableDirect ?? enableDirect)({
      installDir,
      skipExisting: true,
      signal: AbortSignal.timeout(DIRECT_ENABLE_TIMEOUT_MS),
      log: () => undefined,
    });
    if (!result.ok) {
      log(
        `direct plugin: skipped (${result.kind ? `${result.kind} failed: ` : ''}${result.reason})`
      );
      return;
    }
    if (envPath) {
      await withEnvLock(async () => {
        const env = await readEnvFile(envPath);
        env.VIBETERM_DIRECT_ENABLED = 'true';
        await writeEnvFile(envPath, env);
      });
    }
    log(
      result.skipped
        ? 'direct plugin: skipped (already installed)'
        : `direct plugin: installed ${result.platformId} ${result.version}`
    );
  } catch (error) {
    log(`direct plugin: skipped (${errorMessage(error)})`);
  }
}

export async function disableDirect(options: DisableDirectOptions): Promise<void> {
  const layout = createInstallLayout(options.installDir);
  await rm(layout.nativeDir, { recursive: true, force: true });
}

export async function reenableDirectIfNeeded(
  options: EnableDirectOptions
): Promise<DirectEnableResult> {
  const layout = options.layout ?? createInstallLayout(options.installDir);
  const addon = nativeAddonPath(layout.nativeDir);
  const hasAddon = await pathExists(addon);
  const installed = await readInstalledNativeManifest(layout.nativeDir);
  if (!hasAddon && !installed) {
    return {
      ok: true,
      skipped: true,
      platformId: '',
      version: '',
      addonPath: addon,
    };
  }

  const pin =
    options.pin === undefined
      ? detectCurrentNativePin({
          platform: options.platform,
          arch: options.arch,
          libc: options.libc,
        })
      : options.pin;
  if (!pin) {
    return {
      ok: false,
      reason: 'direct native addon is not supported on this platform',
      unsupported: true,
    };
  }
  if (installed?.version === pin.version && hasAddon) {
    return {
      ok: true,
      skipped: true,
      platformId: pin.platformId,
      version: pin.version,
      addonPath: addon,
    };
  }
  return await enableDirect(options);
}

export interface RunDirectDeps {
  pin?: NativePin | null;
  fetchImpl?: FetchLike;
  platform?: NodeJS.Platform | string;
  arch?: string;
}

export async function runDirect(parsed: ParsedArgs, deps: RunDirectDeps = {}): Promise<void> {
  const action = parsed.positionals[0];
  const installDir = resolveInstallDir(
    asString(parsed.flags['install-dir']) || defaultInstallDir(process.platform)
  );

  if (action === 'enable') {
    const result = await enableDirect({
      installDir,
      pin: deps.pin,
      fetchImpl: deps.fetchImpl,
      platform: deps.platform,
      arch: deps.arch,
    });
    if (!result.ok) {
      if (result.unsupported || result.kind === 'unsupported') {
        console.log(`[vibeterm] direct enable skipped: ${result.reason}`);
        return;
      }
      console.error(`[vibeterm] direct enable failed: ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    if (result.skipped) {
      console.log(`[vibeterm] direct already enabled (${result.platformId} ${result.version})`);
      return;
    }
    console.log(`[vibeterm] direct enabled (${result.platformId} ${result.version})`);
    console.log(`- addon: ${result.addonPath}`);
    return;
  }

  if (action === 'disable') {
    await disableDirect({ installDir });
    console.log(
      `[vibeterm] direct disabled (removed ${createInstallLayout(installDir).nativeDir})`
    );
    return;
  }

  throw new Error('Usage: vibeterm direct enable|disable [--install-dir <path>]');
}
