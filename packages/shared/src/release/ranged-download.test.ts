import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadAssetRanged } from './ranged-download';
import { REDIRECT_REJECTED } from './redirect';
import { isAllowedReleaseDownloadHost } from './source';

const servers: Array<{ stop: () => void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseRange(req: Request): { start: number; end: number } | null {
  const raw = req.headers.get('range');
  if (!raw) return null;
  const matched = /^bytes=(\d+)-(\d+)$/i.exec(raw.trim());
  if (!matched) return null;
  return { start: Number(matched[1]), end: Number(matched[2]) };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-ranged-'));
  tempDirs.push(dir);
  return dir;
}

function serveAsset(
  payload: Uint8Array,
  opts: {
    acceptRanges?: boolean;
    failChunkOnce?: { start: number };
    contentLength?: boolean;
  } = {}
): { url: string; rangeHits: number[]; fullHits: number } {
  const acceptRanges = opts.acceptRanges !== false;
  const fail = opts.failChunkOnce ? { start: opts.failChunkOnce.start, used: false } : null;
  const rangeHits: number[] = [];
  let fullHits = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const range = parseRange(req);
      if (range && acceptRanges) {
        rangeHits.push(range.start);
        if (fail && !fail.used && range.start === fail.start) {
          fail.used = true;
          return new Response('chunk failed', { status: 500 });
        }
        const end = Math.min(range.end, payload.byteLength - 1);
        const slice = payload.subarray(range.start, end + 1);
        return new Response(Buffer.from(slice), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${range.start}-${range.start + slice.byteLength - 1}/${payload.byteLength}`,
            'Content-Length': String(slice.byteLength),
            'Accept-Ranges': 'bytes',
          },
        });
      }
      fullHits += 1;
      const headers = new Headers();
      if (opts.contentLength !== false) headers.set('Content-Length', String(payload.byteLength));
      if (acceptRanges) headers.set('Accept-Ranges', 'bytes');
      return new Response(Buffer.from(payload), { status: 200, headers });
    },
  });
  servers.push(server);
  return {
    url: `${server.url}asset.tgz`,
    rangeHits,
    get fullHits() {
      return fullHits;
    },
  };
}

describe('downloadAssetRanged', () => {
  test('parallel Range writes reconstruct the asset and sha256', async () => {
    const payload = Buffer.alloc(32 * 1024, 7);
    payload[100] = 11;
    payload[payload.length - 1] = 99;
    const served = serveAsset(payload);
    const dir = await tempDir();
    const dest = join(dir, 'a.tgz.part');
    const progress: Array<[number, number]> = [];

    const result = await downloadAssetRanged(served.url, {
      destPath: dest,
      totalBytes: payload.byteLength,
      acceptsRanges: true,
      streams: 4,
      chunkBytes: 4 * 1024,
      onProgress: (downloaded, total) => progress.push([downloaded, total]),
    });

    expect(result.streams).toBeGreaterThan(1);
    expect(result.bytes).toBe(payload.byteLength);
    expect(result.sha256).toBe(sha256Hex(payload));
    expect(await readFile(dest)).toEqual(payload);
    expect(served.rangeHits.length).toBeGreaterThan(1);
    expect(progress.at(-1)?.[0]).toBe(payload.byteLength);
    expect(progress.every(([, total]) => total === payload.byteLength)).toBe(true);
  });

  test('retries a failing chunk and still completes', async () => {
    const payload = Buffer.alloc(12 * 1024, 5);
    const served = serveAsset(payload, { failChunkOnce: { start: 4 * 1024 } });
    const dir = await tempDir();
    const dest = join(dir, 'retry.tgz.part');

    const result = await downloadAssetRanged(served.url, {
      destPath: dest,
      totalBytes: payload.byteLength,
      acceptsRanges: true,
      streams: 3,
      chunkBytes: 4 * 1024,
      retriesPerChunk: 3,
    });

    expect(result.sha256).toBe(sha256Hex(payload));
    expect(served.rangeHits.filter((start) => start === 4 * 1024).length).toBeGreaterThanOrEqual(2);
    expect(await readFile(dest)).toEqual(payload);
  });

  test('falls back to a single stream when Accept-Ranges is false', async () => {
    const payload = Buffer.from('single-stream-body');
    const served = serveAsset(payload, { acceptRanges: false });
    const dir = await tempDir();
    const dest = join(dir, 'single.tgz.part');

    const result = await downloadAssetRanged(served.url, {
      destPath: dest,
      totalBytes: payload.byteLength,
      acceptsRanges: false,
      streams: 4,
      chunkBytes: 4,
    });

    expect(result.streams).toBe(1);
    expect(served.rangeHits).toEqual([]);
    expect(served.fullHits).toBe(1);
    expect(result.sha256).toBe(sha256Hex(payload));
    expect(await readFile(dest, 'utf8')).toBe('single-stream-body');
  });

  test('discovers Range support from the first GET when totalBytes is unknown', async () => {
    const payload = Buffer.alloc(16 * 1024, 9);
    payload[0] = 1;
    payload[payload.length - 1] = 2;
    const served = serveAsset(payload);
    const dir = await tempDir();
    const dest = join(dir, 'discover.tgz.part');

    const result = await downloadAssetRanged(served.url, {
      destPath: dest,
      totalBytes: null,
      streams: 4,
      chunkBytes: 4 * 1024,
    });

    expect(result.streams).toBeGreaterThan(1);
    expect(result.finalUrl).toBe(served.url);
    expect(result.sha256).toBe(sha256Hex(payload));
    expect(await readFile(dest)).toEqual(payload);
    expect(served.rangeHits[0]).toBe(0);
    expect(served.rangeHits.length).toBeGreaterThan(1);
  });

  test('falls back to a single stream when the server ignores Range', async () => {
    const payload = Buffer.alloc(8 * 1024, 3);
    const served = serveAsset(payload, { acceptRanges: false, contentLength: false });
    const dir = await tempDir();
    const dest = join(dir, 'unknown.tgz.part');

    const result = await downloadAssetRanged(served.url, {
      destPath: dest,
      totalBytes: null,
      streams: 4,
      chunkBytes: 1024,
    });

    expect(result.streams).toBe(1);
    expect(served.fullHits).toBe(1);
    expect(result.bytes).toBe(payload.byteLength);
    expect(result.sha256).toBe(sha256Hex(payload));
  });

  test('parallel path falls back to the first 200 when the server ignores Range', async () => {
    const payload = Buffer.alloc(12 * 1024, 4);
    payload[0] = 21;
    payload[payload.length - 1] = 22;
    let rangeHits = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.headers.has('range')) rangeHits += 1;
        return new Response(Buffer.from(payload), {
          status: 200,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': String(payload.byteLength),
          },
        });
      },
    });
    servers.push(server);
    const dir = await tempDir();
    const dest = join(dir, 'ignore-range.tgz.part');

    const result = await downloadAssetRanged(`${server.url}asset.tgz`, {
      destPath: dest,
      totalBytes: payload.byteLength,
      acceptsRanges: true,
      streams: 4,
      chunkBytes: 4 * 1024,
    });

    expect(rangeHits).toBeGreaterThan(0);
    expect(result.streams).toBe(1);
    expect(result.bytes).toBe(payload.byteLength);
    expect(result.sha256).toBe(sha256Hex(payload));
    expect(await readFile(dest)).toEqual(payload);
  });

  test('206 without Content-Range falls back to a single stream', async () => {
    const payload = Buffer.alloc(6 * 1024, 5);
    payload[0] = 31;
    payload[payload.length - 1] = 32;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(Buffer.from(payload), {
          status: 206,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': String(payload.byteLength),
          },
        });
      },
    });
    servers.push(server);
    const dir = await tempDir();
    const dest = join(dir, 'no-cr.tgz.part');
    const result = await downloadAssetRanged(`${server.url}asset.tgz`, {
      destPath: dest,
      totalBytes: payload.byteLength,
      acceptsRanges: true,
      streams: 4,
      chunkBytes: 2 * 1024,
    });
    expect(result.streams).toBe(1);
    expect(result.sha256).toBe(sha256Hex(payload));
    expect(await readFile(dest)).toEqual(payload);
  });

  test('Content-Range total mismatch fails instead of writing a partial chunk', async () => {
    const payload = Buffer.alloc(8 * 1024, 6);
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const range = parseRange(req);
        if (!range) return new Response(Buffer.from(payload), { status: 200 });
        const end = Math.min(range.end, payload.byteLength - 1);
        const slice = payload.subarray(range.start, end + 1);
        return new Response(Buffer.from(slice), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${range.start}-${range.start + slice.byteLength - 1}/999999`,
            'Accept-Ranges': 'bytes',
          },
        });
      },
    });
    servers.push(server);
    const dir = await tempDir();
    await expect(
      downloadAssetRanged(`${server.url}asset.tgz`, {
        destPath: join(dir, 'mismatch.tgz.part'),
        totalBytes: payload.byteLength,
        acceptsRanges: true,
        streams: 2,
        chunkBytes: 4 * 1024,
      })
    ).rejects.toThrow(/content-range total mismatch/);
  });

  test('abort settles when body read never resolves', async () => {
    const ac = new AbortController();
    const dir = await tempDir();
    const pending = downloadAssetRanged('https://cdn.example/hang.tgz', {
      destPath: join(dir, 'hang.tgz.part'),
      totalBytes: 100,
      fetch: async () =>
        new Response(hangingBody(), {
          status: 200,
          headers: { 'Content-Length': '100' },
        }),
      signal: ac.signal,
    });
    const started = Date.now();
    setTimeout(() => ac.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('idle timeout settles a hanging body read', async () => {
    const dir = await tempDir();
    const started = Date.now();
    await expect(
      downloadAssetRanged('https://cdn.example/idle.tgz', {
        destPath: join(dir, 'idle.tgz.part'),
        totalBytes: 100,
        fetch: async () =>
          new Response(hangingBody(), {
            status: 200,
            headers: { 'Content-Length': '100' },
          }),
        readIdleMs: 40,
      })
    ).rejects.toThrow(/idle timeout/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('rejects an http redirect hop', async () => {
    const dir = await tempDir();
    await expect(
      downloadAssetRanged('https://github.com/owner/repo/releases/download/v1/a.tgz', {
        destPath: join(dir, 'http.tgz.part'),
        totalBytes: 4,
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: 'http://objects.githubusercontent.com/x' },
          }),
      })
    ).rejects.toMatchObject({ message: REDIRECT_REJECTED });
  });

  test('rejects a redirect off the host allowlist', async () => {
    const dir = await tempDir();
    await expect(
      downloadAssetRanged('https://github.com/owner/repo/releases/download/v1/a.tgz', {
        destPath: join(dir, 'evil.tgz.part'),
        totalBytes: 4,
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: 'https://evil.example/steal' },
          }),
      })
    ).rejects.toMatchObject({ message: REDIRECT_REJECTED });
  });

  test('chunk fetches use redirect:error against the resolved CDN URL', async () => {
    const payload = Buffer.alloc(8 * 1024, 2);
    payload[0] = 1;
    payload[payload.length - 1] = 9;
    const github = 'https://github.com/owner/repo/releases/download/v1/a.tgz';
    const cdn = 'https://objects.githubusercontent.com/asset';
    const seen: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, redirect: init?.redirect });
      if (url === github) {
        return new Response(null, { status: 302, headers: { Location: cdn } });
      }
      expect(url).toBe(cdn);
      const range = parseRangeInit(init);
      if (!range) return new Response(Buffer.from(payload), { status: 200 });
      const slice = payload.subarray(range.start, Math.min(range.end + 1, payload.byteLength));
      return new Response(Buffer.from(slice), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${range.start}-${range.start + slice.byteLength - 1}/${payload.byteLength}`,
          'Accept-Ranges': 'bytes',
        },
      });
    };
    const dir = await tempDir();
    const result = await downloadAssetRanged(github, {
      destPath: join(dir, 'cdn.tgz.part'),
      totalBytes: payload.byteLength,
      acceptsRanges: true,
      streams: 2,
      chunkBytes: 4 * 1024,
      fetch: fetchFn,
    });
    expect(result.sha256).toBe(sha256Hex(payload));
    expect(seen[0]).toEqual({ url: github, redirect: 'manual' });
    expect(seen.slice(1).every((call) => call.url === cdn)).toBe(true);
    expect(seen.some((call) => call.redirect === 'error')).toBe(true);
    expect(seen.filter((call) => call.redirect === 'error').every((call) => call.url === cdn)).toBe(
      true
    );
  });

  test('re-resolves once when a chunk fetch is redirected', async () => {
    const payload = Buffer.alloc(8 * 1024, 8);
    const github = 'https://github.com/owner/repo/releases/download/v1/a.tgz';
    const cdn1 = 'https://objects.githubusercontent.com/one';
    const cdn2 = 'https://objects.githubusercontent.com/two';
    let resolved = cdn1;
    let errorRedirects = 0;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === github) {
        return new Response(null, { status: 302, headers: { Location: resolved } });
      }
      if (url === cdn1 && init?.redirect === 'error') {
        errorRedirects += 1;
        resolved = cdn2;
        return new Response(null, { status: 302, headers: { Location: cdn2 } });
      }
      const range = parseRangeInit(init);
      if (!range) return new Response(Buffer.from(payload), { status: 200 });
      const slice = payload.subarray(range.start, Math.min(range.end + 1, payload.byteLength));
      return new Response(Buffer.from(slice), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${range.start}-${range.start + slice.byteLength - 1}/${payload.byteLength}`,
          'Accept-Ranges': 'bytes',
        },
      });
    };
    const dir = await tempDir();
    const result = await downloadAssetRanged(github, {
      destPath: join(dir, 'reresolve.tgz.part'),
      totalBytes: payload.byteLength,
      acceptsRanges: true,
      streams: 2,
      chunkBytes: 4 * 1024,
      fetch: fetchFn,
    });
    expect(errorRedirects).toBeGreaterThan(0);
    expect(result.sha256).toBe(sha256Hex(payload));
    expect(await readFile(join(dir, 'reresolve.tgz.part'))).toEqual(payload);
  });
});

describe('isAllowedReleaseDownloadHost', () => {
  test('allows origin, github.com, and githubusercontent CDN hosts', () => {
    expect(isAllowedReleaseDownloadHost('cdn.example', 'cdn.example')).toBe(true);
    expect(isAllowedReleaseDownloadHost('github.com', 'example.com')).toBe(true);
    expect(isAllowedReleaseDownloadHost('objects.githubusercontent.com', 'github.com')).toBe(true);
    expect(isAllowedReleaseDownloadHost('raw.githubusercontent.com', 'github.com')).toBe(true);
    expect(isAllowedReleaseDownloadHost('evil.example', 'github.com')).toBe(false);
    expect(isAllowedReleaseDownloadHost('github.com.evil.example', 'github.com')).toBe(false);
  });
});

function hangingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
  });
}

function parseRangeInit(init?: RequestInit): { start: number; end: number } | null {
  const raw = new Headers(init?.headers).get('range');
  if (!raw) return null;
  const matched = /^bytes=(\d+)-(\d+)$/i.exec(raw.trim());
  if (!matched) return null;
  return { start: Number(matched[1]), end: Number(matched[2]) };
}
