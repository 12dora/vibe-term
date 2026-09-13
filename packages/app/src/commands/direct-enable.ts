import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256Hex } from '../lib/artifacts-manifest';
import { errorMessage } from '../lib/error-message';
import { ensureDir, pathExists } from '../lib/fs-utils';
import { type InstallLayout, createInstallLayout } from '../lib/install-layout';
import { writeJsonFile } from '../lib/json-file';
import {
  type InstalledNativeManifest,
  nativeAddonPath,
  nativeManifestPath,
  readInstalledNativeManifest,
} from '../lib/native-datachannel';
import { detectCurrentNativePin, verifyNpmIntegrity } from '../lib/native-manifest';
import { extractTarGzipFile } from '../lib/native-tarball';
import type { DirectEnableFailureKind, DirectEnableResult, EnableDirectOptions } from './direct';

function logLine(log: ((message: string) => void) | undefined, message: string): void {
  (log ?? ((line: string) => console.log(`[vibeterm] ${line}`)))(message);
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

async function existingDirectResult(
  layout: InstallLayout,
  skipExisting: boolean | undefined
): Promise<DirectEnableResult | null> {
  if (!skipExisting) return null;
  const installed = await readInstalledNativeManifest(layout.nativeDir);
  if (!installed) return null;
  return {
    ok: true,
    skipped: true,
    platformId: installed.platform,
    version: installed.version,
    addonPath: nativeAddonPath(layout.nativeDir),
  };
}

function resolveDirectPin(options: EnableDirectOptions) {
  return options.pin === undefined
    ? detectCurrentNativePin({
        platform: options.platform,
        arch: options.arch,
        libc: options.libc,
      })
    : options.pin;
}

async function downloadDirectTarball(input: {
  pin: NonNullable<ReturnType<typeof resolveDirectPin>>;
  options: EnableDirectOptions;
  log: (message: string) => void;
}): Promise<{ ok: true; tarball: Uint8Array } | Extract<DirectEnableResult, { ok: false }>> {
  const { pin, options, log } = input;
  throwIfAborted(options.signal);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await withAbort(
    Promise.resolve(fetchImpl(pin.tarballUrl, { signal: options.signal })),
    options.signal
  );
  if (!response.ok) {
    const reason = `failed to download ${pin.tarballUrl}: HTTP ${response.status}`;
    log(reason);
    return fail('download', reason);
  }
  return { ok: true, tarball: await readResponseBytes(response, options.signal) };
}

async function writeDirectAddon(input: {
  pin: NonNullable<ReturnType<typeof resolveDirectPin>>;
  layout: InstallLayout;
  tarball: Uint8Array;
  signal?: AbortSignal;
  log: (message: string) => void;
}): Promise<DirectEnableResult> {
  const { pin, layout, log } = input;
  throwIfAborted(input.signal);
  if (!verifyNpmIntegrity(input.tarball, pin.integrity)) {
    const reason = `integrity mismatch for ${pin.npmPackage}@${pin.version}`;
    log(reason);
    return fail('integrity', reason);
  }
  const addon = extractTarGzipFile(input.tarball, pin.addonPath);
  if (!addon) {
    const reason = `addon ${pin.addonPath} not found in tarball`;
    log(reason);
    return fail('install', reason);
  }
  throwIfAborted(input.signal);
  const versionRoot = dirname(layout.nativeDir);
  const stagingDir = join(
    versionRoot,
    `native.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  );
  try {
    await ensureDir(stagingDir);
    await writeFile(nativeAddonPath(stagingDir), addon);
    const manifest: InstalledNativeManifest = {
      platform: pin.platformId,
      version: pin.version,
      sha256: sha256Hex(addon),
      napiVersion: pin.napiVersion,
    };
    await writeJsonFile(nativeManifestPath(stagingDir), manifest);
    throwIfAborted(input.signal);
    const backupDir = join(dirname(layout.nativeDir), `native.bak-${process.pid}`);
    await promoteNativeDirectory(stagingDir, layout.nativeDir, backupDir);
  } catch (error) {
    await removeDir(stagingDir).catch(() => undefined);
    throw error;
  }
  const dest = nativeAddonPath(layout.nativeDir);
  log(`direct enabled: ${pin.platformId} ${pin.version} -> ${dest}`);
  return { ok: true, platformId: pin.platformId, version: pin.version, addonPath: dest };
}

function enableFailureKind(
  error: unknown,
  phase: Exclude<DirectEnableFailureKind, 'unsupported'>
): Exclude<DirectEnableFailureKind, 'unsupported'> {
  if (isAbortError(error) || phase === 'download' || error instanceof TypeError) return 'download';
  return phase;
}

export async function enableDirect(options: EnableDirectOptions): Promise<DirectEnableResult> {
  const log = (message: string) => logLine(options.log, message);
  const layout = layoutForDirect(options);
  const installed = await existingDirectResult(layout, options.skipExisting);
  if (installed) return installed;

  const pin = resolveDirectPin(options);
  if (!pin) {
    const reason = `direct native addon is not supported on ${options.platform ?? process.platform}/${options.arch ?? process.arch}`;
    log(reason);
    return fail('unsupported', reason);
  }

  let phase: Exclude<DirectEnableFailureKind, 'unsupported'> = 'download';
  try {
    const downloaded = await downloadDirectTarball({ pin, options, log });
    if (!downloaded.ok) return downloaded;
    phase = 'install';
    return await writeDirectAddon({
      pin,
      layout,
      tarball: downloaded.tarball,
      signal: options.signal,
      log,
    });
  } catch (error) {
    const reason = errorMessage(error);
    log(`direct enable failed: ${reason}`);
    return fail(enableFailureKind(error, phase), reason);
  }
}
