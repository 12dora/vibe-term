import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ApiClient } from './client';
import { FakeXhr, resetFakeXhr } from './fake-xhr.testing';
import { uploadFileChunked } from './files';
import type { LegProgress } from './transfer-types';

function ndjsonText(lines: object[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

const PUT_URL = /\/api\/files\/upload\/([^/?]+)\?offset=(\d+)&length=(\d+)$/;

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

    expect(puts.slice().sort((a, b) => a.offset - b.offset)).toEqual([
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
    ).rejects.toMatchObject({ name: 'TransferInterruptedError', receivedBytes: 2, totalBytes: 2 });
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

describe('uploadFileChunked 的取消与期限', () => {
  test('PUT 挂在本轮派生的信号上：用户取消时在飞的请求立刻被中止', async () => {
    const putSignals: Array<AbortSignal | undefined | null> = [];
    const controller = new AbortController();
    const deleted: string[] = [];
    const transport = mock(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/files/upload/init')) {
        return new Response(JSON.stringify({ uploadId: 'up-5', chunkSize: 4, ranged: true }), {
          status: 200,
        });
      }
      if (input.endsWith('/api/files/upload/up-5') && init?.method === 'DELETE') {
        deleted.push(input);
        return new Response(null, { status: 204 });
      }
      if (PUT_URL.test(input) && init?.method === 'PUT') {
        putSignals.push(init.signal);
        controller.abort();
        return new Promise<Response>((_resolve, reject) => {
          const fail = () => reject(new DOMException('Aborted', 'AbortError'));
          if (init.signal?.aborted) fail();
          else init.signal?.addEventListener('abort', fail, { once: true });
        });
      }
      throw new Error(`unexpected fetch ${input}`);
    });

    const file = new File([new Uint8Array(8)], 'e.bin');
    await expect(
      uploadFileChunked(
        'root-1',
        '/dest',
        file,
        { signal: controller.signal, streams: 1 },
        new ApiClient('', transport)
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(putSignals.length).toBeGreaterThan(0);
    // 派生信号，不是调用方那个；被中止后请求不会继续挂着
    expect(putSignals[0]).not.toBe(controller.signal);
    expect(putSignals[0]?.aborted).toBe(true);
    expect(deleted).toEqual(['/api/files/upload/up-5']);
  });
});

describe('uploadFileChunked 两段权重', () => {
  async function weightsFor(init: object): Promise<Array<readonly [number, number]>> {
    const transport = mock(async (input: string) => {
      if (input.endsWith('/api/files/upload/init')) {
        return new Response(JSON.stringify({ uploadId: 'up-w', chunkSize: 4, ...init }), {
          status: 200,
        });
      }
      if (PUT_URL.test(input)) return new Response(null, { status: 200 });
      if (input.endsWith('/commit')) {
        return new Response(ndjsonText([{ type: 'done', uploaded: '/d/w.bin' }]), { status: 200 });
      }
      throw new Error(`unexpected fetch ${input}`);
    });
    const seen: Array<readonly [number, number]> = [];
    await uploadFileChunked(
      'root-1',
      '/dest',
      new File([new Uint8Array(3)], 'w.bin'),
      { onLegWeights: (w) => seen.push(w) },
      new ApiClient('', transport)
    );
    return seen;
  }

  test('init 之后立刻给权重；服务端声明不推 commit 进度时 leg2 权重为 0', async () => {
    expect(await weightsFor({})).toEqual([[1, 1]]);
    expect(await weightsFor({ commitProgress: true })).toEqual([[1, 1]]);
    expect(await weightsFor({ commitProgress: false })).toEqual([[1, 0]]);
  });
});

describe('uploadFileChunked 字节级进度', () => {
  const originalXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetFakeXhr();
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  });

  afterEach(() => {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = originalXhr;
    globalThis.fetch = originalFetch;
  });

  function stubGateway(commitEvents: object[], chunkSize = 8): void {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/files/upload/init')) {
        return new Response(JSON.stringify({ uploadId: 'up-x', chunkSize, ranged: true }), {
          status: 200,
        });
      }
      if (url.endsWith('/commit')) return new Response(ndjsonText(commitEvents), { status: 200 });
      if (/\/api\/files\/upload\/up-x$/.test(url)) {
        return new Response(JSON.stringify({ received: 0, ranges: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as never;
  }

  test('XHR 上行字节作为区间内进度转发：bytes 精确、单调，整块落地后才到 100%', async () => {
    stubGateway([
      { type: 'progress', transferred: 4, pct: 50, rate: '1 B/s' },
      { type: 'done', uploaded: '/d/a.bin' },
    ]);
    resetFakeXhr(() => ({ progress: [2, 5, 8], status: 200 }));
    const legs: Array<[1 | 2, LegProgress]> = [];

    await uploadFileChunked(
      'root-1',
      '/d',
      new File([new Uint8Array(8)], 'a.bin'),
      { onLeg: (leg, p) => legs.push([leg, p]) },
      new ApiClient('')
    );

    expect(FakeXhr.instances).toHaveLength(1);
    expect(FakeXhr.instances[0].url).toContain('/api/files/upload/up-x?offset=0&length=8');
    const leg1 = legs.filter(([leg]) => leg === 1).map(([, p]) => p);
    expect(leg1.map((p) => p.bytes)).toEqual([0, 0, 2, 5, 8, 8, 8]);
    expect(leg1.every((p) => p.totalBytes === 8)).toBe(true);
    // 字节全部发出、整段确认收尾之前最多 99%
    expect(leg1.map((p) => p.pct)).toEqual([0, 0, 25, 62, 99, 99, 100]);
    const leg2 = legs.filter(([leg]) => leg === 2).map(([, p]) => p);
    expect(leg2.some((p) => p.bytes === 4 && p.totalBytes === 8)).toBe(true);
    expect(leg2.at(-1)).toMatchObject({ pct: 100, bytes: 8, totalBytes: 8 });
  });

  test('一次尝试失败：该区间已报字节回滚，总数不超过落地 + 在飞，重试后完成', async () => {
    stubGateway([{ type: 'done', uploaded: '/d/b.bin' }]);
    let puts = 0;
    resetFakeXhr(() => {
      puts += 1;
      return puts === 1 ? { progress: [6], outcome: 'error' } : { progress: [3, 8], status: 200 };
    });
    const bytes: number[] = [];

    await uploadFileChunked(
      'root-1',
      '/d',
      new File([new Uint8Array(8)], 'b.bin'),
      { onLeg: (leg, p) => leg === 1 && bytes.push(p.bytes ?? -1) },
      new ApiClient('')
    );

    const peak = bytes.indexOf(6);
    expect(peak).toBeGreaterThan(-1);
    // 失败后立刻回到 0，而不是停在 6 直到重试
    expect(bytes[peak + 1]).toBe(0);
    expect(Math.max(...bytes)).toBe(8);
    expect(bytes.at(-1)).toBe(8);
  });

  test('PUT 被永久拒绝（413）：抛服务端给的 FileApiError，不包成传输中断', async () => {
    stubGateway([]);
    resetFakeXhr(() => ({
      status: 413,
      body: JSON.stringify({ error: 'too_large', code: 'too_large' }),
    }));

    await expect(
      uploadFileChunked(
        'root-1',
        '/d',
        new File([new Uint8Array(8)], 'c.bin'),
        {},
        new ApiClient('')
      )
    ).rejects.toMatchObject({ name: 'FileApiError', status: 413, code: 'too_large' });
  });
  test('并行流里一条被永久拒绝（403）：其余在飞请求被收掉，用户看到的仍是 403 而不是传输中断', async () => {
    stubGateway([], 2);
    resetFakeXhr(async (xhr) => {
      if (xhr.url.includes('offset=0&')) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          status: 403,
          body: JSON.stringify({ error: 'permission_denied', code: 'permission_denied' }),
        };
      }
      return { outcome: 'hang' };
    });

    const error = await uploadFileChunked(
      'root-1',
      '/d',
      new File([new Uint8Array(8)], 'd.bin'),
      { streams: 4 },
      new ApiClient('')
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({ name: 'FileApiError', status: 403, code: 'permission_denied' });
    expect(FakeXhr.instances.length).toBe(4);
    expect(FakeXhr.instances.filter((x) => x.aborted).length).toBe(3);
  });

  test('init 阶段断网：抛 TransferInterruptedError 而不是裸 TypeError', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as never;
    const error = await uploadFileChunked(
      'root-1',
      '/d',
      new File([new Uint8Array(8)], 'e.bin'),
      {},
      new ApiClient('')
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TransferInterruptedError', totalBytes: 8 });
  });

  test('commit 流没有 done 就结束：抛 TransferInterruptedError', async () => {
    stubGateway([{ type: 'progress', transferred: 1, pct: 10, rate: '' }]);
    resetFakeXhr(() => ({ status: 200 }));
    const error = await uploadFileChunked(
      'root-1',
      '/d',
      new File([new Uint8Array(8)], 'f.bin'),
      {},
      new ApiClient('')
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TransferInterruptedError', receivedBytes: 8 });
  });
  test('node 在退避窗口里：状态查询仍被放行，断线后只补缺口而不是从 0 重推', async () => {
    stubGateway([{ type: 'done', uploaded: '/d/g.bin' }], 2);
    const offsets: number[] = [];
    let puts = 0;
    resetFakeXhr((xhr) => {
      offsets.push(Number(/offset=(\d+)/.exec(xhr.url)?.[1]));
      puts += 1;
      return puts === 2 ? { outcome: 'error' } : { status: 200 };
    });
    const admitted: Array<string | undefined> = [];
    // 模拟宿主的退避门：退避窗口里普通 GET 一律短路，传输请求放行
    const client = new ApiClient('', undefined, {
      admit: ({ method, purpose }) => {
        admitted.push(`${method}:${purpose ?? '-'}`);
        if (method === 'GET' && purpose !== 'transfer') throw new Error('backoff');
      },
    });
    const base = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      if (/\/api\/files\/upload\/up-x$/.test(String(input)) && init?.method !== 'DELETE') {
        return new Response(JSON.stringify({ received: 2, ranges: [[0, 2]] }), { status: 200 });
      }
      return base(input, init);
    }) as never;

    await uploadFileChunked(
      'root-1',
      '/d',
      new File([new Uint8Array(4)], 'g.bin'),
      { streams: 1 },
      client
    );

    // 第一轮 0、2（2 失败），第二轮靠状态查询得知 [0,2) 已落地，只补 2
    expect(offsets).toEqual([0, 2, 2]);
    expect(admitted).toContain('GET:transfer');
  });
});
