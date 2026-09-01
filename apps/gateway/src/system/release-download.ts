import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { RELEASE_REPO_URL, releaseTag, releaseTarballName, releaseTarballUrl } from '@tmex/shared';
import { compareVersions } from './semver';

const CHECKSUMS_REQUIRED_SINCE = '1.1.4';
const TARBALL_FETCH_TIMEOUT_MS = 120_000;
const SUM_LINE = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/;

/** 覆盖 GitHub 仓库根 URL；缺省为当前发行源。路径布局保持 `/releases/download/v<ver>/...`。 */
export const RELEASE_BASE_URL_ENV = 'TMEX_RELEASE_BASE_URL';

const inflight = new Map<string, Promise<{ path: string; sha256: string; bytes: number }>>();

export function resetReleaseDownloadForTests(): void {
  inflight.clear();
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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

export function assertReleaseIntegrity(
  version: string,
  bytes: Uint8Array,
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
  if (sha256Hex(bytes) !== sums.hex) {
    throw new Error(`Release tarball sha256 mismatch for ${releaseTarballName(version)}.`);
  }
}

export async function fetchReleaseSha256Sums(
  version: string,
  fileName: string,
  fetchFn: typeof fetch = fetch
): Promise<{ hex: string | null; missing: boolean }> {
  let response: Response;
  try {
    response = await fetchFn(resolveReleaseSha256SumsUrl(version), {
      redirect: 'follow',
      cache: 'no-store',
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
  opts: { cacheDir: string; fetchFn?: typeof fetch }
): Promise<DownloadedRelease> {
  const key = `${opts.cacheDir}::${version}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = downloadVerifiedReleaseUncached(version, opts).finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

async function downloadVerifiedReleaseUncached(
  version: string,
  opts: { cacheDir: string; fetchFn?: typeof fetch }
): Promise<DownloadedRelease> {
  await mkdir(opts.cacheDir, { recursive: true, mode: 0o700 });
  const fileName = releaseTarballName(version);
  const dest = join(opts.cacheDir, fileName);
  const sidecar = `${dest}.sha256`;
  const cached = readVerifiedCache(dest, sidecar);
  if (cached) return cached;

  const fetchFn = opts.fetchFn ?? fetch;
  const part = `${dest}.part`;
  await rm(part, { force: true }).catch(() => {});
  let downloaded: { sha256: string; bytes: number };
  try {
    downloaded = await downloadTarballToFile(resolveReleaseTarballUrl(version), part, fetchFn);
    const sums = await fetchReleaseSha256Sums(version, fileName, fetchFn);
    const bytes = new Uint8Array(readFileSync(part));
    assertReleaseIntegrity(version, bytes, sums);
    if (downloaded.sha256 !== sha256Hex(bytes)) {
      throw new Error(`Release tarball sha256 mismatch for ${fileName}.`);
    }
  } catch (err) {
    await rm(part, { force: true }).catch(() => {});
    throw err;
  }
  await rename(part, dest);
  await writeFile(sidecar, `${downloaded.sha256}\n`, { mode: 0o600 });
  return { path: dest, sha256: downloaded.sha256, bytes: downloaded.bytes };
}

function readVerifiedCache(dest: string, sidecar: string): DownloadedRelease | null {
  if (!existsSync(dest) || !existsSync(sidecar)) return null;
  try {
    const expected = readFileSync(sidecar, 'utf8').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) return null;
    const bytes = new Uint8Array(readFileSync(dest));
    if (sha256Hex(bytes) !== expected) return null;
    return { path: dest, sha256: expected, bytes: bytes.byteLength };
  } catch {
    return null;
  }
}

async function downloadTarballToFile(
  url: string,
  destPath: string,
  fetchFn: typeof fetch
): Promise<{ sha256: string; bytes: number }> {
  const res = await fetchFn(url, {
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(TARBALL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GitHub release tarball HTTP ${res.status}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const ws = createWriteStream(destPath, { mode: 0o600 });
  try {
    const reader = res.body?.getReader();
    if (!reader) {
      const buf = new Uint8Array(await res.arrayBuffer());
      hash.update(buf);
      bytes = buf.byteLength;
      await writeAll(ws, buf);
    } else {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        hash.update(value);
        bytes += value.byteLength;
        await writeAll(ws, value);
      }
    }
    await closeWriteStream(ws);
  } catch (err) {
    await closeWriteStream(ws).catch(() => {});
    throw err;
  }
  return { sha256: hash.digest('hex'), bytes };
}

function writeAll(ws: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (err: Error) => {
      ws.off('error', onErr);
      reject(err);
    };
    ws.once('error', onErr);
    if (ws.write(chunk)) {
      ws.off('error', onErr);
      resolve();
      return;
    }
    ws.once('drain', () => {
      ws.off('error', onErr);
      resolve();
    });
  });
}

function closeWriteStream(ws: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.end((err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
