import { describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import { Forwarder } from './forwarder';
import {
  ENTITY_LENGTH_HEADER,
  RESUME_BACKOFF_MS,
  continuationHeaders,
  resumePlanFrom,
  verifyContinuation,
  wrapForwardedBody,
} from './forwarder-resume';

const NODE = '5b49abcd'.repeat(4);
const PATH = '/api/files/download/file-1/content';
const FILE = new TextEncoder().encode('0123456789');
const TRANSPORT = new Error('http stream aborted');

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readAll(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return concat(chunks);
    if (value) chunks.push(value);
  }
}

function bodyThenError(prefix: Uint8Array, err: Error = TRANSPORT): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        if (prefix.byteLength > 0) controller.enqueue(prefix);
        return;
      }
      controller.error(err);
    },
  });
}

function bodyOf(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (data.byteLength > 0) controller.enqueue(data);
      controller.close();
    },
  });
}

function emptyThenError(err: Error = TRANSPORT): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      controller.error(err);
    },
  });
}

function resume206(
  start: number,
  end: number,
  total: number,
  data: ReadableStream<Uint8Array> | Uint8Array
) {
  const body = data instanceof Uint8Array ? bodyOf(data) : data;
  return new Response(body, {
    status: 206,
    headers: {
      'content-range': `bytes ${start}-${end}/${total}`,
      etag: '"v1"',
      'accept-ranges': 'bytes',
    },
  });
}

type OpenCall = { headers: Record<string, string> };

function wrap(opts: {
  status: number;
  headers: HeadersInit;
  body: ReadableStream<Uint8Array> | null;
  req?: Request;
  method?: string;
  open?: (headers: Record<string, string>, signal: AbortSignal) => Promise<Response>;
  opens?: OpenCall[];
  logs?: string[];
  sleeps?: number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Response {
  const opens = opts.opens ?? [];
  const logs = opts.logs ?? [];
  const sleeps = opts.sleeps ?? [];
  const req = opts.req ?? new Request(`http://localhost/n/${NODE}${PATH}`, { method: 'GET' });
  return wrapForwardedBody({
    req,
    upstream: new Response(opts.body, { status: opts.status, headers: opts.headers }),
    clientHeaders: new Headers(opts.headers),
    method: opts.method ?? 'GET',
    nodeId: NODE,
    path: PATH,
    dispatchHeaders: { accept: '*/*' },
    signal: req.signal,
    log: (line) => logs.push(line),
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (opts.sleep) await opts.sleep(ms, signal);
    },
    open: async (headers, signal) => {
      opens.push({ headers });
      if (opts.open) return opts.open(headers, signal);
      throw new Error('unexpected resume');
    },
  });
}

const resumable200 = {
  'content-length': '10',
  'accept-ranges': 'bytes',
  etag: '"v1"',
};

describe('resumePlanFrom', () => {
  test('GET 200 需要 accept-ranges、强校验器和已知长度', () => {
    expect(resumePlanFrom('GET', 200, new Headers({ ...resumable200 }))).toEqual({
      start: 0,
      end: 9,
      total: 10,
      validator: { header: 'etag', value: '"v1"' },
    });
    expect(resumePlanFrom('POST', 200, new Headers({ ...resumable200 }))).toBeNull();
    expect(
      resumePlanFrom('GET', 200, new Headers({ 'content-length': '10', etag: '"v1"' }))
    ).toBeNull();
    expect(
      resumePlanFrom('GET', 200, new Headers({ 'content-length': '10', 'accept-ranges': 'bytes' }))
    ).toBeNull();
    expect(
      resumePlanFrom(
        'GET',
        200,
        new Headers({
          'content-length': '10',
          'accept-ranges': 'bytes',
          etag: 'W/"v1"',
          'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
        })
      )
    ).toEqual({
      start: 0,
      end: 9,
      total: 10,
      validator: { header: 'last-modified', value: 'Wed, 21 Oct 2015 07:28:00 GMT' },
    });
  });
});

describe('verifyContinuation', () => {
  const plan = resumePlanFrom('GET', 200, new Headers({ ...resumable200 }))!;

  test('必须是对齐的 206，If-Range 失败的 200 不接受', () => {
    expect(verifyContinuation(resume206(4, 9, 10, FILE.subarray(4)), plan, 4)).toBe(true);
    expect(verifyContinuation(resume206(3, 9, 10, FILE.subarray(3)), plan, 4)).toBe(false);
    expect(
      verifyContinuation(
        new Response(bodyOf(FILE), { status: 200, headers: { etag: '"v1"' } }),
        plan,
        4
      )
    ).toBe(false);
  });
});

describe('wrapForwardedBody', () => {
  test('200 + content-length：传输中断后按 Range 续上，字节不多不少', async () => {
    const opens: OpenCall[] = [];
    const logs: string[] = [];
    const sleeps: number[] = [];
    const res = wrap({
      status: 200,
      headers: resumable200,
      body: bodyThenError(FILE.subarray(0, 4)),
      opens,
      logs,
      sleeps,
      open: async (headers) => {
        expect(headers.Range).toBe('bytes=4-9');
        expect(headers['If-Range']).toBe('"v1"');
        return resume206(4, 9, 10, FILE.subarray(4));
      },
    });
    expect(res.status).toBe(200);
    expect(await readAll(res.body)).toEqual(FILE);
    expect(opens).toHaveLength(1);
    expect(sleeps).toEqual([RESUME_BACKOFF_MS[0]]);
    expect(logs).toEqual([
      `[mesh][fwd] resume peer=${NODE.slice(0, 8)} path=${PATH} offset=4 attempt=1`,
    ]);
  });

  test('206 原 Range：在 Content-Range 内续传', async () => {
    const slice = bytes('abcdefghij');
    const res = wrap({
      status: 206,
      headers: {
        'content-range': 'bytes 10-19/100',
        'accept-ranges': 'bytes',
        etag: '"v1"',
      },
      body: bodyThenError(slice.subarray(0, 5)),
      req: new Request(`http://localhost/n/${NODE}${PATH}`, {
        method: 'GET',
        headers: { range: 'bytes=10-19' },
      }),
      open: async (headers) => {
        expect(headers.Range).toBe('bytes=15-19');
        return resume206(15, 19, 100, slice.subarray(5));
      },
    });
    expect(await readAll(res.body)).toEqual(slice);
  });

  test('x-vibeterm-entity-length：无 content-length 也能续', async () => {
    const res = wrap({
      status: 200,
      headers: {
        'accept-ranges': 'bytes',
        etag: '"v1"',
        [ENTITY_LENGTH_HEADER]: '10',
      },
      body: bodyThenError(FILE.subarray(0, 4)),
      open: async (headers) => {
        expect(headers.Range).toBe('bytes=4-9');
        return resume206(4, 9, 10, FILE.subarray(4));
      },
    });
    expect(await readAll(res.body)).toEqual(FILE);
  });

  test('If-Range 对不上（200）时客户端流报错，不拼上重复字节', async () => {
    const res = wrap({
      status: 200,
      headers: resumable200,
      body: bodyThenError(FILE.subarray(0, 4)),
      open: async () =>
        new Response(bodyOf(FILE), {
          status: 200,
          headers: { ...resumable200, etag: '"other"' },
        }),
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.value).toEqual(FILE.subarray(0, 4));
    await expect(reader.read()).rejects.toBeDefined();
  });

  test('没有校验器或没有 accept-ranges 时不续传', async () => {
    const opens: OpenCall[] = [];
    const noValidator = wrap({
      status: 200,
      headers: { 'content-length': '10', 'accept-ranges': 'bytes' },
      body: bodyThenError(FILE.subarray(0, 4)),
      opens,
    });
    await expect(readAll(noValidator.body)).rejects.toBeDefined();
    const noRanges = wrap({
      status: 200,
      headers: { 'content-length': '10', etag: '"v1"' },
      body: bodyThenError(FILE.subarray(0, 4)),
      opens,
    });
    await expect(readAll(noRanges.body)).rejects.toBeDefined();
    expect(opens).toHaveLength(0);
  });

  test('客户端 abort 停止续传', async () => {
    const ctrl = new AbortController();
    let opened = 0;
    const res = wrap({
      status: 200,
      headers: resumable200,
      body: bodyThenError(FILE.subarray(0, 4)),
      req: new Request(`http://localhost/n/${NODE}${PATH}`, { method: 'GET', signal: ctrl.signal }),
      sleep: async (_ms, signal) => {
        await new Promise<void>((_, reject) => {
          const fail = (): void =>
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (signal?.aborted) fail();
          else signal?.addEventListener('abort', fail, { once: true });
        });
      },
      open: async () => {
        opened += 1;
        throw new Error('should not open');
      },
    });
    const pending = readAll(res.body);
    ctrl.abort();
    await expect(pending).rejects.toBeDefined();
    expect(opened).toBe(0);
  });

  test('连续 4 次续传 0 字节就放弃，退避 250/500/1000/2000', async () => {
    const sleeps: number[] = [];
    const logs: string[] = [];
    let opened = 0;
    const res = wrap({
      status: 200,
      headers: resumable200,
      body: bodyThenError(FILE.subarray(0, 4)),
      sleeps,
      logs,
      open: async () => {
        opened += 1;
        return resume206(4, 9, 10, emptyThenError());
      },
    });
    await expect(readAll(res.body)).rejects.toBeDefined();
    expect(opened).toBe(4);
    expect(sleeps).toEqual([...RESUME_BACKOFF_MS]);
    expect(logs.map((line) => /attempt=(\d+)/.exec(line)?.[1])).toEqual(['1', '2', '3', '4']);
  });

  test('续传只要吐出 ≥1 字节就把失败计数清零', async () => {
    let opened = 0;
    const sleeps: number[] = [];
    const res = wrap({
      status: 200,
      headers: resumable200,
      body: bodyThenError(FILE.subarray(0, 4)),
      sleeps,
      open: async (headers) => {
        opened += 1;
        const start = Number(/^bytes=(\d+)/.exec(headers.Range ?? '')?.[1]);
        if (opened === 4) return resume206(4, 9, 10, bodyThenError(FILE.subarray(4, 5)));
        return resume206(start, 9, 10, emptyThenError());
      },
    });
    await expect(readAll(res.body)).rejects.toBeDefined();
    expect(opened).toBe(8);
    expect(sleeps).toEqual([250, 500, 1000, 2000, 250, 500, 1000, 2000]);
  });

  test('open 返回头之后客户端 abort 会 cancel 续传体', async () => {
    const ctrl = new AbortController();
    let cancelled = 0;
    const res = wrap({
      status: 200,
      headers: resumable200,
      body: bodyThenError(FILE.subarray(0, 4)),
      req: new Request(`http://localhost/n/${NODE}${PATH}`, { method: 'GET', signal: ctrl.signal }),
      sleep: async () => {},
      open: async () => {
        const body = new ReadableStream<Uint8Array>({
          pull() {},
          cancel() {
            cancelled += 1;
          },
        });
        ctrl.abort();
        return resume206(4, 9, 10, body);
      },
    });
    await expect(readAll(res.body)).rejects.toBeDefined();
    expect(cancelled).toBe(1);
  });

  test('多次续传不会在 req.signal 上堆监听', async () => {
    const ctrl = new AbortController();
    const parent = ctrl.signal;
    let added = 0;
    let removed = 0;
    const origAdd = parent.addEventListener.bind(parent);
    const origRemove = parent.removeEventListener.bind(parent);
    parent.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
      added += 1;
      return origAdd(...args);
    }) as AbortSignal['addEventListener'];
    parent.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
      removed += 1;
      return origRemove(...args);
    }) as AbortSignal['removeEventListener'];
    const res = wrap({
      status: 200,
      headers: resumable200,
      body: bodyThenError(FILE.subarray(0, 4)),
      req: new Request(`http://localhost/n/${NODE}${PATH}`, { method: 'GET', signal: parent }),
      open: async () => resume206(4, 9, 10, emptyThenError()),
    });
    await expect(readAll(res.body)).rejects.toBeDefined();
    expect(added).toBe(4);
    expect(removed).toBe(added);
  });
});

describe('continuationHeaders', () => {
  test('替换已有 Range，带上 If-Range', () => {
    const plan = resumePlanFrom('GET', 200, new Headers({ ...resumable200 }))!;
    const headers = continuationHeaders({ Range: 'bytes=0-9', accept: '*/*' }, plan, 4);
    expect(headers.Range).toBe('bytes=4-9');
    expect(headers['If-Range']).toBe('"v1"');
    expect(headers.accept).toBe('*/*');
  });
});

describe('Forwarder 接线', () => {
  test('handle 在响应体中途 RST 后对当前 live 续传', async () => {
    let opens = 0;
    const [link] = createInMemoryLinkPair();
    const other = 'bb'.repeat(16);
    const fwd = new Forwarder({
      nodeId: 'aa'.repeat(16),
      peers: {
        getLink: async () => link,
        listReach: () => new Map(),
        onNodeEvent: () => () => {},
        transportOf: () => 'relay',
        rttOf: () => 20,
      },
      streams: {
        openHttpStream: async () => {
          opens += 1;
          if (opens === 1) {
            return new Response(bodyThenError(FILE.subarray(0, 4)), {
              status: 200,
              headers: { ...resumable200, 'content-type': 'application/octet-stream' },
            });
          }
          return resume206(4, 9, 10, FILE.subarray(4));
        },
        openWsStream: async () => {
          throw new Error('unused');
        },
      },
      sleep: async () => {},
    });
    const res = (await fwd.handle(
      new Request(`http://localhost/n/${other}${PATH}`, {
        headers: { cookie: `vibeterm_s_${other}=sid` },
      }),
      { upgrade: () => true }
    )) as Response;
    expect(res.status).toBe(200);
    expect(await readAll(res.body)).toEqual(FILE);
    expect(opens).toBe(2);
  });
});
