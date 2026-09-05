import { describe, expect, test } from 'bun:test';
import type { StreamCloseInfo } from '@tmex/shared/link';
import { adaptWsStream } from './adapted-ws-stream';
import { encodeTerminalStreamClose } from './stream-close-code';

type FakeOpened = {
  stream: { id: number; closed: Promise<StreamCloseInfo>; onAbort: (cb: () => void) => void };
  send: (bytes: Uint8Array) => Promise<void>;
  readable: ReadableStream<Uint8Array>;
  close: () => void;
};

function fakeOpened(closed: StreamCloseInfo): {
  opened: FakeOpened;
  abort: () => void;
  push: (bytes: Uint8Array) => void;
  fail: (err: unknown) => void;
} {
  const aborts: Array<() => void> = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    opened: {
      stream: {
        id: 7,
        closed: Promise.resolve(closed),
        onAbort: (cb) => {
          aborts.push(cb);
        },
      },
      send: async () => {},
      readable,
      close: () => {},
    },
    abort: () => {
      for (const cb of aborts) cb();
    },
    push: (bytes) => controller.enqueue(bytes),
    fail: (err) => controller.error(err),
  };
}

async function tick(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 1));
}

describe('adaptWsStream', () => {
  test('流已关闭后注册的 onClose 立刻拿到缓存的关闭结果', async () => {
    const fake = fakeOpened({
      reason: 'rst',
      message: encodeTerminalStreamClose(4410, 'SHARE_ENDED'),
    });
    const adapted = adaptWsStream(fake.opened);
    fake.abort();
    await tick();
    const seen: Array<{ code?: number; reason?: string }> = [];
    adapted.onClose((info) => seen.push(info));
    expect(seen).toEqual([{ code: 4410, reason: 'SHARE_ENDED' }]);
  });

  test('早注册的 onClose 只回调一次，晚注册的拿同一份结果', async () => {
    const fake = fakeOpened({ reason: 'rst', message: 'noise' });
    const adapted = adaptWsStream(fake.opened);
    const early: Array<{ code?: number; reason?: string }> = [];
    adapted.onClose((info) => early.push(info));
    fake.fail(new Error('boom'));
    await tick();
    const late: Array<{ code?: number; reason?: string }> = [];
    adapted.onClose((info) => late.push(info));
    expect(early).toEqual([{ code: 1011, reason: 'stream-error' }]);
    expect(late).toEqual(early);
    fake.abort();
    await tick();
    expect(early.length).toBe(1);
  });

  test('close() 后注册的 onClose 也拿到关闭原因', async () => {
    const fake = fakeOpened({ reason: 'end' });
    const adapted = adaptWsStream(fake.opened);
    adapted.close(1000, 'bye');
    const seen: Array<{ code?: number; reason?: string }> = [];
    adapted.onClose((info) => seen.push(info));
    expect(seen).toEqual([{ reason: 'bye' }]);
  });
});
