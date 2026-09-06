import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { combineAbortSignals, releaseTarballName } from '@tmex/shared';
import { parseSha256Sums, sha256Hex } from '../../../../packages/shared/src/release/verify';
import {
  assertReleaseSha256,
  fetchVerifiedReleaseSums,
  resolveReleaseTarballUrl,
} from './release-assets';
import {
  type VerifiedReleaseSums,
  readReleaseSigSidecar,
  removeReleaseSigSidecar,
  writeReleaseSigSidecar,
} from './release-signature';

export {
  RELEASE_BASE_URL_ENV,
  assertReleaseSha256,
  fetchVerifiedReleaseSums,
  releaseSha256SumsUrl,
  resolveReleaseBaseUrl,
  resolveReleaseSha256SumsSigUrl,
  resolveReleaseSha256SumsUrl,
  resolveReleaseTarballUrl,
} from './release-assets';

export { parseSha256Sums, sha256Hex };

const TARBALL_FETCH_TIMEOUT_MS = 10 * 60 * 1000;
/** 进度上报节流：够前端看出「还在动」，又不会把每个 64 KiB 分片都变成一次回调。 */
const PROGRESS_MIN_BYTES = 512 * 1024;
const PROGRESS_MIN_MS = 500;

/** 下载进度回调；`totalBytes` 为 0 表示发行源没给 `content-length`。 */
export type DownloadProgressFn = (downloadedBytes: number, totalBytes: number) => void;

type InflightWaiter = {
  resolve: (value: DownloadedRelease) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  onProgress?: DownloadProgressFn;
};

type InflightDownload = {
  waiters: Set<InflightWaiter>;
  ac: AbortController;
  partPath: string;
  key: string;
  /** 共享下载的当前计数：后来者订阅时先补发一次，不用干等下一个分片。 */
  downloadedBytes: number;
  totalBytes: number;
};

const inflight = new Map<string, InflightDownload>();

/**
 * 已通过校验的缓存包：同一进程内复用结果，免去每个任务重算整包 sha256。身份取 size/mtimeMs/ino/
 * ctimeMs——只比 size+mtime 的话，等长内容原地覆盖再把 mtime 改回去就能冒充一个已校验的包。
 */
type VerifiedRelease = { identity: string; sha256: string };
const verified = new Map<string, VerifiedRelease>();
/** 单测用：整包重算 sha256 的次数；记忆命中时不增长。 */
let rehashCount = 0;

/** 版本级租约：持有期间该版本的缓存文件对任何清扫都免疫（远程推包可能要用它几分钟）。 */
const retained = new Map<string, number>();

/** 缓存目录里唯一合法的文件名形态：`tmex-cli-<semver>.tgz[.sha256|.part]`。 */
const RELEASE_CACHE_NAME =
  /^tmex-cli-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz(\.sha256|\.sig\.json|\.part)?$/;
const RELEASE_PART_TTL_MS = 24 * 60 * 60 * 1000;

function inflightKey(cacheDir: string, version: string): string {
  return `${cacheDir}::${version}`;
}

/** 该版本是否正在下载：清理方（本机取消 / 缓存清扫）据此避开共享中的 `.part`。 */
export function isReleaseDownloadInFlight(cacheDir: string, version: string): boolean {
  return inflight.has(inflightKey(cacheDir, version));
}

/**
 * 钉住一个版本的缓存文件直到调用返回的释放函数为止；可重入（引用计数）。远程升级任务下完包后还要
 * 推几分钟，期间别的节点开始升级会带着新版本来清扫，没有租约就会把在推的整包删掉，重试直接 ENOENT。
 */
export function retainReleaseVersion(cacheDir: string, version: string): () => void {
  const key = inflightKey(cacheDir, version);
  retained.set(key, (retained.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (retained.get(key) ?? 1) - 1;
    if (left > 0) retained.set(key, left);
    else retained.delete(key);
  };
}

export function isReleaseVersionRetained(cacheDir: string, version: string): boolean {
  return retained.has(inflightKey(cacheDir, version));
}

export type SweepReleaseCacheOpts = {
  /** 要保留的版本；空数组表示整目录清空（启动时用）。持有租约的版本不受此列表约束。 */
  keepVersions: string[];
  now?: number;
  partTtlMs?: number;
  /** 单测注入：枚举完成、逐项删除之前的挂起点，用来复现「目录快照过期」。 */
  afterEnumerateForTests?: () => Promise<void>;
};

/**
 * 清扫发行包缓存：删掉不在 keepVersions 里的整包与其 sidecar、丢了 `.tgz` 的孤儿 sidecar、
 * 超过 TTL 且不在下载中的 `.part`，以及一切不合法文件名。持有租约的版本一律跳过。
 * 全程 best-effort，任何一步失败都不抛。
 */
export async function sweepReleaseCache(
  cacheDir: string,
  opts: SweepReleaseCacheOpts
): Promise<{ removed: string[] }> {
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return { removed: [] };
  }
  if (opts.afterEnumerateForTests) await opts.afterEnumerateForTests();
  const ctx = {
    present: new Set(names),
    keep: new Set(opts.keepVersions),
    now: opts.now ?? Date.now(),
    partTtlMs: opts.partTtlMs ?? RELEASE_PART_TTL_MS,
  };
  const removed: string[] = [];
  for (const name of names) {
    if (!(await shouldSweepCacheEntry(cacheDir, name, ctx))) continue;
    const path = join(cacheDir, name);
    const ok = await rm(path, { force: true, recursive: true }).then(
      () => true,
      () => false
    );
    if (!ok) continue;
    verified.delete(path);
    removed.push(name);
  }
  return { removed };
}

type SweepCtx = { present: Set<string>; keep: Set<string>; now: number; partTtlMs: number };

async function shouldSweepCacheEntry(
  cacheDir: string,
  name: string,
  ctx: SweepCtx
): Promise<boolean> {
  const matched = RELEASE_CACHE_NAME.exec(name);
  if (!matched) return true;
  const version = matched[1] as string;
  if (isReleaseVersionRetained(cacheDir, version)) return false;
  const suffix = matched[2];
  if (!suffix) {
    if (!ctx.keep.has(version)) return true;
    // 没有 sidecar 的整包是崩溃残留；下载刚 rename 完还没写 sidecar 时不能误删。
    if (ctx.present.has(`${name}.sha256`) || isReleaseDownloadInFlight(cacheDir, version)) {
      return false;
    }
    // 枚举与删除之间下载可能刚写完 sidecar 并退出在途表：删之前再看一眼盘上。
    return !existsSync(join(cacheDir, `${name}.sha256`));
  }
  if (suffix === '.sha256' || suffix === '.sig.json') {
    if (!ctx.keep.has(version)) return true;
    const tarball = name.slice(0, -suffix.length);
    if (ctx.present.has(tarball)) return false;
    return !existsSync(join(cacheDir, tarball));
  }
  if (isReleaseDownloadInFlight(cacheDir, version)) return false;
  return await partExpired(join(cacheDir, name), ctx.now, ctx.partTtlMs);
}

async function partExpired(path: string, now: number, ttlMs: number): Promise<boolean> {
  try {
    const info = await stat(path);
    // 文件系统的 mtime 可能比 Date.now() 略新（亚毫秒精度），夹到 0 才能让 ttl=0 真正清空。
    return Math.max(0, now - info.mtimeMs) >= ttlMs;
  } catch {
    return false;
  }
}

export function readReleaseRehashCountForTests(): number {
  return rehashCount;
}

export function resetReleaseDownloadForTests(): void {
  verified.clear();
  retained.clear();
  rehashCount = 0;
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

export type DownloadedRelease = {
  path: string;
  sha256: string;
  bytes: number;
  /** 已验签的 SHA256SUMS 原文；推包给别的节点时原样带过去。 */
  sums: string;
  /** 签名行；老版本（`RELEASE_SIGNING_SINCE` 之前）允许为 null，推包路径会拒绝。 */
  sig: string | null;
  keyId: string | null;
};

export async function downloadVerifiedRelease(
  version: string,
  opts: {
    cacheDir: string;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    onProgress?: DownloadProgressFn;
  }
): Promise<DownloadedRelease> {
  throwIfAborted(opts.signal);
  await mkdir(opts.cacheDir, { recursive: true, mode: 0o700 });
  const dest = join(opts.cacheDir, releaseTarballName(version));
  const sidecar = `${dest}.sha256`;
  const cached = await readVerifiedCache(dest, sidecar, version);
  if (cached) return cached;

  const key = `${opts.cacheDir}::${version}`;
  const partPath = `${dest}.part`;
  return new Promise<DownloadedRelease>((resolve, reject) => {
    const waiter: InflightWaiter = {
      resolve,
      reject,
      signal: opts.signal,
      onProgress: opts.onProgress,
    };
    const onAbort = (): void => {
      void abortWaiter(key, waiter, reject);
    };
    waiter.onAbort = onAbort;

    let entry = inflight.get(key);
    const created = !entry;
    if (!entry) {
      entry = {
        waiters: new Set(),
        ac: new AbortController(),
        partPath,
        key,
        downloadedBytes: 0,
        totalBytes: 0,
      };
      inflight.set(key, entry);
    }

    if (opts.signal?.aborted) {
      if (created) inflight.delete(key);
      reject(abortError());
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    entry.waiters.add(waiter);

    if (!created) {
      if (entry.downloadedBytes > 0 || entry.totalBytes > 0) {
        emitProgress(waiter, entry.downloadedBytes, entry.totalBytes);
      }
      return;
    }
    const owned = entry;
    void downloadVerifiedReleaseUncached(version, {
      ...opts,
      signal: owned.ac.signal,
      onProgress: (downloadedBytes, totalBytes) =>
        publishProgress(owned, downloadedBytes, totalBytes),
    }).then(
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

function publishProgress(
  entry: InflightDownload,
  downloadedBytes: number,
  totalBytes: number
): void {
  entry.downloadedBytes = downloadedBytes;
  entry.totalBytes = totalBytes;
  for (const waiter of entry.waiters) emitProgress(waiter, downloadedBytes, totalBytes);
}

function emitProgress(waiter: InflightWaiter, downloadedBytes: number, totalBytes: number): void {
  if (!waiter.onProgress) return;
  try {
    waiter.onProgress(downloadedBytes, totalBytes);
  } catch {
    // 订阅方自己的问题不该打断下载
  }
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
  opts: {
    cacheDir: string;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    onProgress?: DownloadProgressFn;
  }
): Promise<DownloadedRelease> {
  await mkdir(opts.cacheDir, { recursive: true, mode: 0o700 });
  const fileName = releaseTarballName(version);
  const dest = join(opts.cacheDir, fileName);
  const sidecar = `${dest}.sha256`;
  const cached = await readVerifiedCache(dest, sidecar, version);
  if (cached) return cached;

  const fetchFn = opts.fetchFn ?? fetch;
  const part = `${dest}.part`;
  await rm(part, { force: true }).catch(() => {});
  let downloaded: { sha256: string; bytes: number };
  let verified: VerifiedReleaseSums;
  try {
    throwIfAborted(opts.signal);
    downloaded = await downloadTarballToFile(
      resolveReleaseTarballUrl(version),
      part,
      fetchFn,
      opts.signal,
      opts.onProgress
    );
    throwIfAborted(opts.signal);
    verified = await fetchVerifiedReleaseSums(version, fetchFn, opts.signal);
    assertReleaseSha256(version, downloaded.sha256, { hex: verified.sha256, missing: false });
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
    // 签名 sidecar 先落盘：`.sha256` 才是「这个缓存包可用」的标记，顺序反了会漏签名。
    await writeReleaseSigSidecar(dest, {
      version,
      sha256: downloaded.sha256,
      keyId: verified.keyId,
      sums: verified.sums,
      sig: verified.sig,
    });
    await writeFile(sidecar, `${downloaded.sha256}\n`, { mode: 0o600 });
  } catch (err) {
    await rm(part, { force: true }).catch(() => {});
    if (renamed) await rm(dest, { force: true }).catch(() => {});
    await rm(sidecar, { force: true, recursive: true }).catch(() => {});
    await removeReleaseSigSidecar(dest);
    throw err;
  }
  return {
    path: dest,
    sha256: downloaded.sha256,
    bytes: downloaded.bytes,
    sums: verified.sums,
    sig: verified.sig,
    keyId: verified.keyId,
  };
}

async function readVerifiedCache(
  dest: string,
  sidecar: string,
  version: string
): Promise<DownloadedRelease | null> {
  if (!existsSync(dest) || !existsSync(sidecar)) return null;
  try {
    const expected = readFileSync(sidecar, 'utf8').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) return null;
    // 缓存包也得过签名这一关：sidecar 缺失 / 被改过就当没缓存，重下一次比放行一个不可信的包便宜。
    const signed = readReleaseSigSidecar(dest, version, expected);
    if (!signed) return null;
    const info = statSync(dest);
    const identity = fileIdentity(info);
    const memo = verified.get(dest);
    const sums = { sums: signed.sums, sig: signed.sig, keyId: signed.keyId };
    if (memo && memo.sha256 === expected && memo.identity === identity) {
      return { path: dest, sha256: expected, bytes: info.size, ...sums };
    }
    rehashCount += 1;
    const hashed = await sha256File(dest);
    if (hashed.sha256 !== expected) {
      verified.delete(dest);
      return null;
    }
    verified.set(dest, { identity, sha256: expected });
    return { path: dest, sha256: expected, bytes: hashed.bytes, ...sums };
  } catch {
    return null;
  }
}

function fileIdentity(info: Stats): string {
  return `${info.size}:${info.mtimeMs}:${info.ino}:${info.ctimeMs}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortError();
}

async function downloadTarballToFile(
  url: string,
  destPath: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
  onProgress?: DownloadProgressFn
): Promise<{ sha256: string; bytes: number }> {
  const timeout = AbortSignal.timeout(TARBALL_FETCH_TIMEOUT_MS);
  const combined = combineAbortSignals(timeout, signal) ?? timeout;
  const res = await fetchFn(url, {
    cache: 'no-store',
    redirect: 'follow',
    signal: combined,
  });
  if (!res.ok) {
    throw new Error(`GitHub release tarball HTTP ${res.status}`);
  }
  throwIfAborted(signal);
  const total = parseContentLength(res.headers.get('content-length'));
  const hash = createHash('sha256');
  let bytes = 0;
  let reportedBytes = 0;
  let reportedAt = 0;
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      const now = Date.now();
      if (
        onProgress &&
        (bytes - reportedBytes >= PROGRESS_MIN_BYTES || now - reportedAt >= PROGRESS_MIN_MS)
      ) {
        reportedBytes = bytes;
        reportedAt = now;
        onProgress(bytes, total);
      }
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
  if (onProgress && bytes !== reportedBytes) onProgress(bytes, total);
  return { sha256: hash.digest('hex'), bytes };
}

/** 缺失 / 不合法的 `content-length` 一律按 0（总量未知）处理，不去猜。 */
function parseContentLength(raw: string | null): number {
  if (!raw) return 0;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
