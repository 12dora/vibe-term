import { rm } from 'node:fs/promises';
import { defaultInstallDir } from '../constants';
import { sha256Hex } from '../lib/artifacts-manifest';
import { ensureDir, pathExists } from '../lib/fs-utils';
import { createInstallLayout, resolveInstallDir } from '../lib/install-layout';
import { writeJsonFile } from '../lib/json-file';
import {
  type InstalledNativeManifest,
  nativeAddonPath,
  nativeManifestPath,
  readInstalledNativeManifest,
} from '../lib/native-datachannel';
import {
  NATIVE_ADDON_FILENAME,
  type NativePin,
  detectCurrentNativePin,
  verifyNpmIntegrity,
} from '../lib/native-manifest';
import { extractTarGzipFile } from '../lib/native-tarball';
import { asString } from '../lib/validate';
import type { ParsedArgs } from '../types';

export interface EnableDirectOptions {
  installDir: string;
  pin?: NativePin;
  platform?: NodeJS.Platform | string;
  arch?: string;
  libc?: 'gnu' | 'glibc' | 'musl' | null | 'detect';
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export type DirectEnableResult =
  | { ok: true; platformId: string; version: string; addonPath: string; skipped?: boolean }
  | { ok: false; reason: string };

export interface DisableDirectOptions {
  installDir: string;
}

export function shouldEnableDirectForRoles(roles: string | string[]): boolean {
  const list = Array.isArray(roles)
    ? roles
    : roles
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  return list.includes('node');
}

function logLine(log: ((message: string) => void) | undefined, message: string): void {
  (log ?? ((line: string) => console.log(`[tmex] ${line}`)))(message);
}

export async function enableDirect(options: EnableDirectOptions): Promise<DirectEnableResult> {
  const log = (message: string) => logLine(options.log, message);
  const layout = createInstallLayout(options.installDir);
  const pin =
    options.pin ??
    detectCurrentNativePin({
      platform: options.platform,
      arch: options.arch,
      libc: options.libc,
    });

  if (!pin) {
    const reason = `direct native addon is not supported on ${options.platform ?? process.platform}/${options.arch ?? process.arch}`;
    log(reason);
    return { ok: false, reason };
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(pin.tarballUrl);
    if (!response.ok) {
      const reason = `failed to download ${pin.tarballUrl}: HTTP ${response.status}`;
      log(reason);
      return { ok: false, reason };
    }
    const tarball = new Uint8Array(await response.arrayBuffer());
    if (!verifyNpmIntegrity(tarball, pin.integrity)) {
      const reason = `integrity mismatch for ${pin.npmPackage}@${pin.version}`;
      log(reason);
      return { ok: false, reason };
    }

    const addon = extractTarGzipFile(tarball, pin.addonPath);
    if (!addon) {
      const reason = `addon ${pin.addonPath} not found in tarball`;
      log(reason);
      return { ok: false, reason };
    }

    await ensureDir(layout.nativeDir);
    const dest = nativeAddonPath(layout.nativeDir);
    await Bun.write(dest, addon);

    const manifest: InstalledNativeManifest = {
      platform: pin.platformId,
      version: pin.version,
      sha256: sha256Hex(addon),
      napiVersion: pin.napiVersion,
    };
    await writeJsonFile(nativeManifestPath(layout.nativeDir), manifest);

    log(`direct enabled: ${pin.platformId} ${pin.version} -> ${dest}`);
    return {
      ok: true,
      platformId: pin.platformId,
      version: pin.version,
      addonPath: dest,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`direct enable failed: ${reason}`);
    return { ok: false, reason };
  }
}

export async function disableDirect(options: DisableDirectOptions): Promise<void> {
  const layout = createInstallLayout(options.installDir);
  await rm(layout.nativeDir, { recursive: true, force: true });
}

export async function reenableDirectIfNeeded(
  options: EnableDirectOptions
): Promise<DirectEnableResult> {
  const layout = createInstallLayout(options.installDir);
  const addon = nativeAddonPath(layout.nativeDir);
  const hasAddon = await pathExists(addon);
  const installed = await readInstalledNativeManifest(layout.nativeDir);
  if (!hasAddon && !installed) {
    return {
      ok: true,
      skipped: true,
      platformId: installed?.platform ?? '',
      version: installed?.version ?? '',
      addonPath: addon,
    };
  }

  const pin =
    options.pin ??
    detectCurrentNativePin({
      platform: options.platform,
      arch: options.arch,
      libc: options.libc,
    });
  if (!pin) {
    return { ok: false, reason: 'direct native addon is not supported on this platform' };
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
  pin?: NativePin;
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
    });
    if (!result.ok) {
      console.log(`[tmex] direct enable skipped: ${result.reason}`);
      return;
    }
    if (result.skipped) {
      console.log(`[tmex] direct already enabled (${result.platformId} ${result.version})`);
      return;
    }
    console.log(`[tmex] direct enabled (${result.platformId} ${result.version})`);
    console.log(`- addon: ${result.addonPath}`);
    return;
  }

  if (action === 'disable') {
    await disableDirect({ installDir });
    console.log(`[tmex] direct disabled (removed ${createInstallLayout(installDir).nativeDir})`);
    return;
  }

  throw new Error('Usage: tmex direct enable|disable [--install-dir <path>]');
}

export const DIRECT_ADDON_FILENAME = NATIVE_ADDON_FILENAME;
