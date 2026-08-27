import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import {
  type FileBulkClient,
  downloadFileWithTransport,
  uploadFileWithTransport,
} from './bulk-transfer';

interface Recorded {
  calls: string[];
  client: ApiClient;
}

function ndjson(lines: unknown[]): Response {
  const body = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 记录调用序列的假 gateway；`routes` 按 `<METHOD> <path>` 精确匹配，缺省 200 空体。 */
function recorder(handler: (method: string, path: string) => Response | null): Recorded {
  const calls: string[] = [];
  const client = new ApiClient('', async (input, init) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${input}`);
    return handler(method, input) ?? new Response('', { status: 200 });
  });
  return { calls, client };
}

function uploadGateway(): Recorded & { commits: string[] } {
  const commits: string[] = [];
  let nextId = 0;
  const rec = recorder((method, path) => {
    if (method === 'POST' && path === '/api/files/upload/init') {
      nextId += 1;
      return json({ uploadId: `u${nextId}`, chunkSize: 1024 });
    }
    const commit = /^\/api\/files\/upload\/([^/]+)\/commit$/.exec(path);
    if (method === 'POST' && commit) {
      commits.push(commit[1] as string);
      return ndjson([{ type: 'done' }]);
    }
    return null;
  });
  return { ...rec, commits };
}

function fakeBulk(overrides: Partial<FileBulkClient> = {}): FileBulkClient {
  return {
    isAvailable: () => true,
    // 默认按「全部字节都送到了」上报进度：面板会核对送出字节数与登记的 size
    upload: async (req) => {
      req.onProgress?.(req.size, req.size);
      return { ok: true };
    },
    download: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
    ...overrides,
  };
}

function fileOf(size: number, name = 'a.bin'): File {
  return new File([new Uint8Array(size).fill(3)], name);
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('uploadFileWithTransport', () => {
  test('直连可用时走 bulk：init → bulk → commit，不发 PUT 分块', async () => {
    const gw = uploadGateway();
    const uploads: Array<{ transferId: string; size: number }> = [];
    const bulk = fakeBulk({
      upload: async (req) => {
        uploads.push({ transferId: req.transferId, size: req.size });
        req.onProgress?.(req.size, req.size);
        return { ok: true };
      },
    });

    const path = await uploadFileWithTransport(
      'node-a',
      'r1',
      '/dest',
      fileOf(2048),
      {},
      gw.client,
      { resolveBulk: () => bulk }
    );

    expect(path).toBe('direct');
    expect(uploads).toEqual([{ transferId: 'u1', size: 2048 }]);
    expect(gw.calls).toEqual(['POST /api/files/upload/init', 'POST /api/files/upload/u1/commit']);
    expect(gw.commits).toEqual(['u1']);
  });

  test('两段进度都上报，路径回调为 direct', async () => {
    const gw = uploadGateway();
    const legs: Array<[number, number]> = [];
    const paths: string[] = [];
    await uploadFileWithTransport(
      'node-a',
      'r1',
      '/dest',
      fileOf(100),
      {
        onLeg: (leg, p) => legs.push([leg, p.pct]),
        onPath: (p) => paths.push(p),
      },
      gw.client,
      { resolveBulk: () => fakeBulk() }
    );
    expect(paths).toEqual(['direct']);
    expect(legs).toContainEqual([1, 100]);
    expect(legs).toContainEqual([2, 100]);
  });

  test('node 回 {ok:false} 时整次改走 REST，且只 commit 一次', async () => {
    const gw = uploadGateway();
    const bulk = fakeBulk({ upload: async () => ({ ok: false, code: 'permission_denied' }) });

    const path = await uploadFileWithTransport(
      'node-a',
      'r1',
      '/dest',
      fileOf(1500),
      {},
      gw.client,
      { resolveBulk: () => bulk }
    );

    expect(path).toBe('relay');
    // 直连会话先回收，再用全新 uploadId 走 REST 分块；同一个 uploadId 绝不 commit 两次
    expect(gw.calls).toEqual([
      'POST /api/files/upload/init',
      'DELETE /api/files/upload/u1',
      'POST /api/files/upload/init',
      'PUT /api/files/upload/u2?offset=0',
      'PUT /api/files/upload/u2?offset=1024',
      'POST /api/files/upload/u2/commit',
    ]);
    expect(gw.commits).toEqual(['u2']);
  });

  test('bulk 传输层抛错时同样回落 REST', async () => {
    const gw = uploadGateway();
    const bulk = fakeBulk({
      upload: async () => {
        throw new Error('bulk channel closed');
      },
    });
    const paths: string[] = [];
    const path = await uploadFileWithTransport(
      'node-a',
      'r1',
      '/dest',
      fileOf(10),
      { onPath: (p) => paths.push(p) },
      gw.client,
      { resolveBulk: () => bulk }
    );
    expect(path).toBe('relay');
    expect(paths).toEqual(['direct', 'relay']);
    expect(gw.commits).toEqual(['u2']);
  });

  test('commit 阶段失败不回落（避免重复写入）', async () => {
    let inits = 0;
    const gw = recorder((method, path) => {
      if (method === 'POST' && path === '/api/files/upload/init') {
        inits += 1;
        return json({ uploadId: `u${inits}`, chunkSize: 1024 });
      }
      if (method === 'POST' && path.endsWith('/commit')) {
        return ndjson([{ type: 'error', code: 'rsync_failed', detail: 'boom' }]);
      }
      return null;
    });

    await expect(
      uploadFileWithTransport('node-a', 'r1', '/dest', fileOf(10), {}, gw.client, {
        resolveBulk: () => fakeBulk(),
      })
    ).rejects.toMatchObject({ name: 'FileApiError' });
    expect(inits).toBe(1);
    expect(gw.calls.filter((c) => c.endsWith('/commit'))).toHaveLength(1);
  });

  test('用户取消时直接抛出，不回落 REST', async () => {
    const gw = uploadGateway();
    const controller = new AbortController();
    const bulk = fakeBulk({
      upload: async () => {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
    });
    await expect(
      uploadFileWithTransport(
        'node-a',
        'r1',
        '/dest',
        fileOf(10),
        { signal: controller.signal },
        gw.client,
        { resolveBulk: () => bulk }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(gw.commits).toEqual([]);
    expect(gw.calls.filter((c) => c === 'POST /api/files/upload/init')).toHaveLength(1);
  });

  test('送出字节数与 init 登记的 size 不符时回落 REST（不 commit 截断文件）', async () => {
    const gw = uploadGateway();
    const bulk = fakeBulk({
      upload: async (req) => {
        req.onProgress?.(req.size - 3, req.size); // 少送 3 字节却回 ok
        return { ok: true };
      },
    });
    const path = await uploadFileWithTransport('node-a', 'r1', '/dest', fileOf(20), {}, gw.client, {
      resolveBulk: () => bulk,
    });
    expect(path).toBe('relay');
    expect(gw.calls).toContain('DELETE /api/files/upload/u1');
    expect(gw.commits).toEqual(['u2']);
  });

  test('清理期间用户取消：抛标准 AbortError 而不是原始传输错误', async () => {
    const controller = new AbortController();
    const gw = recorder((method, path) => {
      if (method === 'POST' && path === '/api/files/upload/init') {
        return json({ uploadId: 'u1', chunkSize: 1024 });
      }
      if (method === 'DELETE') {
        controller.abort(); // DELETE 回收期间用户点了取消
        return new Response('', { status: 200 });
      }
      return null;
    });
    const bulk = fakeBulk({
      upload: async () => {
        throw new Error('bulk channel closed');
      },
    });
    await expect(
      uploadFileWithTransport(
        'node-a',
        'r1',
        '/dest',
        fileOf(10),
        { signal: controller.signal },
        gw.client,
        { resolveBulk: () => bulk }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('self 永不走直连', async () => {
    const gw = uploadGateway();
    let resolved = 0;
    const path = await uploadFileWithTransport('self', 'r1', '/dest', fileOf(10), {}, gw.client, {
      resolveBulk: () => {
        resolved += 1;
        return fakeBulk();
      },
    });
    expect(path).toBe('relay');
    expect(resolved).toBe(0);
    expect(gw.calls).toContain('PUT /api/files/upload/u1?offset=0');
  });

  test('直连未就绪（isAvailable=false）时走 REST', async () => {
    const gw = uploadGateway();
    const path = await uploadFileWithTransport('node-a', 'r1', '/dest', fileOf(10), {}, gw.client, {
      resolveBulk: () => fakeBulk({ isAvailable: () => false }),
    });
    expect(path).toBe('relay');
    expect(gw.calls).toContain('PUT /api/files/upload/u1?offset=0');
  });

  test('没有登记 bulk client 时走 REST', async () => {
    const gw = uploadGateway();
    const path = await uploadFileWithTransport('node-a', 'r1', '/dest', fileOf(10), {}, gw.client, {
      resolveBulk: () => null,
    });
    expect(path).toBe('relay');
    expect(gw.commits).toEqual(['u1']);
  });
});

function downloadGateway(size: number): Recorded {
  return recorder((method, path) => {
    if (method === 'POST' && path === '/api/files/download/prepare') {
      return ndjson([
        { type: 'progress', pct: 50, transferred: size / 2 },
        { type: 'done', downloadId: 'd1', size, name: 'a.bin' },
      ]);
    }
    if (method === 'GET' && path === '/api/files/download/d1/content') {
      return new Response(new Uint8Array(size).fill(9), {
        status: 200,
        headers: { 'Content-Length': String(size) },
      });
    }
    return null;
  });
}

describe('downloadFileWithTransport', () => {
  test('直连可用时走 bulk：prepare 后直接收流，不打 /content', async () => {
    const gw = downloadGateway(8);
    const bulk = fakeBulk({
      download: (req) => {
        expect(req.transferId).toBe('d1');
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4).fill(1));
            controller.enqueue(new Uint8Array(4).fill(2));
            controller.close();
          },
        });
      },
    });

    const file = await downloadFileWithTransport('node-a', 'r1', '/a.bin', 'a.bin', {}, gw.client, {
      resolveBulk: () => bulk,
    });

    expect(file.transferPath).toBe('direct');
    expect(file.name).toBe('a.bin');
    expect(await blobBytes(file.blob)).toEqual(new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2]));
    expect(gw.calls).toEqual(['POST /api/files/download/prepare']);
  });

  test('bulk 收流失败时回收会话并整次改走 REST', async () => {
    const gw = downloadGateway(6);
    const paths: string[] = [];
    const bulk = fakeBulk({
      download: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('bulk channel closed'));
          },
        }),
    });

    const file = await downloadFileWithTransport(
      'node-a',
      'r1',
      '/a.bin',
      'a.bin',
      { onPath: (p) => paths.push(p) },
      gw.client,
      { resolveBulk: () => bulk }
    );

    expect(file.transferPath).toBe('relay');
    expect(await blobBytes(file.blob)).toEqual(new Uint8Array(6).fill(9));
    expect(paths).toEqual(['direct', 'relay']);
    expect(gw.calls).toEqual([
      'POST /api/files/download/prepare',
      'DELETE /api/files/download/d1',
      'POST /api/files/download/prepare',
      'GET /api/files/download/d1/content',
    ]);
  });

  test('用户取消时直接抛出，不回落 REST', async () => {
    const gw = downloadGateway(4);
    const controller = new AbortController();
    const bulk = fakeBulk({
      download: () =>
        new ReadableStream<Uint8Array>({
          start(streamController) {
            controller.abort();
            streamController.error(new DOMException('Aborted', 'AbortError'));
          },
        }),
    });
    await expect(
      downloadFileWithTransport(
        'node-a',
        'r1',
        '/a.bin',
        'a.bin',
        { signal: controller.signal },
        gw.client,
        { resolveBulk: () => bulk }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(gw.calls.filter((c) => c.includes('/content'))).toHaveLength(0);
  });

  test('收到的字节超过 prepare 声明的 size：取消流并整次回落 REST', async () => {
    const gw = downloadGateway(4);
    let canceled = 0;
    const bulk = fakeBulk({
      download: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(8).fill(1)); // 声明 4 字节却狂灌
          },
          cancel() {
            canceled += 1;
          },
        }),
    });

    const file = await downloadFileWithTransport('node-a', 'r1', '/a.bin', 'a.bin', {}, gw.client, {
      resolveBulk: () => bulk,
    });

    expect(file.transferPath).toBe('relay');
    expect(canceled).toBe(1);
    expect(await blobBytes(file.blob)).toEqual(new Uint8Array(4).fill(9));
    expect(gw.calls).toEqual([
      'POST /api/files/download/prepare',
      'DELETE /api/files/download/d1',
      'POST /api/files/download/prepare',
      'GET /api/files/download/d1/content',
    ]);
  });

  test('node 提前 eof（字节数不足）：当作 bulk 失败重新 prepare 走 REST', async () => {
    const gw = downloadGateway(6);
    const bulk = fakeBulk({
      download: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(2).fill(1));
            controller.close();
          },
        }),
    });

    const file = await downloadFileWithTransport('node-a', 'r1', '/a.bin', 'a.bin', {}, gw.client, {
      resolveBulk: () => bulk,
    });

    expect(file.transferPath).toBe('relay');
    // 截断内容不得作为结果返回
    expect(await blobBytes(file.blob)).toEqual(new Uint8Array(6).fill(9));
    expect(gw.calls).toContain('DELETE /api/files/download/d1');
  });

  test('清理期间用户取消：抛标准 AbortError 而不是原始传输错误', async () => {
    const controller = new AbortController();
    const gw = recorder((method, path) => {
      if (method === 'POST' && path === '/api/files/download/prepare') {
        return ndjson([{ type: 'done', downloadId: 'd1', size: 4, name: 'a.bin' }]);
      }
      if (method === 'DELETE') {
        controller.abort();
        return new Response('', { status: 200 });
      }
      return null;
    });
    const bulk = fakeBulk({
      download: () =>
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.error(new Error('bulk channel closed'));
          },
        }),
    });

    await expect(
      downloadFileWithTransport(
        'node-a',
        'r1',
        '/a.bin',
        'a.bin',
        { signal: controller.signal },
        gw.client,
        { resolveBulk: () => bulk }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(gw.calls.filter((c) => c.includes('/content'))).toHaveLength(0);
  });

  test('self 永不走直连', async () => {
    const gw = downloadGateway(4);
    let resolved = 0;
    const file = await downloadFileWithTransport('self', 'r1', '/a.bin', 'a.bin', {}, gw.client, {
      resolveBulk: () => {
        resolved += 1;
        return fakeBulk();
      },
    });
    expect(file.transferPath).toBe('relay');
    expect(resolved).toBe(0);
    expect(gw.calls).toEqual([
      'POST /api/files/download/prepare',
      'GET /api/files/download/d1/content',
    ]);
  });
});
