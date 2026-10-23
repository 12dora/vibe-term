import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@vibeterm/api-client';
import type { LegProgress } from '@vibeterm/api-client/transfer-types';
import {
  type FileBulkClient,
  type TransferPathOpts,
  downloadFileWithTransport,
  uploadFileWithTransport,
} from './bulk-transfer';

function ndjson(lines: unknown[]): Response {
  return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

function fakeBulk(overrides: Partial<FileBulkClient> = {}): FileBulkClient {
  return {
    isAvailable: () => true,
    upload: async (req) => {
      req.onProgress?.(req.size / 2, req.size);
      req.onProgress?.(req.size, req.size);
      return { ok: true };
    },
    download: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4).fill(1));
          controller.enqueue(new Uint8Array(4).fill(2));
          controller.close();
        },
      }),
    ...overrides,
  };
}

describe('bulk 路径的两段权重与字节进度', () => {
  test('上传：init 后给权重，两段 onLeg 都带精确 bytes/totalBytes', async () => {
    const client = new ApiClient('', async (input, init) => {
      if (input === '/api/files/upload/init') {
        return new Response(
          JSON.stringify({ uploadId: 'u1', chunkSize: 1024, commitProgress: false }),
          { status: 200 }
        );
      }
      if (input === '/api/files/upload/u1/commit' && init?.method === 'POST') {
        return ndjson([
          { type: 'progress', transferred: 6, pct: 75, rate: '1 B/s' },
          { type: 'done', uploaded: '/d/a.bin' },
        ]);
      }
      throw new Error(`unexpected ${input}`);
    });
    const legs: Array<[1 | 2, LegProgress]> = [];
    const weights: Array<readonly [number, number]> = [];

    await uploadFileWithTransport(
      'node-a',
      'r1',
      '/d',
      new File([new Uint8Array(8)], 'a.bin'),
      { onLeg: (leg, p) => legs.push([leg, p]), onLegWeights: (w) => weights.push(w) },
      client,
      { resolveBulk: () => fakeBulk() }
    );

    expect(weights).toEqual([[1, 0]]);
    const leg1 = legs.filter(([leg]) => leg === 1).map(([, p]) => p.bytes);
    expect(leg1).toEqual([0, 4, 8, 8]);
    const leg2 = legs.filter(([leg]) => leg === 2).map(([, p]) => p);
    expect(leg2.some((p) => p.bytes === 6 && p.totalBytes === 8)).toBe(true);
    expect(leg2.at(-1)).toMatchObject({ pct: 100, bytes: 8, totalBytes: 8 });
  });

  test('下载：prepare 给权重并收尾 leg1，bulk 收流时 leg2 带 bytes/totalBytes', async () => {
    const client = new ApiClient('', async (input, init) => {
      if (input === '/api/files/download/prepare') {
        return ndjson([
          { type: 'progress', pct: 50, transferred: 4 },
          { type: 'done', downloadId: 'd1', size: 8, name: 'a.bin' },
        ]);
      }
      if (input === '/api/files/download/d1' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${input}`);
    });
    const legs: Array<[1 | 2, LegProgress]> = [];
    const weights: Array<readonly [number, number]> = [];

    const file = await downloadFileWithTransport(
      'node-a',
      'r1',
      '/a.bin',
      'a.bin',
      { onLeg: (leg, p) => legs.push([leg, p]), onLegWeights: (w) => weights.push(w) },
      client,
      { resolveBulk: () => fakeBulk() }
    );

    expect(file.transferPath).toBe('direct');
    expect(weights).toEqual([[1, 1]]);
    const leg1 = legs.filter(([leg]) => leg === 1).map(([, p]) => p);
    expect(leg1.at(-1)).toMatchObject({ pct: 100, bytes: 8, totalBytes: 8 });
    const leg2 = legs.filter(([leg]) => leg === 2).map(([, p]) => p);
    expect(leg2.at(-1)).toMatchObject({ pct: 100, bytes: 8, totalBytes: 8 });
  });

  test('bulk 失败回落 REST 时 streams 原样传给并行 Range 下载', async () => {
    const data = new Uint8Array(24).map((_, i) => i);
    const ranges: string[] = [];
    const client = new ApiClient('', async (input, init) => {
      if (input === '/api/files/download/prepare') {
        return ndjson([{ type: 'done', downloadId: 'd1', size: data.length, name: 'a.bin' }]);
      }
      if (input === '/api/files/download/d1/content') {
        const range = (init?.headers as Record<string, string> | undefined)?.Range ?? '';
        ranges.push(range);
        const m = /bytes=(\d+)-(\d+)/.exec(range);
        const from = Number(m?.[1]);
        const to = Number(m?.[2]);
        return new Response(data.slice(from, to + 1), {
          status: 206,
          headers: { 'Content-Range': `bytes ${from}-${to}/${data.length}` },
        });
      }
      return new Response(null, { status: 204 });
    });
    const opts = { streams: 3, chunkBytes: 8 };

    const file = await downloadFileWithTransport(
      'node-a',
      'r1',
      '/a.bin',
      'a.bin',
      opts as TransferPathOpts,
      client,
      {
        resolveBulk: () =>
          fakeBulk({
            download: () =>
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new Error('dc closed'));
                },
              }),
          }),
      }
    );

    expect(file.transferPath).toBe('relay');
    expect(Array.from(new Uint8Array(await file.blob.arrayBuffer()))).toEqual(Array.from(data));
    expect(ranges.sort()).toEqual(['bytes=0-7', 'bytes=16-23', 'bytes=8-15']);
  });
});
