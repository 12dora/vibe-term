import { describe, expect, mock, test } from 'bun:test';
import { ApiClient } from './client';
import { uploadFileChunked } from './files';

function ndjsonText(lines: object[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

const PUT_URL = /\/api\/files\/upload\/([^/?]+)\?offset=(\d+)$/;

describe('uploadFileChunked', () => {
  test('按 chunkSize 顺序 PUT 分块，并透传 commit 的两段进度', async () => {
    const puts: Array<{ offset: number; size: number }> = [];
    const progress: Array<{ leg: 1 | 2; pct: number }> = [];
    const file = new File([new Uint8Array(10).fill(1)], 'a.bin');

    const transport = mock(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/files/upload/init')) {
        return new Response(JSON.stringify({ uploadId: 'up-1', chunkSize: 4 }), { status: 200 });
      }
      const put = PUT_URL.exec(input);
      if (put && init?.method === 'PUT') {
        puts.push({ offset: Number(put[2]), size: (init.body as Blob).size });
        return new Response(null, { status: 200 });
      }
      if (input.endsWith('/api/files/upload/up-1/commit')) {
        return new Response(
          ndjsonText([
            { type: 'progress', transferred: 5, pct: 50, rate: '1 B/s' },
            { type: 'done', uploaded: '/dest/a.bin' },
          ]),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch ${input} ${init?.method ?? 'GET'}`);
    });

    await uploadFileChunked(
      'root-1',
      '/dest',
      file,
      {
        onLeg: (leg, p) => {
          progress.push({ leg, pct: p.pct });
        },
      },
      new ApiClient('', transport)
    );

    expect(puts).toEqual([
      { offset: 0, size: 4 },
      { offset: 4, size: 4 },
      { offset: 8, size: 2 },
    ]);
    expect(progress.filter((p) => p.leg === 1).at(-1)?.pct).toBe(100);
    expect(progress.some((p) => p.leg === 2 && p.pct === 50)).toBe(true);
    expect(progress.at(-1)).toEqual({ leg: 2, pct: 100 });
  });

  test('commit 报 error 事件时抛 FileApiError 并清理上传会话', async () => {
    const deleted: string[] = [];
    const transport = mock(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/files/upload/init')) {
        return new Response(JSON.stringify({ uploadId: 'up-2', chunkSize: 0 }), { status: 200 });
      }
      if (PUT_URL.test(input)) return new Response(null, { status: 200 });
      if (input.endsWith('/api/files/upload/up-2/commit')) {
        return new Response(ndjsonText([{ type: 'error', code: 'rsync_failed', detail: 'gone' }]), {
          status: 200,
        });
      }
      if (input.endsWith('/api/files/upload/up-2') && init?.method === 'DELETE') {
        deleted.push(input);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch ${input}`);
    });

    const file = new File([new Uint8Array(3)], 'b.bin');
    await expect(
      uploadFileChunked('root-1', '/dest', file, {}, new ApiClient('http://gw', transport))
    ).rejects.toMatchObject({ status: 500, message: 'gone' });
    expect(deleted).toEqual(['http://gw/api/files/upload/up-2']);
  });

  test('commit 流缺少 done 事件视为失败，同样清理上传会话', async () => {
    const deleted: string[] = [];
    const transport = mock(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/files/upload/init')) {
        return new Response(JSON.stringify({ uploadId: 'up-3', chunkSize: 8 }), { status: 200 });
      }
      if (PUT_URL.test(input)) return new Response(null, { status: 200 });
      if (input.endsWith('/api/files/upload/up-3/commit')) {
        return new Response(ndjsonText([{ type: 'progress', transferred: 1, pct: 10, rate: '' }]), {
          status: 200,
        });
      }
      if (input.endsWith('/api/files/upload/up-3') && init?.method === 'DELETE') {
        deleted.push(input);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch ${input}`);
    });

    const file = new File([new Uint8Array(2)], 'c.bin');
    await expect(
      uploadFileChunked('root-1', '/dest', file, {}, new ApiClient('', transport))
    ).rejects.toMatchObject({ status: 500, code: 'unknown' });
    expect(deleted).toEqual(['/api/files/upload/up-3']);
  });

  test('已取消的 signal 不发起分块 PUT，直接清理会话', async () => {
    const calls: string[] = [];
    const transport = mock(async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${input}`);
      if (input.endsWith('/api/files/upload/init')) {
        return new Response(JSON.stringify({ uploadId: 'up-4', chunkSize: 4 }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    const controller = new AbortController();
    controller.abort();
    const file = new File([new Uint8Array(6)], 'd.bin');

    await expect(
      uploadFileChunked(
        'root-1',
        '/dest',
        file,
        { signal: controller.signal },
        new ApiClient('', transport)
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual(['POST /api/files/upload/init', 'DELETE /api/files/upload/up-4']);
  });
});
