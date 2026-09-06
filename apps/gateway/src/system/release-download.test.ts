import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_REPO_URL, releaseTarballName, releaseTarballUrl } from '@vibeterm/shared';
import {
  TEST_SIGNING_KEY,
  restoreSigningKeys,
  signSums,
  signedSumsFor,
  sumsTextFor,
  useTestSigningKeys,
} from '../test-support/release-signing';
import {
  downloadVerifiedRelease,
  isReleaseDownloadInFlight,
  isReleaseVersionRetained,
  readReleaseRehashCountForTests,
  resetReleaseDownloadForTests,
  resolveReleaseSha256SumsUrl,
  resolveReleaseTarballUrl,
  retainReleaseVersion,
  sweepReleaseCache,
} from './release-download';

beforeAll(() => {
  useTestSigningKeys();
});

afterAll(() => {
  restoreSigningKeys();
});

/** SHA256SUMS 与其签名一起造：`.sig` 必须先判，否则会把 sums 当签名返回。 */
function sumsAsset(url: string, version: string, hex: string): Response | null {
  if (!url.includes('SHA256SUMS')) return null;
  const sums = sumsTextFor(version, hex);
  return new Response(url.endsWith('.sig') ? `${signSums(sums)}\n` : sums, { status: 200 });
}

const originalFetch = globalThis.fetch;
const originalBase = process.env.VIBETERM_RELEASE_BASE_URL;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.VIBETERM_RELEASE_BASE_URL;
  else process.env.VIBETERM_RELEASE_BASE_URL = originalBase;
  resetReleaseDownloadForTests();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stubReleaseFetch(
  tarball: Uint8Array,
  version: string
): { urls: string[]; tarballHits: number } {
  const urls: string[] = [];
  const hex = sha256Hex(tarball);
  let tarballHits = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const sums = sumsAsset(url, version, hex);
    if (sums) return sums;
    tarballHits += 1;
    return new Response(Buffer.from(tarball), { status: 200 });
  }) as typeof fetch;
  return {
    urls,
    get tarballHits() {
      return tarballHits;
    },
  };
}

describe('resolveReleaseTarballUrl', () => {
  test('defaults to the GitHub release asset URL', () => {
    delete process.env.VIBETERM_RELEASE_BASE_URL;
    expect(resolveReleaseTarballUrl('1.2.3')).toBe(releaseTarballUrl('1.2.3'));
    expect(resolveReleaseSha256SumsUrl('1.2.3')).toContain(
      `${RELEASE_REPO_URL}/releases/download/v1.2.3/SHA256SUMS`
    );
  });

  test('VIBETERM_RELEASE_BASE_URL overrides the GitHub host while keeping the path layout', () => {
    process.env.VIBETERM_RELEASE_BASE_URL = 'http://127.0.0.1:19991';
    expect(resolveReleaseTarballUrl('1.2.3')).toBe(
      'http://127.0.0.1:19991/releases/download/v1.2.3/tmex-cli-1.2.3.tgz'
    );
  });
});

describe('downloadVerifiedRelease', () => {
  test('downloads, verifies sha256, and writes the on-disk cache', async () => {
    const version = '9.9.9';
    const tarball = new Uint8Array([1, 2, 3, 4, 5]);
    stubReleaseFetch(tarball, version);
    const cacheDir = tempDir('tmex-rel-cache-');
    const result = await downloadVerifiedRelease(version, { cacheDir });
    expect(result.sha256).toBe(sha256Hex(tarball));
    expect(result.bytes).toBe(tarball.byteLength);
    expect(existsSync(join(cacheDir, releaseTarballName(version)))).toBe(true);
    expect(
      readFileSync(join(cacheDir, `${releaseTarballName(version)}.sha256`), 'utf8').trim()
    ).toBe(result.sha256);
  });

  test('reuses a verified cache and does not re-fetch the tarball', async () => {
    const version = '9.9.9';
    const tarball = new Uint8Array([9, 8, 7]);
    const stub = stubReleaseFetch(tarball, version);
    const cacheDir = tempDir('tmex-rel-cache-');
    await downloadVerifiedRelease(version, { cacheDir });
    const firstHits = stub.tarballHits;
    const again = await downloadVerifiedRelease(version, { cacheDir });
    expect(again.sha256).toBe(sha256Hex(tarball));
    expect(stub.tarballHits).toBe(firstHits);
  });

  test('concurrent callers for the same version share one download', async () => {
    const version = '3.2.1';
    const tarball = new Uint8Array(32).fill(4);
    const stub = stubReleaseFetch(tarball, version);
    const cacheDir = tempDir('tmex-rel-cache-');
    const [a, b] = await Promise.all([
      downloadVerifiedRelease(version, { cacheDir }),
      downloadVerifiedRelease(version, { cacheDir }),
    ]);
    expect(a.path).toBe(b.path);
    expect(a.sha256).toBe(b.sha256);
    expect(stub.tarballHits).toBe(1);
  });

  test('rejects a sha256 mismatch and does not leave a cache file', async () => {
    const version = '1.1.4';
    const tarball = new Uint8Array([1, 2, 3]);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const sums = sumsAsset(url, version, '0'.repeat(64));
      if (sums) return sums;
      return new Response(Buffer.from(tarball), { status: 200 });
    }) as typeof fetch;
    const cacheDir = tempDir('tmex-rel-cache-');
    await expect(downloadVerifiedRelease(version, { cacheDir })).rejects.toThrow(
      /sha256 mismatch/i
    );
    expect(existsSync(join(cacheDir, releaseTarballName(version)))).toBe(false);
  });

  test('ignores a cache file whose recorded sha256 no longer matches', async () => {
    const version = '8.8.8';
    const good = new Uint8Array([1, 1, 1]);
    const cacheDir = tempDir('tmex-rel-cache-');
    writeFileSync(join(cacheDir, releaseTarballName(version)), Buffer.from([9, 9, 9]));
    writeFileSync(join(cacheDir, `${releaseTarballName(version)}.sha256`), `${'a'.repeat(64)}\n`);
    stubReleaseFetch(good, version);
    const result = await downloadVerifiedRelease(version, { cacheDir });
    expect(result.sha256).toBe(sha256Hex(good));
    expect(readFileSync(join(cacheDir, releaseTarballName(version)))).toEqual(Buffer.from(good));
  });

  test('a non-writable cache dir fails the download instead of emitting unhandled error', async () => {
    const version = '7.7.7';
    const tarball = new Uint8Array([3, 2, 1]);
    stubReleaseFetch(tarball, version);
    const cacheDir = tempDir('tmex-rel-nowrite-');
    chmodSync(cacheDir, 0o555);
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    const proc = process as unknown as {
      on(event: string, listener: (err: unknown) => void): void;
      off(event: string, listener: (err: unknown) => void): void;
    };
    proc.on('uncaughtException', onUnhandled);
    proc.on('unhandledRejection', onUnhandled);
    try {
      await expect(downloadVerifiedRelease(version, { cacheDir })).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      proc.off('uncaughtException', onUnhandled);
      proc.off('unhandledRejection', onUnhandled);
      chmodSync(cacheDir, 0o700);
    }
  });

  test('aborting an in-flight download removes the .part and does not leave a tarball without sidecar', async () => {
    const version = '5.5.5';
    const ac = new AbortController();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const sums = sumsAsset(url, version, 'ab'.repeat(32));
      if (sums) return sums;
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'));
            return;
          }
          controller.enqueue(new Uint8Array(16 * 1024).fill(1));
          await new Promise<void>((resolve) => {
            if (!signal) {
              resolve();
              return;
            }
            const timer = setTimeout(resolve, 15);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          });
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const cacheDir = tempDir('tmex-rel-abort-');
    const pending = downloadVerifiedRelease(version, { cacheDir, signal: ac.signal });
    const part = join(cacheDir, `${releaseTarballName(version)}.part`);
    const dest = join(cacheDir, releaseTarballName(version));
    for (let i = 0; i < 50; i += 1) {
      if (existsSync(part) || existsSync(dest)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    ac.abort();
    await expect(pending).rejects.toThrow();
    expect(existsSync(part)).toBe(false);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.sha256`)).toBe(false);
  }, 5_000);

  function stubSlowTarballFetch(tarball: Uint8Array, version: string): void {
    const hex = sha256Hex(tarball);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const sums = sumsAsset(url, version, hex);
      if (sums) return sums;
      const signal = init?.signal;
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'));
            return;
          }
          if (offset >= tarball.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(tarball.subarray(offset, offset + 1));
          offset += 1;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 15);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          });
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
  }

  test('aborting the first of two shared callers does not fail the second', async () => {
    const version = '4.4.4';
    const tarball = new Uint8Array([9, 8, 7, 6, 5]);
    stubSlowTarballFetch(tarball, version);
    const cacheDir = tempDir('tmex-rel-share-first-');
    const first = new AbortController();
    const second = new AbortController();
    const pendingFirst = downloadVerifiedRelease(version, { cacheDir, signal: first.signal });
    const pendingSecond = downloadVerifiedRelease(version, { cacheDir, signal: second.signal });
    const part = join(cacheDir, `${releaseTarballName(version)}.part`);
    for (let i = 0; i < 50 && !existsSync(part); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    first.abort();
    await expect(pendingFirst).rejects.toThrow();
    const result = await pendingSecond;
    expect(result.sha256).toBe(sha256Hex(tarball));
    expect(existsSync(join(cacheDir, releaseTarballName(version)))).toBe(true);
    expect(existsSync(part)).toBe(false);
  }, 8_000);

  test('aborting every shared caller aborts the fetch and removes the .part', async () => {
    const version = '4.4.5';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const sums = sumsAsset(url, version, 'ab'.repeat(32));
      if (sums) return sums;
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'));
            return;
          }
          controller.enqueue(new Uint8Array(16 * 1024).fill(3));
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 15);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          });
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const cacheDir = tempDir('tmex-rel-share-all-');
    const first = new AbortController();
    const second = new AbortController();
    const pendingFirst = downloadVerifiedRelease(version, { cacheDir, signal: first.signal });
    const pendingSecond = downloadVerifiedRelease(version, { cacheDir, signal: second.signal });
    const part = join(cacheDir, `${releaseTarballName(version)}.part`);
    for (let i = 0; i < 50 && !existsSync(part); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(part)).toBe(true);
    const firstDone = pendingFirst.then(
      () => {
        throw new Error('first caller should have aborted');
      },
      (err: unknown) => err
    );
    const secondDone = pendingSecond.then(
      () => {
        throw new Error('second caller should have aborted');
      },
      (err: unknown) => err
    );
    first.abort();
    second.abort();
    expect(await firstDone).toBeInstanceOf(Error);
    expect(await secondDone).toBeInstanceOf(Error);
    expect(existsSync(part)).toBe(false);
    expect(existsSync(join(cacheDir, releaseTarballName(version)))).toBe(false);
  }, 8_000);

  test('sidecar write failure cleans part/final/sidecar and rejects', async () => {
    const version = '6.6.6';
    const tarball = new Uint8Array([4, 5, 6]);
    stubReleaseFetch(tarball, version);
    const cacheDir = tempDir('tmex-rel-sidecar-');
    mkdirSync(join(cacheDir, `${releaseTarballName(version)}.sha256`));
    await expect(downloadVerifiedRelease(version, { cacheDir })).rejects.toThrow();
    expect(existsSync(join(cacheDir, releaseTarballName(version)))).toBe(false);
    expect(existsSync(join(cacheDir, `${releaseTarballName(version)}.part`))).toBe(false);
  });
});

/**
 * 分片下发的假发行源：`pauseAfter` 之后卡住，直到调用 `release()`，
 * 用来在下载在途时插入新的订阅者。
 */
function stubStreamedRelease(
  version: string,
  tarball: Uint8Array,
  opts: { chunkSize: number; contentLength?: number | null; pauseAfter?: number }
): { release: () => void } {
  const hex = sha256Hex(tarball);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const sums = sumsAsset(url, version, hex);
    if (sums) return sums;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let off = 0; off < tarball.byteLength; off += opts.chunkSize) {
          if (opts.pauseAfter != null && sent === opts.pauseAfter) await gate;
          controller.enqueue(tarball.subarray(off, off + opts.chunkSize));
          sent += 1;
        }
        controller.close();
      },
    });
    const headers = new Headers();
    const length = opts.contentLength === undefined ? tarball.byteLength : opts.contentLength;
    if (length !== null) headers.set('content-length', String(length));
    return new Response(body, { status: 200, headers });
  }) as typeof fetch;
  return { release };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error('condition never became true');
}

describe('downloadVerifiedRelease progress', () => {
  test('content-length 作为总量，分片上报按节流合并，收尾补一次完整计数', async () => {
    const version = '7.1.0';
    const chunkSize = 64 * 1024;
    const chunks = 100;
    const tarball = new Uint8Array(chunkSize * chunks).fill(7);
    stubStreamedRelease(version, tarball, { chunkSize });
    const cacheDir = tempDir('tmex-rel-progress-');
    const seen: Array<[number, number]> = [];

    const result = await downloadVerifiedRelease(version, {
      cacheDir,
      onProgress: (downloaded, total) => seen.push([downloaded, total]),
    });

    expect(result.bytes).toBe(tarball.byteLength);
    expect(seen.length).toBeGreaterThan(1);
    // 节流：100 个 64 KiB 分片按 512 KiB 门槛合并到十几次回调，不是一片一报
    expect(seen.length).toBeLessThanOrEqual(30);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]?.[0] ?? 0).toBeGreaterThan(seen[i - 1]?.[0] ?? 0);
    }
    expect(seen.every(([, total]) => total === tarball.byteLength)).toBe(true);
    expect(seen.at(-1)).toEqual([tarball.byteLength, tarball.byteLength]);
  }, 8_000);

  test('发行源没给 content-length：总量按 0 上报，不去猜', async () => {
    const version = '7.2.0';
    const tarball = new Uint8Array(4096).fill(3);
    stubStreamedRelease(version, tarball, { chunkSize: 1024, contentLength: null });
    const cacheDir = tempDir('tmex-rel-progress-nolen-');
    const seen: Array<[number, number]> = [];

    await downloadVerifiedRelease(version, {
      cacheDir,
      onProgress: (downloaded, total) => seen.push([downloaded, total]),
    });

    expect(seen.at(-1)).toEqual([tarball.byteLength, 0]);
    expect(seen.every(([, total]) => total === 0)).toBe(true);
  }, 8_000);

  test('后来者立刻拿到当前计数，并接着收后续上报', async () => {
    const version = '7.3.0';
    const chunkSize = 1024 * 1024;
    const tarball = new Uint8Array(chunkSize * 4).fill(5);
    const streamed = stubStreamedRelease(version, tarball, { chunkSize, pauseAfter: 1 });
    const cacheDir = tempDir('tmex-rel-progress-join-');
    const first: Array<[number, number]> = [];
    const late: Array<[number, number]> = [];

    const pendingFirst = downloadVerifiedRelease(version, {
      cacheDir,
      onProgress: (downloaded, total) => first.push([downloaded, total]),
    });
    await waitFor(() => first.length > 0);

    // 流卡在第一个分片后：这期间的任何回调都只可能是订阅时补发的那一次
    const atJoin = first.at(-1) as [number, number];
    const pendingLate = downloadVerifiedRelease(version, {
      cacheDir,
      onProgress: (downloaded, total) => late.push([downloaded, total]),
    });
    await waitFor(() => late.length > 0);
    expect(late).toEqual([atJoin]);

    streamed.release();
    const [a, b] = await Promise.all([pendingFirst, pendingLate]);
    expect(a.bytes).toBe(tarball.byteLength);
    expect(b.path).toBe(a.path);
    expect(late.at(-1)).toEqual([tarball.byteLength, tarball.byteLength]);
    expect(late.length).toBeGreaterThan(1);
  }, 8_000);

  test('下载结束后不再回调订阅者', async () => {
    const version = '7.4.0';
    const tarball = new Uint8Array(2048).fill(9);
    stubStreamedRelease(version, tarball, { chunkSize: 512 });
    const cacheDir = tempDir('tmex-rel-progress-settle-');
    const seen: Array<[number, number]> = [];

    await downloadVerifiedRelease(version, {
      cacheDir,
      onProgress: (downloaded, total) => seen.push([downloaded, total]),
    });
    const settled = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.length).toBe(settled);
  }, 8_000);
});

const HOUR_MS = 60 * 60 * 1000;

function writeCacheEntry(dir: string, name: string, body = 'x'): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function ageFile(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
}

describe('sweepReleaseCache', () => {
  test('保留 keepVersions，其余整包与 sidecar 一起清掉', async () => {
    const dir = tempDir('tmex-rel-sweep-');
    writeCacheEntry(dir, 'tmex-cli-1.1.30.tgz');
    writeCacheEntry(dir, 'tmex-cli-1.1.30.tgz.sha256', `${'ab'.repeat(32)}\n`);
    writeCacheEntry(dir, 'tmex-cli-1.1.34.tgz');
    writeCacheEntry(dir, 'tmex-cli-1.1.34.tgz.sha256', `${'cd'.repeat(32)}\n`);

    const { removed } = await sweepReleaseCache(dir, { keepVersions: ['1.1.34'] });

    expect(removed.sort()).toEqual(['tmex-cli-1.1.30.tgz', 'tmex-cli-1.1.30.tgz.sha256']);
    expect(existsSync(join(dir, 'tmex-cli-1.1.34.tgz'))).toBe(true);
    expect(existsSync(join(dir, 'tmex-cli-1.1.34.tgz.sha256'))).toBe(true);
  });

  test('keepVersions 为空时整目录清空', async () => {
    const dir = tempDir('tmex-rel-sweep-all-');
    writeCacheEntry(dir, 'tmex-cli-1.1.34.tgz');
    writeCacheEntry(dir, 'tmex-cli-1.1.34.tgz.sha256', `${'cd'.repeat(32)}\n`);
    const part = writeCacheEntry(dir, 'tmex-cli-1.1.34.tgz.part');

    await sweepReleaseCache(dir, { keepVersions: [], partTtlMs: 0 });

    expect(existsSync(join(dir, 'tmex-cli-1.1.34.tgz'))).toBe(false);
    expect(existsSync(join(dir, 'tmex-cli-1.1.34.tgz.sha256'))).toBe(false);
    expect(existsSync(part)).toBe(false);
  });

  test('丢了整包的孤儿 sidecar 被清掉，保留版本的整包缺 sidecar 也清', async () => {
    const dir = tempDir('tmex-rel-sweep-orphan-');
    writeCacheEntry(dir, 'tmex-cli-1.1.34.tgz.sha256', `${'cd'.repeat(32)}\n`);
    writeCacheEntry(dir, 'tmex-cli-1.1.35.tgz');

    const { removed } = await sweepReleaseCache(dir, { keepVersions: ['1.1.34', '1.1.35'] });

    expect(removed.sort()).toEqual(['tmex-cli-1.1.34.tgz.sha256', 'tmex-cli-1.1.35.tgz']);
  });

  test('保留期内的 .part 与下载中的 .part 都不动，过期孤儿 .part 才清', async () => {
    const dir = tempDir('tmex-rel-sweep-part-');
    const fresh = writeCacheEntry(dir, 'tmex-cli-1.1.34.tgz.part');
    const stale = writeCacheEntry(dir, 'tmex-cli-1.1.30.tgz.part');
    ageFile(stale, 48 * HOUR_MS);

    const { removed } = await sweepReleaseCache(dir, { keepVersions: [] });

    expect(removed).toEqual(['tmex-cli-1.1.30.tgz.part']);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  test('下载中的 .part 即使过了保留期也不清', async () => {
    const version = '8.1.0';
    const tarball = new Uint8Array(1024 * 1024).fill(4);
    const streamed = stubStreamedRelease(version, tarball, {
      chunkSize: 256 * 1024,
      pauseAfter: 1,
    });
    const cacheDir = tempDir('tmex-rel-sweep-inflight-');
    const pending = downloadVerifiedRelease(version, { cacheDir });
    await waitFor(() => existsSync(join(cacheDir, `${releaseTarballName(version)}.part`)));
    expect(isReleaseDownloadInFlight(cacheDir, version)).toBe(true);

    const { removed } = await sweepReleaseCache(cacheDir, {
      keepVersions: [],
      partTtlMs: 0,
    });

    expect(removed).toEqual([]);
    expect(existsSync(join(cacheDir, `${releaseTarballName(version)}.part`))).toBe(true);
    streamed.release();
    await pending;
    expect(isReleaseDownloadInFlight(cacheDir, version)).toBe(false);
  }, 8_000);

  test('持有租约的版本不受 keepVersions 约束：整目录清空也留着它', async () => {
    const dir = tempDir('tmex-rel-sweep-lease-');
    writeCacheEntry(dir, 'tmex-cli-1.1.34.tgz');
    writeCacheEntry(dir, 'tmex-cli-1.1.34.tgz.sha256', `${'cd'.repeat(32)}\n`);
    writeCacheEntry(dir, 'tmex-cli-1.1.30.tgz');
    const lease = retainReleaseVersion(dir, '1.1.34');

    // 另一个节点带着新版本来清扫：租约版本不在 keepVersions 里也不能删
    const { removed } = await sweepReleaseCache(dir, { keepVersions: ['1.1.40'] });
    expect(removed).toEqual(['tmex-cli-1.1.30.tgz']);
    expect(existsSync(join(dir, 'tmex-cli-1.1.34.tgz'))).toBe(true);
    expect(existsSync(join(dir, 'tmex-cli-1.1.34.tgz.sha256'))).toBe(true);

    lease();
    expect(isReleaseVersionRetained(dir, '1.1.34')).toBe(false);
    const after = await sweepReleaseCache(dir, { keepVersions: [] });
    expect(after.removed.sort()).toEqual(['tmex-cli-1.1.34.tgz', 'tmex-cli-1.1.34.tgz.sha256']);
  });

  test('租约按引用计数：两个任务钉同一版本，释放一个还留着，都释放才清', async () => {
    const dir = tempDir('tmex-rel-sweep-lease-rc-');
    writeCacheEntry(dir, 'tmex-cli-1.1.34.tgz');
    writeCacheEntry(dir, 'tmex-cli-1.1.34.tgz.sha256', `${'cd'.repeat(32)}\n`);
    const first = retainReleaseVersion(dir, '1.1.34');
    const second = retainReleaseVersion(dir, '1.1.34');

    first();
    // 幂等：重复释放不能把别人的引用一起扣掉
    first();
    expect(isReleaseVersionRetained(dir, '1.1.34')).toBe(true);
    expect((await sweepReleaseCache(dir, { keepVersions: [] })).removed).toEqual([]);

    second();
    expect(isReleaseVersionRetained(dir, '1.1.34')).toBe(false);
    expect((await sweepReleaseCache(dir, { keepVersions: [] })).removed).toHaveLength(2);
  });

  test('枚举快照过期：删之前 sidecar 已经落盘，整包与 sidecar 都不动', async () => {
    const dir = tempDir('tmex-rel-sweep-race-');
    const name = 'tmex-cli-1.1.34.tgz';
    writeCacheEntry(dir, name);

    // 枚举时只看到缺 sidecar 的整包；判定之前下载刚写完 sidecar 并退出在途表
    const { removed } = await sweepReleaseCache(dir, {
      keepVersions: ['1.1.34'],
      afterEnumerateForTests: async () => {
        writeCacheEntry(dir, `${name}.sha256`, `${'cd'.repeat(32)}\n`);
      },
    });

    expect(removed).toEqual([]);
    expect(existsSync(join(dir, name))).toBe(true);
    expect(existsSync(join(dir, `${name}.sha256`))).toBe(true);
  });

  test('枚举快照过期：孤儿 sidecar 在删之前等到了整包，也不动', async () => {
    const dir = tempDir('tmex-rel-sweep-race-side-');
    const name = 'tmex-cli-1.1.34.tgz';
    writeCacheEntry(dir, `${name}.sha256`, `${'cd'.repeat(32)}\n`);

    const { removed } = await sweepReleaseCache(dir, {
      keepVersions: ['1.1.34'],
      afterEnumerateForTests: async () => {
        writeCacheEntry(dir, name);
      },
    });

    expect(removed).toEqual([]);
    expect(existsSync(join(dir, name))).toBe(true);
    expect(existsSync(join(dir, `${name}.sha256`))).toBe(true);
  });

  test('不认识的文件被清掉，目录不存在时是 no-op', async () => {
    const dir = tempDir('tmex-rel-sweep-junk-');
    writeCacheEntry(dir, 'junk.txt');
    writeCacheEntry(dir, 'tmex-cli-notaversion.tgz');
    mkdirSync(join(dir, 'leftover-dir'), { recursive: true });

    const { removed } = await sweepReleaseCache(dir, { keepVersions: ['1.1.34'] });
    expect(removed.sort()).toEqual(['junk.txt', 'leftover-dir', 'tmex-cli-notaversion.tgz']);

    await expect(
      sweepReleaseCache(join(dir, 'does-not-exist'), { keepVersions: [] })
    ).resolves.toEqual({ removed: [] });
  });
});

describe('已校验缓存的复用', () => {
  const FIXED_MTIME = new Date(1_700_000_000_000);

  function seedVerifiedCache(version: string, tarball: Uint8Array): { dest: string; hex: string } {
    const hex = sha256Hex(tarball);
    const cacheDir = tempDir('tmex-rel-verify-memo-');
    const dest = join(cacheDir, releaseTarballName(version));
    writeFileSync(dest, Buffer.from(tarball));
    writeFileSync(`${dest}.sha256`, `${hex}\n`);
    const signed = signedSumsFor(version, hex);
    writeFileSync(
      `${dest}.sig.json`,
      `${JSON.stringify({ version, sha256: hex, keyId: TEST_SIGNING_KEY.id, ...signed })}\n`
    );
    utimesSync(dest, FIXED_MTIME, FIXED_MTIME);
    globalThis.fetch = (async (_input: RequestInfo | URL): Promise<Response> => {
      throw new Error('should not download');
    }) as typeof fetch;
    return { dest, hex };
  }

  test('文件没被动过：第二次取用命中记忆，不重算也不下载', async () => {
    const version = '8.2.0';
    const tarball = new Uint8Array(4096).fill(6);
    const { dest, hex } = seedVerifiedCache(version, tarball);
    const cacheDir = join(dest, '..');

    const first = await downloadVerifiedRelease(version, { cacheDir });
    expect(first.sha256).toBe(hex);
    expect(readReleaseRehashCountForTests()).toBe(1);

    const second = await downloadVerifiedRelease(version, { cacheDir });
    expect(second.sha256).toBe(hex);
    expect(second.bytes).toBe(tarball.byteLength);
    expect(readReleaseRehashCountForTests()).toBe(1);
  });

  test('等长内容原地覆盖并把 mtime 改回去：ino/ctime 对不上，重算发现不符回到下载路径', async () => {
    const version = '8.3.0';
    const tarball = new Uint8Array(4096).fill(6);
    const { dest, hex } = seedVerifiedCache(version, tarball);
    const cacheDir = join(dest, '..');

    expect((await downloadVerifiedRelease(version, { cacheDir })).sha256).toBe(hex);
    const memoHits = readReleaseRehashCountForTests();

    // 只比 size+mtime 的旧记忆会把这份内容当成已校验的包直接放行
    writeFileSync(dest, Buffer.from(new Uint8Array(4096).fill(7)));
    utimesSync(dest, FIXED_MTIME, FIXED_MTIME);
    await expect(downloadVerifiedRelease(version, { cacheDir })).rejects.toThrow(
      /should not download/
    );
    expect(readReleaseRehashCountForTests()).toBeGreaterThan(memoHits);
  });

  test('换成同名新文件（ino 变了）也要重算', async () => {
    const version = '8.4.0';
    const tarball = new Uint8Array(2048).fill(2);
    const { dest, hex } = seedVerifiedCache(version, tarball);
    const cacheDir = join(dest, '..');

    expect((await downloadVerifiedRelease(version, { cacheDir })).sha256).toBe(hex);
    const before = readReleaseRehashCountForTests();

    // rename 覆盖：内容与长度都一样，只有 inode 换了
    const swap = `${dest}.swap`;
    writeFileSync(swap, Buffer.from(tarball));
    renameSync(swap, dest);
    utimesSync(dest, FIXED_MTIME, FIXED_MTIME);

    const again = await downloadVerifiedRelease(version, { cacheDir });
    expect(again.sha256).toBe(hex);
    expect(readReleaseRehashCountForTests()).toBe(before + 1);
  });

  test('mtime 变了记忆失效，重算发现对不上 → 回到下载路径', async () => {
    const version = '8.5.0';
    const tarball = new Uint8Array(4096).fill(6);
    const { dest, hex } = seedVerifiedCache(version, tarball);
    const cacheDir = join(dest, '..');

    expect((await downloadVerifiedRelease(version, { cacheDir })).sha256).toBe(hex);
    writeFileSync(dest, Buffer.from(new Uint8Array(4096).fill(7)));
    const later = new Date(FIXED_MTIME.getTime() + 5_000);
    utimesSync(dest, later, later);
    await expect(downloadVerifiedRelease(version, { cacheDir })).rejects.toThrow(
      /should not download/
    );
  });
});
