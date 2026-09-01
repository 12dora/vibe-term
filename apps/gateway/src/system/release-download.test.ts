import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_REPO_URL, releaseTarballName, releaseTarballUrl } from '@tmex/shared';
import {
  downloadVerifiedRelease,
  resetReleaseDownloadForTests,
  resolveReleaseSha256SumsUrl,
  resolveReleaseTarballUrl,
} from './release-download';

const originalFetch = globalThis.fetch;
const originalBase = process.env.TMEX_RELEASE_BASE_URL;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.TMEX_RELEASE_BASE_URL;
  else process.env.TMEX_RELEASE_BASE_URL = originalBase;
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
    if (url.includes('SHA256SUMS')) {
      return new Response(`${hex}  ${releaseTarballName(version)}\n`, { status: 200 });
    }
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
    delete process.env.TMEX_RELEASE_BASE_URL;
    expect(resolveReleaseTarballUrl('1.2.3')).toBe(releaseTarballUrl('1.2.3'));
    expect(resolveReleaseSha256SumsUrl('1.2.3')).toContain(
      `${RELEASE_REPO_URL}/releases/download/v1.2.3/SHA256SUMS`
    );
  });

  test('TMEX_RELEASE_BASE_URL overrides the GitHub host while keeping the path layout', () => {
    process.env.TMEX_RELEASE_BASE_URL = 'http://127.0.0.1:19991';
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
      if (url.includes('SHA256SUMS')) {
        return new Response(`${'0'.repeat(64)}  ${releaseTarballName(version)}\n`, { status: 200 });
      }
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
});
