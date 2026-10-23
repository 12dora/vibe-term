import { describe, expect, mock, test } from 'bun:test';
import { ApiClient } from './client';
import { downloadFileWithProgress, prepareDownload } from './download-transfer';
import { FileApiError, TransferInterruptedError } from './file-errors';
import type { LegProgress } from './transfer-types';

function ndjson(lines: object[]): Response {
  const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  return new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Call = { url: string; init?: RequestInit };

function prepareClient(responses: Response[]): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const client = new ApiClient('', (url, init) => {
    calls.push({ url, init });
    const next = responses[index++];
    if (!next) return Promise.reject(new Error(`unexpected fetch ${url}`));
    return Promise.resolve(next);
  });
  return { client, calls };
}

describe('prepareDownload', () => {
  test('POST prepare，汇报 leg1 进度并返回 done 事件里的 id/size/name', async () => {
    const { client, calls } = prepareClient([
      ndjson([
        { type: 'progress', pct: 40, transferred: 4, rate: '1 B/s' },
        { type: 'done', downloadId: 'dl-1', size: 13, name: 'server-name.txt' },
      ]),
    ]);
    const legs: Array<[1 | 2, LegProgress]> = [];
    const onDownloadId = mock((_id: string) => {});

    const prepared = await prepareDownload(
      'root-1',
      '/a/b.txt',
      'fallback.txt',
      { onLeg: (leg, p) => legs.push([leg, p]) },
      client,
      onDownloadId
    );

    expect(calls[0].url).toBe('/api/files/download/prepare');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe(JSON.stringify({ rootId: 'root-1', path: '/a/b.txt' }));
    expect(calls[0].init?.signal).toBeUndefined();
    expect(prepared).toEqual({ downloadId: 'dl-1', size: 13, name: 'server-name.txt' });
    expect(onDownloadId).toHaveBeenCalledWith('dl-1');
    expect(legs.map(([leg]) => leg)).toEqual([1, 1, 1]);
    expect(legs[0][1].pct).toBe(0);
    // detail 走宽度稳定的 `formatBytesFixed`：进度每几百毫秒刷一次，位数不能跟着变
    expect(legs[1][1]).toEqual({ pct: 40, rate: '1 B/s', detail: '0.0 KB', bytes: 4 });
    // prepare 结束时 leg1 收尾，bytes/totalBytes 都是 size
    expect(legs[2][1]).toMatchObject({ pct: 100, bytes: 13, totalBytes: 13 });
  });

  test('onLegWeights：出现过增量进度 → [1,1]；直接 done（本机 stat）→ [0,1]', async () => {
    const incremental = prepareClient([
      ndjson([
        { type: 'progress', pct: 50, transferred: 5 },
        { type: 'done', downloadId: 'dl-w1', size: 10 },
      ]),
    ]);
    const seen: Array<readonly [number, number]> = [];
    await prepareDownload(
      'r',
      '/a',
      'a',
      { onLegWeights: (w) => seen.push(w) },
      incremental.client,
      () => {}
    );
    const instant = prepareClient([
      ndjson([
        { type: 'progress', pct: 0 },
        { type: 'progress', pct: 100 },
        { type: 'done', downloadId: 'dl-w2', size: 10 },
      ]),
    ]);
    await prepareDownload(
      'r',
      '/a',
      'a',
      { onLegWeights: (w) => seen.push(w) },
      instant.client,
      () => {}
    );
    expect(seen).toEqual([
      [1, 1],
      [0, 1],
    ]);
  });

  test('error 事件还原 HTTP 状态：too_large → 413，带 detail', async () => {
    const { client } = prepareClient([
      ndjson([{ type: 'error', code: 'too_large', detail: '2147483648' }]),
    ]);
    const error = await prepareDownload('r', '/a', 'a', {}, client, () => {}).catch(
      (e: unknown) => e
    );
    expect(error).toMatchObject({ status: 413, code: 'too_large', detail: '2147483648' });
  });

  test('HTTP 错误包里的转发层错误码原样保留', async () => {
    const { client } = prepareClient([
      jsonResponse({ code: 'NODE_LOGIN_REQUIRED', nodeId: 'abc' }, 401),
    ]);
    const error = await prepareDownload('r', '/a', 'a', {}, client, () => {}).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(FileApiError);
    expect(error).toMatchObject({ status: 401, code: 'NODE_LOGIN_REQUIRED' });
    expect((error as FileApiError).message).toBe('NODE_LOGIN_REQUIRED');
  });

  test('done 事件缺 name 时退回调用方传入的文件名', async () => {
    const { client } = prepareClient([ndjson([{ type: 'done', downloadId: 'dl-2', size: 7 }])]);

    const prepared = await prepareDownload(
      'root-1',
      '/a/b.txt',
      'fallback.txt',
      {},
      client,
      () => {}
    );

    expect(prepared).toEqual({ downloadId: 'dl-2', size: 7, name: 'fallback.txt' });
  });

  test('多文件：逐个 prepare 各自拿到独立的 downloadId', async () => {
    const { client, calls } = prepareClient([
      ndjson([{ type: 'done', downloadId: 'dl-a', size: 1, name: 'a.txt' }]),
      ndjson([{ type: 'done', downloadId: 'dl-b', size: 2, name: 'b.txt' }]),
    ]);
    const seen: string[] = [];

    const first = await prepareDownload('root-1', '/a.txt', 'a.txt', {}, client, (id) =>
      seen.push(id)
    );
    const second = await prepareDownload('root-2', '/b.txt', 'b.txt', {}, client, (id) =>
      seen.push(id)
    );

    expect([first.downloadId, second.downloadId]).toEqual(['dl-a', 'dl-b']);
    expect(seen).toEqual(['dl-a', 'dl-b']);
    expect(calls[1].init?.body).toBe(JSON.stringify({ rootId: 'root-2', path: '/b.txt' }));
  });

  test('prepare 非 2xx 抛 FileApiError，带响应体文案与状态码', async () => {
    const { client } = prepareClient([
      jsonResponse({ error: 'root not found', code: 'root_not_found' }, 404),
    ]);

    const error = await prepareDownload('root-x', '/a', 'a', {}, client, () => {}).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(FileApiError);
    expect((error as FileApiError).message).toBe('root not found');
    expect((error as FileApiError).status).toBe(404);
    expect((error as FileApiError).code).toBe('root_not_found');
  });

  test('流里的 error 事件转成 FileApiError；已上报的 downloadId 仍交给调用方回收', async () => {
    const { client } = prepareClient([
      ndjson([
        { type: 'done', downloadId: 'dl-3', size: 5, name: 'c.txt' },
        { type: 'error', code: 'timeout', detail: 'rsync exited 23' },
      ]),
    ]);
    const seen: string[] = [];

    const error = await prepareDownload('root-1', '/c.txt', 'c.txt', {}, client, (id) =>
      seen.push(id)
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FileApiError);
    expect((error as FileApiError).message).toBe('rsync exited 23');
    expect((error as FileApiError).code).toBe('timeout');
    expect(seen).toEqual(['dl-3']);
  });

  test('流结束仍无 downloadId：连接被切断，抛 TransferInterruptedError 而不是伪造的服务端错误', async () => {
    const { client } = prepareClient([ndjson([{ type: 'progress', pct: 10 }])]);

    const error = await prepareDownload('root-1', '/a', 'a', {}, client, () => {}).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(TransferInterruptedError);
  });

  test('prepare 请求本身断网 / 响应体中途被切：同样是 TransferInterruptedError', async () => {
    const down = new ApiClient('', () => Promise.reject(new TypeError('Failed to fetch')));
    const cut = new ApiClient('', () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError('network error'));
            },
          }),
          { status: 200 }
        )
      )
    );
    for (const client of [down, cut]) {
      const error = await prepareDownload('r', '/a', 'a', {}, client, () => {}).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(TransferInterruptedError);
      expect((error as TransferInterruptedError).cause).toBeInstanceOf(TypeError);
    }
  });

  test('signal 透传给 prepare 请求；取消时 AbortError 原样上抛', async () => {
    const controller = new AbortController();
    const calls: Call[] = [];
    const client = new ApiClient('', (url, init) => {
      calls.push({ url, init });
      controller.abort();
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    });

    const error = await prepareDownload(
      'root-1',
      '/a',
      'a',
      { signal: controller.signal },
      client,
      () => {}
    ).catch((e: unknown) => e);

    expect(calls[0].init?.signal).toBe(controller.signal);
    expect((error as Error).name).toBe('AbortError');
  });
});

describe('downloadFileWithProgress content', () => {
  function prepared(size: number): Response {
    return ndjson([{ type: 'done', downloadId: 'dl-r', size, name: 'r.bin' }]);
  }

  test('并行分块下载：blob 精确、leg2 的 bytes/totalBytes 单调且收尾，收全后才回收会话', async () => {
    const data = Uint8Array.from({ length: 50 }, (_, i) => i);
    const calls: Call[] = [];
    const client = new ApiClient('', (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/prepare')) return Promise.resolve(prepared(data.length));
      if (url.endsWith('/content')) {
        const m = /bytes=(\d+)-(\d+)/.exec((init?.headers as Record<string, string>).Range);
        const [from, to] = [Number(m?.[1]), Number(m?.[2])];
        return Promise.resolve(
          new Response(data.slice(from, to + 1), {
            status: 206,
            headers: { 'Content-Range': `bytes ${from}-${to}/50`, ETag: '"e"' },
          })
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const legs: Array<[1 | 2, LegProgress]> = [];
    const weights: Array<readonly [number, number]> = [];

    const file = await downloadFileWithProgress(
      'root-1',
      '/r.bin',
      'r.bin',
      {
        chunkBytes: 20,
        streams: 3,
        onLeg: (leg, p) => legs.push([leg, p]),
        onLegWeights: (w) => weights.push(w),
      },
      client
    );

    expect(Array.from(new Uint8Array(await file.blob.arrayBuffer()))).toEqual(Array.from(data));
    expect(weights).toEqual([[0, 1]]);
    const leg2 = legs.filter(([leg]) => leg === 2).map(([, p]) => p);
    expect(leg2[0]).toMatchObject({ pct: 0, bytes: 0, totalBytes: 50 });
    expect(leg2.every((p, i) => i === 0 || (p.bytes ?? 0) >= (leg2[i - 1].bytes ?? 0))).toBe(true);
    expect(leg2.slice(0, -1).every((p) => p.pct < 100)).toBe(true);
    expect(leg2.at(-1)).toMatchObject({ pct: 100, bytes: 50, totalBytes: 50 });
    expect(calls.filter((c) => c.url.endsWith('/content'))).toHaveLength(3);
    expect(calls.at(-1)?.init?.method).toBe('DELETE');
    expect(calls.at(-1)?.url).toBe('/api/files/download/dl-r');
  });

  test('永久性 HTTP 错误立即失败并回收会话', async () => {
    const calls: Call[] = [];
    const client = new ApiClient('', (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/prepare')) return Promise.resolve(prepared(5));
      if (url.endsWith('/content')) {
        return Promise.resolve(jsonResponse({ error: 'not_found', code: 'not_found' }, 404));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    await expect(
      downloadFileWithProgress('root-1', '/r.txt', 'r.txt', {}, client)
    ).rejects.toMatchObject({ status: 404 });
    expect(calls.filter((c) => c.url.endsWith('/content'))).toHaveLength(1);
    expect(calls.at(-1)?.init?.method).toBe('DELETE');
  });

  test('网络一直不通：TransferInterruptedError，且会话已回收', async () => {
    const calls: Call[] = [];
    const client = new ApiClient('', (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/prepare')) return Promise.resolve(prepared(5));
      if (url.endsWith('/content')) return Promise.reject(new TypeError('boom'));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const error = await downloadFileWithProgress(
      'root-1',
      '/r.txt',
      'r.txt',
      { sleep: async () => {} },
      client
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferInterruptedError);
    expect((error as TransferInterruptedError).cause).toBeInstanceOf(TypeError);
    expect(calls.at(-1)?.init?.method).toBe('DELETE');
  });
});
