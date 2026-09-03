import { describe, expect, mock, test } from 'bun:test';
import { ApiClient } from './client';
import { prepareDownload } from './download-transfer';
import { FileApiError } from './file-errors';
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
    expect(prepared).toEqual({ downloadId: 'dl-1', size: 13, name: 'server-name.txt' });
    expect(onDownloadId).toHaveBeenCalledWith('dl-1');
    expect(legs.map(([leg]) => leg)).toEqual([1, 1]);
    expect(legs[0][1].pct).toBe(0);
    expect(legs[1][1]).toEqual({ pct: 40, rate: '1 B/s', detail: '4 B' });
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

  test('流结束仍无 downloadId 时抛 unknown', async () => {
    const { client } = prepareClient([ndjson([{ type: 'progress', pct: 10 }])]);

    const error = await prepareDownload('root-1', '/a', 'a', {}, client, () => {}).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(FileApiError);
    expect((error as FileApiError).message).toBe('unknown');
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
