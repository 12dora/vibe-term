import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { RELEASE_REPO_URL, releaseTag, releaseTarballName, releaseTarballUrl } from '@tmex/shared';
import { compareVersions } from './semver';

const CHECKSUMS_REQUIRED_SINCE = '1.1.4';
const TARBALL_FETCH_TIMEOUT_MS = 10 * 60 * 1000;
const SHA256SUMS_FETCH_TIMEOUT_MS = 30_000;
const SUM_LINE = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/;

/** 覆盖 GitHub 仓库根 URL；缺省为当前发行源。路径布局保持 `/releases/download/v<ver>/...`。 */
export const RELEASE_BASE_URL_ENV = 'TMEX_RELEASE_BASE_URL';

type InflightWaiter = {
  resolve: (value: DownloadedRelease) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type InflightDownload = {
  waiters: Set<InflightWaiter>;
  ac: AbortController;
  partPath: string;
  key: string;
};

const inflight = new Map<string, InflightDownload>();

export function resetReleaseDownloadForTests(): void {
  for (const entry of inflight.values()) {
    entry.ac.abort();
    const err = abortError();
    for (const waiter of entry.waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(err);
    }
    entry.waiters.clear();
  }
  inflight.clear();
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = createReadStream(path);
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      hash.update(buf);
      bytes += buf.byteLength;
    }
  } catch (err) {
    stream.destroy();
    throw err;
  }
  return { sha256: hash.digest('hex'), bytes };
}

export function resolveReleaseCacheDir(installDir?: string | null): string {
  const override = process.env.TMEX_RELEASE_CACHE_DIR?.trim();
  if (override) return override;
  if (installDir) return join(installDir, 'staging', 'release-cache');
  return join(tmpdir(), 'tmex-release-cache');
}

export function parseSha256Sums(text: string, fileName: string): string | null {
  const want = basename(fileName);
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(SUM_LINE);
    if (!match) continue;
    if (basename(match[2]) === want) return match[1].toLowerCase();
  }
  return null;
}

export function resolveReleaseBaseUrl(): string {
  const override = process.env[RELEASE_BASE_URL_ENV]?.trim().replace(/\/+$/, '');
  return override && override.length > 0 ? override : RELEASE_REPO_URL;
}

export function resolveReleaseTarballUrl(version: string): string {
  const base = resolveReleaseBaseUrl();
  if (base === RELEASE_REPO_URL) return releaseTarballUrl(version);
  return `${base}/releases/download/${releaseTag(version)}/${releaseTarballName(version)}`;
}

export function resolveReleaseSha256SumsUrl(version: string): string {
  return resolveReleaseTarballUrl(version).replace(releaseTarballName(version), 'SHA256SUMS');
}

export function releaseSha256SumsUrl(version: string): string {
  return resolveReleaseSha256SumsUrl(version);
}

export function assertReleaseSha256(
  version: string,
  sha256: string,
  sums: { hex: string | null; missing: boolean }
): void {
  if (sums.missing || !sums.hex) {
    if (compareVersions(version, CHECKSUMS_REQUIRED_SINCE) >= 0) {
      throw new Error(
        `Release ${version} requires SHA256SUMS (HTTP 200, matching digest). Refusing to continue.`
      );
    }
    throw new Error('Release SHA256SUMS is missing; tarball integrity is unverified.');
  }
  if (sha256 !== sums.hex) {
    throw new Error(`Release tarball sha256 mismatch for ${releaseTarballName(version)}.`);
  }
}

export function assertReleaseIntegrity(
  version: string,
  bytes: Uint8Array,
  sums: { hex: string | null; missing: boolean }
): void {
  assertReleaseSha256(version, sha256Hex(bytes), sums);
}

export async function fetchReleaseSha256Sums(
  version: string,
  fileName: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{ hex: string | null; missing: boolean }> {
  let response: Response;
  try {
    response = await fetchFn(resolveReleaseSha256SumsUrl(version), {
      redirect: 'follow',
      cache: 'no-store',
      signal: mergeAbortSignals(AbortSignal.timeout(SHA256SUMS_FETCH_TIMEOUT_MS), signal),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`SHA256SUMS network error: ${detail}`);
  }
  if (response.status === 404) return { hex: null, missing: true };
  if (!response.ok) {
    throw new Error(`SHA256SUMS HTTP ${response.status}`);
  }
  const hex = parseSha256Sums(await response.text(), fileName || releaseTarballName(version));
  if (!hex) {
    throw new Error(`SHA256SUMS does not list ${fileName}`);
  }
  return { hex, missing: false };
}

export type DownloadedRelease = {
  path: string;
  sha256: string;
  bytes: number;
};

export async function downloadVerifiedRelease(
  version: string,
  opts: { cacheDir: string; fetchFn?: typeof fetch; signal?: AbortSignal }
): Promise<DownloadedRelease> {
  throwIfAborted(opts.signal);
  await mkdir(opts.cacheDir, { recursive: true, mode: 0o700 });
  const dest = join(opts.cacheDir, releaseTarballName(version));
  const sidecar = `${dest}.sha256`;
  const cached = await readVerifiedCache(dest, sidecar);
  if (cached) return cached;

  const key = `${opts.cacheDir}::${version}`;
  const partPath = `${dest}.part`;
  return new Promise<DownloadedRelease>((resolve, reject) => {
    const waiter: InflightWaiter = { resolve, reject, signal: opts.signal };
    const onAbort = (): void => {
      void abortWaiter(key, waiter, reject);
    };
    waiter.onAbort = onAbort;

    let entry = inflight.get(key);
    const created = !entry;
    if (!entry) {
      entry = { waiters: new Set(), ac: new AbortController(), partPath, key };
      inflight.set(key, entry);
    }

    if (opts.signal?.aborted) {
      if (created) inflight.delete(key);
      reject(abortError());
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    entry.waiters.add(waiter);

    if (!created) return;
    const owned = entry;
    void downloadVerifiedReleaseUncached(version, { ...opts, signal: owned.ac.signal }).then(
      (result) => {
        if (inflight.get(key) === owned) inflight.delete(key);
        settleInflight(owned, { ok: true, result });
      },
      (err) => {
        if (inflight.get(key) === owned) inflight.delete(key);
        settleInflight(owned, { ok: false, err });
      }
    );
  });
}

async function abortWaiter(
  key: string,
  waiter: InflightWaiter,
  reject: (reason: unknown) => void
): Promise<void> {
  const entry = inflight.get(key);
  if (entry?.waiters.has(waiter)) {
    entry.waiters.delete(waiter);
    if (entry.waiters.size === 0) {
      entry.ac.abort();
      if (inflight.get(key) === entry) inflight.delete(key);
      await rm(entry.partPath, { force: true }).catch(() => {});
    }
  }
  reject(abortError());
}

function settleInflight(
  entry: InflightDownload,
  outcome: { ok: true; result: DownloadedRelease } | { ok: false; err: unknown }
): void {
  const waiters = [...entry.waiters];
  entry.waiters.clear();
  for (const waiter of waiters) {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    if (outcome.ok) waiter.resolve(outcome.result);
    else waiter.reject(outcome.err);
  }
}

function abortError(): Error {
  const err = new Error('UPGRADE_CANCELLED');
  err.name = 'AbortError';
  return err;
}

async function downloadVerifiedReleaseUncached(
  version: string,
  opts: { cacheDir: string; fetchFn?: typeof fetch; signal?: AbortSignal }
): Promise<DownloadedRelease> {
  await mkdir(opts.cacheDir, { recursive: true, mode: 0o700 });
  const fileName = releaseTarballName(version);
  const dest = join(opts.cacheDir, fileName);
  const sidecar = `${dest}.sha256`;
  const cached = await readVerifiedCache(dest, sidecar);
  if (cached) return cached;

  const fetchFn = opts.fetchFn ?? fetch;
  const part = `${dest}.part`;
  await rm(part, { force: true }).catch(() => {});
  let downloaded: { sha256: string; bytes: number };
  try {
    throwIfAborted(opts.signal);
    downloaded = await downloadTarballToFile(
      resolveReleaseTarballUrl(version),
      part,
      fetchFn,
      opts.signal
    );
    throwIfAborted(opts.signal);
    const sums = await fetchReleaseSha256Sums(version, fileName, fetchFn, opts.signal);
    assertReleaseSha256(version, downloaded.sha256, sums);
  } catch (err) {
    await rm(part, { force: true }).catch(() => {});
    throw err;
  }
  let renamed = false;
  try {
    throwIfAborted(opts.signal);
    await rename(part, dest);
    renamed = true;
    throwIfAborted(opts.signal);
    await writeFile(sidecar, `${downloaded.sha256}\n`, { mode: 0o600 });
  } catch (err) {
    await rm(part, { force: true }).catch(() => {});
    if (renamed) await rm(dest, { force: true }).catch(() => {});
    await rm(sidecar, { force: true, recursive: true }).catch(() => {});
    throw err;
  }
  return { path: dest, sha256: downloaded.sha256, bytes: downloaded.bytes };
}

async function readVerifiedCache(dest: string, sidecar: string): Promise<DownloadedRelease | null> {
  if (!existsSync(dest) || !existsSync(sidecar)) return null;
  try {
    const expected = readFileSync(sidecar, 'utf8').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) return null;
    const hashed = await sha256File(dest);
    if (hashed.sha256 !== expected) return null;
    return { path: dest, sha256: expected, bytes: hashed.bytes };
  } catch {
    return null;
  }
}

function mergeAbortSignals(timeout: AbortSignal, user?: AbortSignal): AbortSignal {
  if (!user) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, user]);
  if (user.aborted) return user;
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  timeout.addEventListener('abort', onAbort, { once: true });
  user.addEventListener('abort', onAbort, { once: true });
  return ac.signal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortError();
}

async function downloadTarballToFile(
  url: string,
  destPath: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal
): Promise<{ sha256: string; bytes: number }> {
  const combined = mergeAbortSignals(AbortSignal.timeout(TARBALL_FETCH_TIMEOUT_MS), signal);
  const res = await fetchFn(url, {
    cache: 'no-store',
    redirect: 'follow',
    signal: combined,
  });
  if (!res.ok) {
    throw new Error(`GitHub release tarball HTTP ${res.status}`);
  }
  throwIfAborted(signal);
  const hash = createHash('sha256');
  let bytes = 0;
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      cb(null, chunk);
    },
  });
  const ws = createWriteStream(destPath, { mode: 0o600 });
  const src = res.body
    ? Readable.fromWeb(res.body as unknown as NodeWebReadableStream)
    : Readable.from([Buffer.from(await res.arrayBuffer())]);
  const onAbort = (): void => {
    src.destroy();
    hasher.destroy();
    ws.destroy();
    void res.body?.cancel().catch(() => {});
  };
  combined.addEventListener('abort', onAbort, { once: true });
  try {
    await pipeline(src, hasher, ws);
  } catch (err) {
    ws.destroy();
    src.destroy();
    throw err;
  } finally {
    combined.removeEventListener('abort', onAbort);
  }
  return { sha256: hash.digest('hex'), bytes };
}
