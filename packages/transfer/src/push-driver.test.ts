import { describe, expect, test } from 'bun:test';
import { type PushOutcome, type PushTransport, runPush } from './push-driver';
import type { ByteRange, ReceivedState } from './types';

type Scripted = {
  transport: PushTransport;
  puts: ByteRange[];
  statusCalls: number;
};

function scripted(
  statuses: Array<ReceivedState | null>,
  outcomes: (range: ByteRange, index: number) => PushOutcome
): Scripted {
  const puts: ByteRange[] = [];
  let statusCalls = 0;
  const transport: PushTransport = {
    async status() {
      const next = statuses[statusCalls] ?? statuses[statuses.length - 1] ?? null;
      statusCalls += 1;
      return next;
    },
    async put(range, opts) {
      const index = puts.length;
      puts.push(range);
      opts.onProgress(range.length);
      return outcomes(range, index);
    },
  };
  return {
    transport,
    puts,
    get statusCalls() {
      return statusCalls;
    },
  };
}

const NEVER_ABORT = new AbortController().signal;

describe('runPush', () => {
  test('single stream: pushes the whole file when nothing has landed', async () => {
    const s = scripted([{ receivedBytes: 0, ranges: [], complete: false }], () => ({
      kind: 'landed',
    }));
    const res = await runPush(s.transport, {
      totalBytes: 1000,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
    });
    expect(res).toEqual({ kind: 'done', transferredBytes: 1000 });
    expect(s.puts).toEqual([{ offset: 0, length: 1000 }]);
  });

  test('single stream: resumes from the reported offset', async () => {
    const s = scripted([{ receivedBytes: 400, ranges: [], complete: false }], () => ({
      kind: 'landed',
    }));
    await runPush(s.transport, {
      totalBytes: 1000,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
    });
    expect(s.puts).toEqual([{ offset: 400, length: 600 }]);
  });

  test('a complete target is not pushed again', async () => {
    const s = scripted([{ receivedBytes: 1000, ranges: [], complete: true }], () => ({
      kind: 'landed',
    }));
    const res = await runPush(s.transport, {
      totalBytes: 1000,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
    });
    expect(res.kind).toBe('done');
    expect(s.puts).toEqual([]);
  });

  test('a full .part that is not committed gets a zero-length finishing push', async () => {
    const s = scripted([{ receivedBytes: 1000, ranges: [], complete: false }], () => ({
      kind: 'landed',
    }));
    await runPush(s.transport, {
      totalBytes: 1000,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
    });
    expect(s.puts).toEqual([{ offset: 1000, length: 0 }]);
  });

  test('a link failure is retried from the new offset after a backoff', async () => {
    const slept: number[] = [];
    const s = scripted(
      [
        { receivedBytes: 0, ranges: [], complete: false },
        { receivedBytes: 300, ranges: [], complete: false },
      ],
      (_range, index) => (index === 0 ? { kind: 'retry', error: 'reset' } : { kind: 'landed' })
    );
    const res = await runPush(s.transport, {
      totalBytes: 1000,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(res.kind).toBe('done');
    expect(s.puts).toEqual([
      { offset: 0, length: 1000 },
      { offset: 300, length: 700 },
    ]);
    expect(slept).toEqual([1000]);
  });

  test('a deterministic failure ends the push immediately', async () => {
    const s = scripted([{ receivedBytes: 0, ranges: [], complete: false }], () => ({
      kind: 'fail',
      error: 'HTTP 400 BAD',
    }));
    const res = await runPush(s.transport, {
      totalBytes: 10,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
      sleep: async () => {},
    });
    expect(res).toEqual({ kind: 'failed', error: 'HTTP 400 BAD' });
    expect(s.puts).toHaveLength(1);
  });

  test('shouldRestartFromZero re-uploads once and then gives up', async () => {
    const s = scripted([{ receivedBytes: 500, ranges: [], complete: false }], () => ({
      kind: 'fail',
      error: 'PACKAGE_SHA256_MISMATCH',
    }));
    const res = await runPush(s.transport, {
      totalBytes: 1000,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
      sleep: async () => {},
      shouldRestartFromZero: (error, offset) =>
        offset > 0 && error.includes('PACKAGE_SHA256_MISMATCH'),
    });
    expect(res.kind).toBe('failed');
    expect(s.puts).toEqual([
      { offset: 500, length: 500 },
      { offset: 0, length: 1000 },
    ]);
  });

  test('resume disabled never asks for an offset', async () => {
    const s = scripted([{ receivedBytes: 800, ranges: [], complete: false }], () => ({
      kind: 'landed',
    }));
    await runPush(s.transport, {
      totalBytes: 1000,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
      resume: false,
    });
    expect(s.statusCalls).toBe(0);
    expect(s.puts).toEqual([{ offset: 0, length: 1000 }]);
  });

  test('four streams split the gap into disjoint ranges and report progress once', async () => {
    const progress: number[] = [];
    const s = scripted([{ receivedBytes: 0, ranges: [], complete: false }], () => ({
      kind: 'landed',
    }));
    const res = await runPush(s.transport, {
      totalBytes: 4000,
      streams: 4,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
      onProgress: (n) => progress.push(n),
    });
    expect(res.kind).toBe('done');
    expect(s.puts).toEqual([
      { offset: 0, length: 1000 },
      { offset: 1000, length: 1000 },
      { offset: 2000, length: 1000 },
      { offset: 3000, length: 1000 },
    ]);
    expect(progress[progress.length - 1]).toBe(4000);
  });

  test('parallel resume only re-sends the missing ranges', async () => {
    const s = scripted(
      [
        {
          receivedBytes: 2000,
          ranges: [
            { offset: 0, length: 1000 },
            { offset: 2000, length: 1000 },
          ],
          complete: false,
        },
      ],
      () => ({ kind: 'landed' })
    );
    await runPush(s.transport, {
      totalBytes: 4000,
      streams: 4,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
    });
    expect(s.puts).toEqual([
      { offset: 1000, length: 500 },
      { offset: 1500, length: 500 },
      { offset: 3000, length: 500 },
      { offset: 3500, length: 500 },
    ]);
  });

  test('a cancelled attempt stops the whole push', async () => {
    const s = scripted([{ receivedBytes: 0, ranges: [], complete: false }], () => ({
      kind: 'cancelled',
    }));
    const res = await runPush(s.transport, {
      totalBytes: 100,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
      sleep: async () => {},
    });
    expect(res).toEqual({ kind: 'cancelled' });
  });

  test('exhausting the attempts reports the last link error', async () => {
    const s = scripted([{ receivedBytes: 0, ranges: [], complete: false }], () => ({
      kind: 'retry',
      error: 'reset',
    }));
    const res = await runPush(s.transport, {
      totalBytes: 100,
      maxAttempts: 3,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
      sleep: async () => {},
    });
    expect(res).toEqual({ kind: 'failed', error: 'reset' });
    expect(s.puts).toHaveLength(3);
  });

  test('a passed deadline fails with the timeout text without pushing', async () => {
    const s = scripted([{ receivedBytes: 0, ranges: [], complete: false }], () => ({
      kind: 'landed',
    }));
    const res = await runPush(s.transport, {
      totalBytes: 100,
      deadlineMs: Date.now() - 1,
      signal: NEVER_ABORT,
      timeoutError: 'push failed: push timeout',
    });
    expect(res).toEqual({ kind: 'failed', error: 'push failed: push timeout' });
    expect(s.puts).toEqual([]);
  });
});

describe('runPush cancellation and deadlines', () => {
  test('取消压过已落地的区间：中途 abort 的整次推送算取消', async () => {
    const controller = new AbortController();
    const puts: ByteRange[] = [];
    const transport: PushTransport = {
      async status() {
        return { receivedBytes: 0, ranges: [], complete: false };
      },
      async put(range) {
        puts.push(range);
        controller.abort();
        return { kind: 'landed' };
      },
    };
    const res = await runPush(transport, {
      totalBytes: 4000,
      streams: 1,
      maxRangeBytes: 1000,
      deadlineMs: Date.now() + 60_000,
      signal: controller.signal,
      sleep: async () => {},
    });
    expect(res).toEqual({ kind: 'cancelled' });
    // abort 之后不再发放新的区间
    expect(puts).toHaveLength(1);
  });

  test('已 abort 的信号根本不发起推送', async () => {
    const controller = new AbortController();
    controller.abort();
    const puts: ByteRange[] = [];
    const transport: PushTransport = {
      async status() {
        return { receivedBytes: 0, ranges: [], complete: false };
      },
      async put(range) {
        puts.push(range);
        return { kind: 'landed' };
      },
    };
    expect(
      await runPush(transport, {
        totalBytes: 100,
        deadlineMs: Date.now() + 60_000,
        signal: controller.signal,
      })
    ).toEqual({ kind: 'cancelled' });
    expect(puts).toEqual([]);
  });

  test('剩余期限用尽会 abort 卡住的 PUT，整轮不会无限等下去', async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const transport: PushTransport = {
      async status() {
        return { receivedBytes: 0, ranges: [], complete: false };
      },
      put(_range, opts) {
        seen.signal = opts.signal;
        return new Promise((resolve) => {
          opts.signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), {
            once: true,
          });
        });
      },
    };
    const res = await runPush(transport, {
      totalBytes: 100,
      maxAttempts: 1,
      deadlineMs: Date.now() + 30,
      signal: NEVER_ABORT,
      timeoutError: 'push timeout',
      sleep: async () => {},
    });
    expect(res).toEqual({ kind: 'failed', error: 'push timeout' });
    expect(seen.signal?.aborted).toBe(true);
  });

  test('本轮出结论后收掉还在飞的并行请求', async () => {
    const signals: AbortSignal[] = [];
    const transport: PushTransport = {
      async status() {
        return { receivedBytes: 0, ranges: [], complete: false };
      },
      put(range, opts) {
        signals.push(opts.signal);
        if (range.offset === 0) return Promise.resolve({ kind: 'fail', error: 'HTTP 400 BAD' });
        return new Promise((resolve) => {
          opts.signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), {
            once: true,
          });
        });
      },
    };
    const res = await runPush(transport, {
      totalBytes: 4000,
      streams: 4,
      deadlineMs: Date.now() + 60_000,
      signal: NEVER_ABORT,
      sleep: async () => {},
    });
    expect(res).toEqual({ kind: 'failed', error: 'HTTP 400 BAD' });
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});
