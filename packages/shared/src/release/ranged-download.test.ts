import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadAssetRanged } from './ranged-download';

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
});
