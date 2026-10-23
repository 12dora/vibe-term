import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { FileApiError, TransferInterruptedError } from './file-errors';
import { type ContentFetchInput, fetchContentBlob } from './ranged-download';

type Fault =
  | { kind: 'reject' }
  | { kind: 'status'; status: number }
  | { kind: 'cut'; after: number };

interface Req {
  index: number;
  start: number;
  end: number;
  ranged: boolean;
  openEnded: boolean;
  ifRange: string | null;
}

interface ServerOpts {
  etag?: string | null;
  ranges?: boolean;
  delayMs?: number;
  fault?: (req: Req) => Fault | undefined;
  /** 第 n 个请求开始时把源文件换成新 etag。 */
  changeEtagAt?: number;
  /** 模拟截短区间长度的代理：每个 206 最多回这么多字节。 */
  capBytes?: number;
}

function makeData(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => (i * 7 + 3) % 251);
}

function parseRange(header: string | null, size: number) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(header ?? '');
  if (!m) return null;
  return { start: Number(m[1]), end: m[2] === '' ? size - 1 : Number(m[2]) };
}

function slicedBody(data: Uint8Array, cutAfter: number | null): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cutAfter !== null && sent >= cutAfter) {
        controller.error(new TypeError('connection reset'));
        return;
      }
      if (sent >= data.byteLength) {
        controller.close();
        return;
      }
      const limit = cutAfter === null ? data.byteLength : Math.min(cutAfter, data.byteLength);
      const next = Math.min(sent + 4, limit);
      controller.enqueue(data.slice(sent, next));
      sent = next;
    },
  });
}

function createServer(data: Uint8Array, opts: ServerOpts = {}) {
  const requests: Req[] = [];
  const signals: AbortSignal[] = [];
  let etag = opts.etag === undefined ? '"v1"' : opts.etag;
  let inflight = 0;
  let maxInflight = 0;
  const fetchLike = async (_url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const range = parseRange(headers.get('Range'), data.byteLength);
    const req: Req = {
      index: requests.length,
      start: range?.start ?? 0,
      end: range?.end ?? data.byteLength - 1,
      ranged: headers.has('Range'),
      openEnded: /^bytes=\d+-$/.test(headers.get('Range') ?? ''),
      ifRange: headers.get('If-Range'),
    };
    requests.push(req);
    if (init?.signal) signals.push(init.signal);
    if (opts.changeEtagAt === req.index) etag = '"v2"';
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const fault = opts.fault?.(req);
      if (fault?.kind === 'reject') throw new TypeError('network error');
      if (fault?.kind === 'status') {
        return new Response(JSON.stringify({ error: 'x', code: 'not_found' }), {
          status: fault.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const base: Record<string, string> = etag ? { ETag: etag } : {};
      const cut = fault?.kind === 'cut' ? fault.after : null;
      const useRange = opts.ranges !== false && range !== null;
      const stale = useRange && req.ifRange !== null && req.ifRange !== etag;
      if (!useRange || stale) {
        return new Response(slicedBody(data, cut), { status: 200, headers: base });
      }
      const end = opts.capBytes ? Math.min(range.end, range.start + opts.capBytes - 1) : range.end;
      const body = data.slice(range.start, end + 1);
      return new Response(slicedBody(body, cut), {
        status: 206,
        headers: {
          ...base,
          'Content-Range': `bytes ${range.start}-${end}/${data.byteLength}`,
        },
      });
    } finally {
      inflight -= 1;
    }
  };
  return { fetchLike, requests, signals, maxInflight: () => maxInflight };
}

function run(
  data: Uint8Array,
  server: ReturnType<typeof createServer>,
  extra: Partial<ContentFetchInput> = {}
) {
  const progress: number[] = [];
  const slept: number[] = [];
  const promise = fetchContentBlob({
    client: new ApiClient('', server.fetchLike),
    downloadId: 'dl-1',
    size: data.byteLength,
    streams: 3,
    chunkBytes: 10,
    sleep: async (ms) => {
      slept.push(ms);
    },
    onProgress: (n) => progress.push(n),
    ...extra,
  });
  return { promise, progress, slept };
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

describe('fetchContentBlob 并行 Range', () => {
  test('多个区间并行拉取，按顺序精确拼装；首个区间先单独探测并取得 ETag', async () => {
    const data = makeData(35);
    const server = createServer(data, { delayMs: 5 });
    const { promise, progress } = run(data, server);

    expect(await bytesOf(await promise)).toEqual(Array.from(data));
    const sorted = [...server.requests].sort((a, b) => a.start - b.start);
    expect(sorted.map((r) => [r.start, r.end])).toEqual([
      [0, 9],
      [10, 19],
      [20, 29],
      [30, 34],
    ]);
    // 探测请求在前，不带 If-Range；其余带探测拿到的 ETag
    expect(server.requests[0].start).toBe(0);
    expect(server.requests[0].ifRange).toBeNull();
    expect(server.requests.slice(1).every((r) => r.ifRange === '"v1"')).toBe(true);
    expect(server.maxInflight()).toBeGreaterThan(1);
    expect(server.maxInflight()).toBeLessThanOrEqual(3);
    // 进度单调不减，且恰好落在总量
    expect(progress.every((n, i) => i === 0 || n >= progress[i - 1])).toBe(true);
    expect(progress[progress.length - 1]).toBe(35);
  });

  test('区间中途被切断：从该区间自己已收偏移续传，已收字节不丢也不重复计数', async () => {
    const data = makeData(35);
    const server = createServer(data, {
      fault: (r) => (r.start === 10 && r.index === 1 ? { kind: 'cut', after: 4 } : undefined),
    });
    const { promise, progress } = run(data, server);

    expect(await bytesOf(await promise)).toEqual(Array.from(data));
    const resumed = server.requests.find((r) => r.start === 14);
    expect(resumed).toMatchObject({ start: 14, end: 19, ranged: true, openEnded: false });
    expect(Math.max(...progress)).toBe(35);
    expect(progress.every((n, i) => i === 0 || n >= progress[i - 1])).toBe(true);
  });

  test('只要请求送达过字节就清零失败计数：反复被切也不会放弃', async () => {
    const data = makeData(25);
    let cuts = 0;
    const server = createServer(data, {
      fault: (r) => {
        if (r.start >= 10 && r.start < 20 && cuts < 8) {
          cuts += 1;
          return { kind: 'cut', after: 1 };
        }
        return undefined;
      },
    });
    const { promise, slept } = run(data, server, { streams: 2 });
    expect(await bytesOf(await promise)).toEqual(Array.from(data));
    expect(cuts).toBe(8);
    expect(slept).toEqual([]);
  });

  test('对端对 Range 回 200：退回单条顺序流，整份取回', async () => {
    const data = makeData(35);
    const server = createServer(data, { ranges: false });
    const { promise, progress } = run(data, server);

    expect(await bytesOf(await promise)).toEqual(Array.from(data));
    // 一次探测 + 一条不带 Range 的顺序流
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0].ranged).toBe(true);
    expect(server.requests[1].ranged).toBe(false);
    expect(progress[progress.length - 1]).toBe(35);
  });

  test('顺序流断线后用开放区间续传；对端仍回 200 就整份重来，进度回到 0 重新计', async () => {
    const data = makeData(35);
    const server = createServer(data, {
      ranges: false,
      fault: (r) => (r.index === 1 ? { kind: 'cut', after: 8 } : undefined),
    });
    const { promise, progress } = run(data, server);

    expect(await bytesOf(await promise)).toEqual(Array.from(data));
    const resume = server.requests[2];
    expect(resume).toMatchObject({ ranged: true, openEnded: true, start: 8 });
    expect(progress).toContain(8);
    expect(progress).toContain(0);
    expect(progress[progress.length - 1]).toBe(35);
  });

  test('streams<=1 或不足一个区间：直接顺序流，不探测', async () => {
    const data = makeData(35);
    const single = createServer(data);
    expect(await bytesOf(await run(data, single, { streams: 1 }).promise)).toEqual(
      Array.from(data)
    );
    expect(single.requests).toHaveLength(1);
    expect(single.requests[0].ranged).toBe(false);

    const small = createServer(data);
    await run(data, small, { chunkBytes: 100 }).promise;
    expect(small.requests).toHaveLength(1);
    expect(small.requests[0].ranged).toBe(false);
  });

  test('源文件在下载中途变化：If-Range 不匹配得到 200，抛 invalid / source changed', async () => {
    const data = makeData(35);
    const server = createServer(data, { changeEtagAt: 1 });
    const { promise } = run(data, server);

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FileApiError);
    expect(error).toMatchObject({ code: 'invalid', detail: 'source changed' });
  });

  test('代理把区间截短：按已收偏移继续补齐，结果精确', async () => {
    const data = makeData(35);
    const server = createServer(data, { capBytes: 4 });
    const { promise, slept } = run(data, server);

    expect(await bytesOf(await promise)).toEqual(Array.from(data));
    expect(slept).toEqual([]);
  });

  test('206 的 Content-Range 对不上号：退回顺序流而不是失败', async () => {
    const data = makeData(35);
    const requests: Array<string | null> = [];
    const fetchLike = async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range');
      requests.push(range);
      if (!range) return new Response(data, { status: 200 });
      return new Response(data.slice(0, 10), {
        status: 206,
        headers: { 'Content-Range': 'bytes 5-14/35' },
      });
    };
    const blob = await fetchContentBlob({
      client: new ApiClient('', fetchLike),
      downloadId: 'dl-1',
      size: 35,
      streams: 3,
      chunkBytes: 10,
      onProgress: () => {},
    });
    expect(await bytesOf(blob)).toEqual(Array.from(data));
    expect(requests).toEqual(['bytes=0-9', null]);
  });
});

describe('fetchContentBlob 与宿主请求门', () => {
  test('所有内容请求都标 purpose: transfer：退避中的 node 也不会短路下载', async () => {
    const data = makeData(35);
    const server = createServer(data);
    const seen: Array<string | undefined> = [];
    const client = new ApiClient('', server.fetchLike, {
      admit: ({ method, purpose }) => {
        seen.push(purpose);
        // 模拟退避窗口：非传输的读一律短路
        if (method === 'GET' && purpose !== 'transfer') throw new Error('backoff');
      },
    });

    const blob = await fetchContentBlob({
      client,
      downloadId: 'dl-1',
      size: 35,
      streams: 3,
      chunkBytes: 10,
      onProgress: () => {},
    });
    expect(await bytesOf(blob)).toEqual(Array.from(data));
    expect(seen).toHaveLength(4);
    expect(seen.every((p) => p === 'transfer')).toBe(true);
  });
});

describe('fetchContentBlob 重试与错误', () => {
  test('连续 4 次一字节没送达：放弃并抛 TransferInterruptedError，退避 500/1000/2000', async () => {
    const data = makeData(35);
    const server = createServer(data, { fault: () => ({ kind: 'reject' }) });
    const { promise, slept } = run(data, server);

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferInterruptedError);
    expect(error).toMatchObject({ name: 'TransferInterruptedError', receivedBytes: 0 });
    expect((error as TransferInterruptedError).totalBytes).toBe(35);
    expect(server.requests).toHaveLength(4);
    expect(slept).toEqual([500, 1000, 2000]);
  });

  test('永久性 4xx 立即失败，不重试', async () => {
    for (const status of [404, 410, 416]) {
      const data = makeData(35);
      const server = createServer(data, { fault: () => ({ kind: 'status', status }) });
      const { promise, slept } = run(data, server);
      await expect(promise).rejects.toMatchObject({ status, code: 'not_found' });
      expect(server.requests).toHaveLength(1);
      expect(slept).toEqual([]);
    }
  });

  test('408 / 429 / 5xx 按可重试处理；恢复后正常完成', async () => {
    for (const status of [408, 429, 503]) {
      const data = makeData(35);
      const server = createServer(data, {
        fault: (r) => (r.index === 0 ? { kind: 'status', status } : undefined),
      });
      const { promise, slept } = run(data, server);
      expect(await bytesOf(await promise)).toEqual(Array.from(data));
      expect(slept).toEqual([500]);
    }
  });

  test('5xx 一直不恢复：上抛服务端给的错误而不是「传输中断」', async () => {
    const data = makeData(35);
    const server = createServer(data, { fault: () => ({ kind: 'status', status: 503 }) });
    const { promise } = run(data, server);
    await expect(promise).rejects.toMatchObject({ status: 503, code: 'not_found' });
    expect(server.requests).toHaveLength(4);
  });

  test('顺序流每次都在同一偏移断掉：不算有进展，按退避放弃而不是无休止空转', async () => {
    const data = makeData(35);
    const server = createServer(data, {
      ranges: false,
      fault: (r) => (r.index >= 1 ? { kind: 'cut', after: 8 } : undefined),
    });
    const { promise, slept } = run(data, server);

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferInterruptedError);
    expect(slept).toEqual([500, 1000, 2000]);
    expect(server.requests).toHaveLength(6);
  });

  test('空体响应算无进展的失败', async () => {
    const data = makeData(10);
    let calls = 0;
    const fetchLike = async () => {
      calls += 1;
      return new Response(new Uint8Array(0), { status: 200 });
    };
    const error = await fetchContentBlob({
      client: new ApiClient('', fetchLike),
      downloadId: 'dl-1',
      size: 10,
      streams: 1,
      sleep: async () => {},
      onProgress: () => {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferInterruptedError);
    expect(calls).toBe(4);
  });

  test('取消：所有在飞请求立刻中止并抛 AbortError', async () => {
    const data = makeData(35);
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const fetchLike = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal) signals.push(init.signal);
        init?.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
        setTimeout(() => controller.abort(), 5);
      });
    const error = await fetchContentBlob({
      client: new ApiClient('', fetchLike),
      downloadId: 'dl-1',
      size: data.byteLength,
      streams: 3,
      chunkBytes: 10,
      signal: controller.signal,
      onProgress: () => {},
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  test('取消发生在读响应体中途：不再发新请求，抛 AbortError', async () => {
    const data = makeData(35);
    const controller = new AbortController();
    const server = createServer(data, { delayMs: 2 });
    const { promise } = run(data, server, {
      signal: controller.signal,
      onProgress: (n) => {
        if (n >= 4) controller.abort();
      },
    });
    const error = await promise.catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(server.requests.length).toBeLessThanOrEqual(1);
  });
});
