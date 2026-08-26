import { describe, expect, mock, test } from 'bun:test';
import { ApiClient } from './client';
import { downloadFileWithProgress } from './files';

function ndjson(lines: object[]): Uint8Array {
  const text = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  return new TextEncoder().encode(text);
}

function streamResponse(body: Uint8Array, init?: ResponseInit): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
    ...init,
  });
}

describe('downloadFileWithProgress transport', () => {
  test('返回 name/blob，汇报 progress，且不触碰 document/URL.createObjectURL', async () => {
    // 证明传输与宿主 save 分离：即使存在 DOM 钩子，传输函数也不得调用它们。
    const createElement = mock(() => {
      throw new Error('document.createElement must not be used by download transport');
    });
    const createObjectURL = mock(() => {
      throw new Error('URL.createObjectURL must not be used by download transport');
    });
    const prevDocument = (globalThis as { document?: unknown }).document;
    const prevURL = globalThis.URL;
    Object.defineProperty(globalThis, 'document', {
      value: { createElement, body: { appendChild: mock(() => {}) } },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'URL', {
      value: { createObjectURL, revokeObjectURL: mock(() => {}) },
      configurable: true,
    });

    try {
      const progress: Array<{ leg: 1 | 2; pct: number }> = [];
      const contentBytes = new TextEncoder().encode('file-body-xyz');
      const transport = mock(async (input: string, init?: RequestInit) => {
        if (input.endsWith('/api/files/download/prepare') && init?.method === 'POST') {
          return streamResponse(
            ndjson([
              { type: 'progress', pct: 40, transferred: 4, rate: '1 B/s' },
              {
                type: 'done',
                downloadId: 'dl-1',
                size: contentBytes.byteLength,
                name: 'server-name.txt',
              },
            ])
          );
        }
        if (input.endsWith('/api/files/download/dl-1/content')) {
          return new Response(contentBytes, {
            status: 200,
            headers: { 'Content-Length': String(contentBytes.byteLength) },
          });
        }
        throw new Error(`unexpected fetch ${input} ${init?.method ?? 'GET'}`);
      });

      const client = new ApiClient('', transport);
      const result = await downloadFileWithProgress(
        'root-1',
        '/a/b.txt',
        'fallback.txt',
        {
          onLeg: (leg, p) => {
            progress.push({ leg, pct: p.pct });
          },
        },
        client
      );

      expect(result.name).toBe('server-name.txt');
      expect(await result.blob.text()).toBe('file-body-xyz');
      expect(progress.some((p) => p.leg === 1 && p.pct === 40)).toBe(true);
      expect(progress.some((p) => p.leg === 1 && p.pct === 100)).toBe(true);
      expect(progress.some((p) => p.leg === 2 && p.pct === 100)).toBe(true);
      expect(transport).toHaveBeenCalled();
      expect(createElement).toHaveBeenCalledTimes(0);
      expect(createObjectURL).toHaveBeenCalledTimes(0);
    } finally {
      Object.defineProperty(globalThis, 'document', {
        value: prevDocument,
        configurable: true,
      });
      Object.defineProperty(globalThis, 'URL', {
        value: prevURL,
        configurable: true,
      });
    }
  });

  test('content 失败时 best-effort DELETE 远端 download', async () => {
    const deleted: string[] = [];
    const transport = mock(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/files/download/prepare')) {
        return streamResponse(
          ndjson([{ type: 'done', downloadId: 'dl-x', size: 3, name: 'x.bin' }])
        );
      }
      if (input.endsWith('/api/files/download/dl-x/content')) {
        return new Response(JSON.stringify({ error: 'gone' }), { status: 410 });
      }
      if (input.endsWith('/api/files/download/dl-x') && init?.method === 'DELETE') {
        deleted.push(input);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${input}`);
    });

    const client = new ApiClient('http://gw', transport);
    await expect(downloadFileWithProgress('r', '/p', 'n', {}, client)).rejects.toMatchObject({
      status: 410,
    });
    expect(deleted).toEqual(['http://gw/api/files/download/dl-x']);
  });

  test('prepare 拿到 downloadId 后解析失败，仍 DELETE 远端 download', async () => {
    // 回归：downloadId 已产出但 prepare 阶段抛错（此处为畸形 NDJSON 行），
    // 清理必须照常执行，否则服务端临时文件泄漏。
    const deleted: string[] = [];
    const transport = mock(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/files/download/prepare')) {
        const text = `${JSON.stringify({
          type: 'done',
          downloadId: 'dl-broken',
          size: 3,
          name: 'x.bin',
        })}\n{not-json\n`;
        return new Response(text, { status: 200 });
      }
      if (input.endsWith('/api/files/download/dl-broken') && init?.method === 'DELETE') {
        deleted.push(input);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${input}`);
    });

    const client = new ApiClient('http://gw', transport);
    await expect(downloadFileWithProgress('r', '/p', 'n', {}, client)).rejects.toBeInstanceOf(
      SyntaxError
    );
    expect(deleted).toEqual(['http://gw/api/files/download/dl-broken']);
  });

  test('prepare 流在 done 之后中断，仍 DELETE 远端 download', async () => {
    const deleted: string[] = [];
    const transport = mock(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/files/download/prepare')) {
        let step = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (step === 0) {
              step = 1;
              controller.enqueue(
                ndjson([{ type: 'done', downloadId: 'dl-cut', size: 3, name: 'x.bin' }])
              );
              return;
            }
            controller.error(new Error('connection reset'));
          },
        });
        return new Response(stream, { status: 200 });
      }
      if (input.endsWith('/api/files/download/dl-cut') && init?.method === 'DELETE') {
        deleted.push(input);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${input}`);
    });

    const client = new ApiClient('', transport);
    await expect(downloadFileWithProgress('r', '/p', 'n', {}, client)).rejects.toMatchObject({
      message: 'connection reset',
    });
    expect(deleted).toEqual(['/api/files/download/dl-cut']);
  });

  test('prepare 在 done 之后报 error 事件时清理远端 download', async () => {
    const deleted: string[] = [];
    const transport = mock(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/files/download/prepare')) {
        return streamResponse(
          ndjson([
            { type: 'done', downloadId: 'dl-late', size: 3, name: 'x.bin' },
            { type: 'error', code: 'rsync_failed', detail: 'rsync exited 12' },
          ])
        );
      }
      if (input.endsWith('/api/files/download/dl-late') && init?.method === 'DELETE') {
        deleted.push(input);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${input}`);
    });

    const client = new ApiClient('', transport);
    await expect(downloadFileWithProgress('r', '/p', 'n', {}, client)).rejects.toMatchObject({
      status: 500,
      message: 'rsync exited 12',
    });
    expect(deleted).toEqual(['/api/files/download/dl-late']);
  });

  test('prepare 未产出 downloadId 时不发起 DELETE', async () => {
    const calls: string[] = [];
    const transport = mock(async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${input}`);
      if (input.endsWith('/api/files/download/prepare')) {
        return streamResponse(ndjson([{ type: 'progress', pct: 10, transferred: 1 }]));
      }
      return new Response(null, { status: 204 });
    });

    const client = new ApiClient('', transport);
    await expect(downloadFileWithProgress('r', '/p', 'n', {}, client)).rejects.toMatchObject({
      status: 500,
      code: 'unknown',
    });
    expect(calls).toEqual(['POST /api/files/download/prepare']);
  });
});
