import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultInstallDir } from '../constants';
import { sha256Hex } from '../lib/artifacts-manifest';
import { ensureDir, pathExists } from '../lib/fs-utils';
import { type InstallLayout, createInstallLayout, resolveInstallDir } from '../lib/install-layout';
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
  layout?: InstallLayout;
  pin?: NativePin | null;
  platform?: NodeJS.Platform | string;
  arch?: string;
  libc?: 'gnu' | 'glibc' | 'musl' | null | 'detect';
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  signal?: AbortSignal;
}

export type DirectEnableFailureKind = 'unsupported' | 'download' | 'integrity' | 'install';

export type DirectEnableResult =
  | { ok: true; platformId: string; version: string; addonPath: string; skipped?: boolean }
  | { ok: false; kind?: DirectEnableFailureKind; reason: string; unsupported?: boolean };

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

function fail(
  kind: DirectEnableFailureKind,
  reason: string
): Extract<DirectEnableResult, { ok: false }> {
  return kind === 'unsupported'
    ? { ok: false, kind, reason, unsupported: true }
    : { ok: false, kind, reason };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError' || name === 'TimeoutError' || name === 'DOMException';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(abortError(signal));
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

async function readResponseBytes(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (!response.body) {
    return new Uint8Array(await withAbort(response.arrayBuffer(), signal));
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function promoteNativeDirectory(
  stagingDir: string,
  nativeDir: string,
  backupDir: string
): Promise<void> {
  let backedUp = false;
  try {
    if (await pathExists(backupDir)) {
      await removeDir(backupDir);
    }
    if (await pathExists(nativeDir)) {
      await rename(nativeDir, backupDir);
      backedUp = true;
    }
    await rename(stagingDir, nativeDir);
  } catch (error) {
    if (backedUp) {
      try {
        if (await pathExists(nativeDir)) {
          await removeDir(nativeDir);
        }
        await rename(backupDir, nativeDir);
      } catch {
        // prefer the original promotion error
      }
    }
    throw error;
  }
  if (backedUp) {
    await removeDir(backupDir).catch(() => undefined);
  }
}

function layoutForDirect(options: EnableDirectOptions): InstallLayout {
  if (options.layout) return options.layout;
  return createInstallLayout(options.installDir);
}

export async function enableDirect(options: EnableDirectOptions): Promise<DirectEnableResult> {
  const log = (message: string) => logLine(options.log, message);
  const layout = layoutForDirect(options);
  const signal = options.signal;
  const pin =
    options.pin === undefined
      ? detectCurrentNativePin({
          platform: options.platform,
          arch: options.arch,
          libc: options.libc,
        })
      : options.pin;

  if (!pin) {
    const reason = `direct native addon is not supported on ${options.platform ?? process.platform}/${options.arch ?? process.arch}`;
    log(reason);
    return fail('unsupported', reason);
  }

  let stagingDir: string | null = null;
  let phase: Exclude<DirectEnableFailureKind, 'unsupported'> = 'download';
  try {
    throwIfAborted(signal);
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await withAbort(
      Promise.resolve(fetchImpl(pin.tarballUrl, { signal })),
      signal
    );
    if (!response.ok) {
      const reason = `failed to download ${pin.tarballUrl}: HTTP ${response.status}`;
      log(reason);
      return fail('download', reason);
    }
    const tarball = await readResponseBytes(response, signal);

    phase = 'integrity';
    throwIfAborted(signal);
    if (!verifyNpmIntegrity(tarball, pin.integrity)) {
      const reason = `integrity mismatch for ${pin.npmPackage}@${pin.version}`;
      log(reason);
      return fail('integrity', reason);
    }

    phase = 'install';
    const addon = extractTarGzipFile(tarball, pin.addonPath);
    if (!addon) {
      const reason = `addon ${pin.addonPath} not found in tarball`;
      log(reason);
      return fail('install', reason);
    }

    throwIfAborted(signal);
    const versionRoot = dirname(layout.nativeDir);
    stagingDir = join(versionRoot, `native.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
    await ensureDir(stagingDir);
    await writeFile(nativeAddonPath(stagingDir), addon);
    const manifest: InstalledNativeManifest = {
      platform: pin.platformId,
      version: pin.version,
      sha256: sha256Hex(addon),
      napiVersion: pin.napiVersion,
    };
    await writeJsonFile(nativeManifestPath(stagingDir), manifest);

    throwIfAborted(signal);
    const backupDir = join(dirname(layout.nativeDir), `native.bak-${process.pid}`);
    await promoteNativeDirectory(stagingDir, layout.nativeDir, backupDir);
    stagingDir = null;

    const dest = nativeAddonPath(layout.nativeDir);
    log(`direct enabled: ${pin.platformId} ${pin.version} -> ${dest}`);
    return {
      ok: true,
      platformId: pin.platformId,
      version: pin.version,
      addonPath: dest,
    };
  } catch (error) {
    if (stagingDir) {
      await removeDir(stagingDir).catch(() => undefined);
    }
    const reason = error instanceof Error ? error.message : String(error);
    log(`direct enable failed: ${reason}`);
    const kind =
      isAbortError(error) || phase === 'download' || error instanceof TypeError
        ? 'download'
        : phase;
    return fail(kind, reason);
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
      platformId: installed?.platform ?? '',
      version: installed?.version ?? '',
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
  fetchImpl?: typeof fetch;
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
        console.log(`[tmex] direct enable skipped: ${result.reason}`);
        return;
      }
      console.error(`[tmex] direct enable failed: ${result.reason}`);
      process.exitCode = 1;
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
