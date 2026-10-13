import { describe, expect, spyOn, test } from 'bun:test';
import {
  type LinkStream,
  type StreamChunk,
  type StreamCloseInfo,
  createInMemoryLinkPair,
} from '@vibeterm/shared/link';
import { encodeJsonBytes } from './ctl';
import { type HttpHeadResult, readHttpHead } from './stream-http-head';
import { responseFromHttpHead } from './stream-http-response';

describe('responseFromHttpHead', () => {
  test('rest + 后续字节组成 body；content-length 对齐则成功', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream(async (stream) => {
      await stream.write(new TextEncoder().encode('AB'));
      await stream.write(
        encodeJsonBytes({
          status: 200,
          headers: { 'content-type': 'text/plain', 'content-length': '4' },
        }),
        { head: true }
      );
      await stream.write(new TextEncoder().encode('CD'));
      await stream.end();
    });
    const stream = await a.openStream(encodeJsonBytes({ type: 'http' }));
    const head = await readHttpHead(stream, { timeoutMs: 1_000 });
    const res = responseFromHttpHead(stream, head, () => {
      stream.reset('aborted');
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ABCD');
  });

  test('content-length 对不上则 body 以 truncated 失败', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream(async (stream) => {
      await stream.write(
        encodeJsonBytes({
          status: 200,
          headers: { 'content-length': '10' },
        }),
        { head: true }
      );
      await stream.write(new TextEncoder().encode('short'));
      await stream.end();
    });
    const stream = await a.openStream(encodeJsonBytes({ type: 'http' }));
    const head = await readHttpHead(stream, { timeoutMs: 1_000 });
    const res = responseFromHttpHead(stream, head, () => {});
    await expect(res.text()).rejects.toThrow(/http body truncated/);
  });
});

const enc = new TextEncoder();
const dec = new TextDecoder();

type FakeLink = {
  stream: LinkStream;
  pulls: () => number;
  cancelled: () => boolean;
  abort: () => void;
  end: () => void;
  rejectRead: (err: Error) => void;
};

function fakeLinkStream(chunks: string[], opts: { hold?: boolean } = {}): FakeLink {
  let pulled = 0;
  let cancelled = false;
  let index = 0;
  let abortCb: (() => void) | null = null;
  let pendingEnd: (() => void) | null = null;
  let pendingFail: ((err: Error) => void) | null = null;
  const readable = new ReadableStream<StreamChunk>(
    {
      pull(c) {
        pulled += 1;
        const next = chunks[index];
        if (next !== undefined) {
          index += 1;
          c.enqueue({ bytes: enc.encode(next), head: false });
          return;
        }
        if (!opts.hold) {
          c.close();
          return;
        }
        return new Promise<void>((resolve, reject) => {
          pendingEnd = () => {
            c.close();
            resolve();
          };
          pendingFail = reject;
        });
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  const stream = {
    id: 1,
    openPayload: new Uint8Array(),
    readable,
    write: async () => {},
    end: async () => {},
    reset: () => {},
    closed: new Promise<StreamCloseInfo>(() => {}),
    onAbort: (cb: () => void) => {
      abortCb = cb;
    },
  } satisfies LinkStream;
  return {
    stream,
    pulls: () => pulled,
    cancelled: () => cancelled,
    abort: () => abortCb?.(),
    end: () => pendingEnd?.(),
    rejectRead: (err) => pendingFail?.(err),
  };
}

function headOf(rest: string[], headers: Record<string, string> = {}): HttpHeadResult {
  return { status: 200, headers, rest: rest.map((r) => enc.encode(r)) };
}

describe('responseFromHttpHead 背压', () => {
  test('消费者不读时上游最多被拉取少量 chunk', async () => {
    const link = fakeLinkStream(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    responseFromHttpHead(link.stream, headOf([]), () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(link.pulls()).toBeLessThanOrEqual(3);
  });

  test('读取 N 个 chunk 约拉取 N 次上游', async () => {
    const link = fakeLinkStream(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const res = responseFromHttpHead(link.stream, headOf([]), () => {});
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    for (let i = 0; i < 4; i += 1) await reader.read();
    await new Promise((r) => setTimeout(r, 20));
    expect(link.pulls()).toBeGreaterThanOrEqual(4);
    expect(link.pulls()).toBeLessThanOrEqual(6);
  });

  test('rest 先于上游 chunk 输出，完整 body 往返', async () => {
    const link = fakeLinkStream(['CD', 'EF']);
    const head = headOf(['A', 'B'], { 'content-length': '6' });
    const res = responseFromHttpHead(link.stream, head, () => {});
    expect(await res.text()).toBe('ABCDEF');
  });

  test('rest 已含完整 body 且上游立即 END', async () => {
    const link = fakeLinkStream([]);
    const head = headOf(['xyz'], { 'content-length': '3' });
    const res = responseFromHttpHead(link.stream, head, () => {});
    expect(await res.text()).toBe('xyz');
  });

  test('content-length 为 0 的空 body', async () => {
    const link = fakeLinkStream([]);
    const head = headOf([], { 'content-length': '0' });
    const res = responseFromHttpHead(link.stream, head, () => {});
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test('截断的 body 报错', async () => {
    const link = fakeLinkStream(['ab']);
    const head = headOf([], { 'content-length': '9' });
    const res = responseFromHttpHead(link.stream, head, () => {});
    await expect(res.text()).rejects.toThrow(/http body truncated: sent=2 expected=9/);
  });

  test('read 挂起时收到 abort：body 报错且只记一次日志', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    // 日志按 1s 限流且状态是模块级的，把时间拨远以免被前面的用例吃掉
    const now = spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    try {
      const link = fakeLinkStream(['ab'], { hold: true });
      const res = responseFromHttpHead(link.stream, headOf([]), () => {});
      const reader = res.body?.getReader();
      if (!reader) throw new Error('no body');
      expect(dec.decode((await reader.read()).value)).toBe('ab');
      const next = reader.read();
      await new Promise((r) => setTimeout(r, 5));
      link.abort();
      link.rejectRead(new Error('link dead'));
      await expect(next).rejects.toThrow(/http stream aborted/);
      await new Promise((r) => setTimeout(r, 5));
      const aborted = warn.mock.calls.filter((c) => String(c[0]).includes('forward aborted'));
      expect(aborted.length).toBe(1);
    } finally {
      now.mockRestore();
      warn.mockRestore();
    }
  });

  test('首次 pull 前 abort：读取立即报错', async () => {
    const link = fakeLinkStream(['ab']);
    const res = responseFromHttpHead(link.stream, headOf([]), () => {});
    link.abort();
    await expect(res.text()).rejects.toThrow(/http stream aborted/);
  });

  test('消费者中途 cancel：调用 rst 一次并取消上游 reader', async () => {
    const link = fakeLinkStream(['a', 'b', 'c', 'd'], { hold: true });
    let rstCalls = 0;
    const res = responseFromHttpHead(link.stream, headOf([]), () => {
      rstCalls += 1;
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    await reader.read();
    await reader.cancel();
    expect(rstCalls).toBe(1);
    expect(link.cancelled()).toBe(true);
  });

  test('未读取就 cancel：只调用 rst', async () => {
    const link = fakeLinkStream([]);
    let rstCalls = 0;
    const res = responseFromHttpHead(link.stream, headOf(['a', 'b']), () => {
      rstCalls += 1;
    });
    await res.body?.cancel();
    expect(rstCalls).toBe(1);
  });
});
