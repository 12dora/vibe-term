import { describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import type { LinkStream, StreamCloseInfo } from '@vibeterm/shared/link';
import { SHARE_WS_CLOSE_ENDED } from '@vibeterm/shared/share';
import {
  LINK_STREAM_BACKPRESSURE_BYTES,
  LINK_STREAM_PRIORITY_QUEUE_BYTES,
  LINK_STREAM_PRIORITY_QUEUE_CAP,
  LinkStreamCarrier,
} from './link-stream-carrier';
import {
  decodeTerminalStreamClose,
  encodeTerminalStreamClose,
  isTerminalStreamClose,
} from './stream-close-code';

const HIGH = 64 * 1024;

/** write 由测试逐笔放行的假流，用来把两条泵的交错固定下来。 */
function gatedStream(): {
  stream: LinkStream;
  writes: Array<{ bytes: Uint8Array; priority: boolean; release: () => void }>;
  ended: () => boolean;
} {
  const writes: Array<{ bytes: Uint8Array; priority: boolean; release: () => void }> = [];
  let ended = false;
  const stream: LinkStream = {
    id: 1,
    openPayload: new Uint8Array(0),
    readable: new ReadableStream(),
    write: (bytes, opts) =>
      new Promise<void>((resolve) => {
        writes.push({
          bytes: bytes.slice(),
          priority: opts?.priority === true,
          release: resolve,
        });
      }),
    end: () => {
      ended = true;
      return Promise.resolve();
    },
    reset: () => undefined,
    closed: new Promise<StreamCloseInfo>(() => undefined),
    onAbort: () => undefined,
  };
  return { stream, writes, ended: () => ended };
}

/** write 永不 resolve 的假流，用来观察载体队列本身的上限。 */
function blockedStream(): LinkStream {
  return {
    id: 1,
    openPayload: new Uint8Array(0),
    readable: new ReadableStream(),
    write: () => new Promise<void>(() => undefined),
    end: () => Promise.resolve(),
    reset: () => undefined,
    closed: new Promise<StreamCloseInfo>(() => undefined),
    onAbort: () => undefined,
  };
}

describe('LinkStreamCarrier', () => {
  test('在途 = 队列 + mux 未回信用，超上限即背压，跌回一半才 onDrain', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const carrier = new LinkStreamCarrier(incoming, { highWaterMark: HIGH });
    let drained = 0;
    carrier.onDrain(() => {
      drained += 1;
    });

    const chunk = new Uint8Array(HIGH / 2);
    expect(carrier.send(chunk)).toBe('sent');
    expect(carrier.send(chunk)).toBe('sent');
    expect(carrier.send(new Uint8Array(1))).toBe('backpressure');

    // 队列早就交给 mux 了，但对端一个字节都没读：在途仍然满，不许 drain。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(carrier.bufferedAmount()).toBeGreaterThan(HIGH);
    expect(drained).toBe(0);
    expect(carrier.hasPendingWrites()).toBe(true);

    const reader = out.readable.getReader();
    while (carrier.bufferedAmount() > HIGH / 2) {
      const chunkRead = await reader.read();
      if (chunkRead.done) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBeGreaterThan(0);
    out.end();
    incoming.end();
  });

  test('默认在途上限来自 config，且默认 256 KiB', () => {
    expect(LINK_STREAM_BACKPRESSURE_BYTES).toBe(256 * 1024);
  });

  test('优先帧走独立队列，普通队列积压时仍先到达', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const carrier = new LinkStreamCarrier(incoming, { highWaterMark: HIGH });

    // 1 MiB 窗口、预留 16 KiB：普通写吃到 1008 KiB 就停，后面的排队等信用。
    const bulk = new Uint8Array(200 * 1024).fill(1);
    for (let i = 0; i < 8; i++) carrier.send(bulk);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(carrier.sendPriority(new Uint8Array([0xfe, 0xed]))).toBe('sent');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const reader = out.readable.getReader();
    let priorityAt = -1;
    for (let i = 0; i < 8 && priorityAt < 0; i++) {
      const { value } = await reader.read();
      if (!value) break;
      if (value.bytes.byteLength === 2) priorityAt = i;
    }
    // 8 块 200 KiB 一共 1600 KiB，优先帧必须挤在还没发完的普通块之前。
    expect(priorityAt).toBeGreaterThanOrEqual(0);
    expect(priorityAt).toBeLessThan(8);
    out.end();
    incoming.end();
  });

  test('在途只算一次：正在 write 的块不会同时计进队列和未回信用', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const bound = 256 * 1024;
    const carrier = new LinkStreamCarrier(incoming, { highWaterMark: bound });

    // 出队后仍在 write() 里：只该算一份。
    expect(carrier.send(new Uint8Array(bound - 32 * 1024))).toBe('sent');
    expect(carrier.bufferedAmount()).toBe(bound - 32 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(carrier.bufferedAmount()).toBe(bound - 32 * 1024);

    // 真实在途 240 KiB < 256 KiB，仍应放行（改前会因为重复计数报背压）。
    expect(carrier.send(new Uint8Array(16 * 1024))).toBe('sent');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(carrier.bufferedAmount()).toBe(bound - 16 * 1024);
    // 越过上限才背压。
    expect(carrier.send(new Uint8Array(32 * 1024))).toBe('backpressure');

    carrier.terminate();
    out.reset('done');
  });

  test('半关闭排在最后一帧优先写之后，已收下的优先帧不会被 END 作废', async () => {
    const gate = gatedStream();
    const carrier = new LinkStreamCarrier(gate.stream);
    expect(carrier.send(new Uint8Array(4096))).toBe('sent');
    expect(carrier.sendPriority(new Uint8Array([1]))).toBe('sent');
    expect(carrier.sendPriority(new Uint8Array([2]))).toBe('sent');
    carrier.close(1000, 'bye');

    // 普通写先落地：此时优先泵还没跑完，不许 END。
    gate.writes[0]?.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gate.ended()).toBe(false);

    gate.writes[1]?.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gate.ended()).toBe(false);

    gate.writes[2]?.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gate.ended()).toBe(true);
    expect(gate.writes.map((w) => w.priority)).toEqual([false, true, true]);
    expect(gate.writes[1]?.bytes[0]).toBe(1);
    expect(gate.writes[2]?.bytes[0]).toBe(2);
  });

  test('优先队列有界：超过帧数或字节上限返回 rejected', () => {
    const carrier = new LinkStreamCarrier(blockedStream());
    // 第一帧被泵立刻取走，所以队列还能再收 CAP 帧。
    for (let i = 0; i < LINK_STREAM_PRIORITY_QUEUE_CAP + 1; i++) {
      expect(carrier.sendPriority(new Uint8Array([i]))).toBe('sent');
    }
    expect(carrier.sendPriority(new Uint8Array([0]))).toBe('rejected');

    const other = new LinkStreamCarrier(blockedStream());
    expect(other.sendPriority(new Uint8Array(LINK_STREAM_PRIORITY_QUEUE_BYTES))).toBe('sent');
    expect(other.sendPriority(new Uint8Array(1))).toBe('rejected');
  });

  test('关闭后的优先发送返回 closed', () => {
    const carrier = new LinkStreamCarrier(blockedStream());
    carrier.terminate();
    expect(carrier.sendPriority(new Uint8Array([1]))).toBe('closed');
  });

  test('close ends the stream and terminate RSTs', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<import('@vibeterm/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const carrier = new LinkStreamCarrier(out);
    carrier.close(1000, 'bye');
    const reader = incoming.readable.getReader();
    expect((await reader.read()).done).toBe(true);
    incoming.end();
    expect((await out.closed).reason).toBe('end');

    const incoming2P = new Promise<import('@vibeterm/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out2 = await a.openStream(new Uint8Array([2]));
    await incoming2P;
    const carrier2 = new LinkStreamCarrier(out2);
    const aborted = new Promise<void>((resolve) => out2.onAbort(resolve));
    carrier2.terminate();
    await aborted;
  });

  test('close drains already-accepted frames before END', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<import('@vibeterm/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const carrier = new LinkStreamCarrier(out);
    expect(carrier.send(new TextEncoder().encode('one'))).toBe('sent');
    expect(carrier.send(new TextEncoder().encode('two'))).toBe('sent');
    carrier.close(1000, 'bye');
    expect(carrier.send(new TextEncoder().encode('three'))).toBe('closed');
    const reader = incoming.readable.getReader();
    const first = await reader.read();
    const second = await reader.read();
    const done = await reader.read();
    expect(new TextDecoder().decode(first.value?.bytes)).toBe('one');
    expect(new TextDecoder().decode(second.value?.bytes)).toBe('two');
    expect(done.done).toBe(true);
  });

  test('link abort fires onClose even with a queued send', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<import('@vibeterm/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out = await a.openStream(new Uint8Array([1]));
    await incomingP;
    const carrier = new LinkStreamCarrier(out);
    const closed = new Promise<void>((resolve) => carrier.onClose(resolve));
    expect(carrier.send(new Uint8Array(64))).toBe('sent');
    a.close('link-down');
    await closed;
    expect(carrier.send(new Uint8Array([1]))).toBe('closed');
  });
});

describe('LinkStreamCarrier 终止性关闭码', () => {
  test('4410 以 RST 携带 code:reason，对端可解码', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<import('@vibeterm/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const carrier = new LinkStreamCarrier(incoming);
    let closed = 0;
    carrier.onClose(() => {
      closed += 1;
    });
    carrier.close(SHARE_WS_CLOSE_ENDED, 'SHARE_ENDED');
    expect(closed).toBe(1);
    const info = await out.closed;
    expect(info.reason).toBe('rst');
    expect(decodeTerminalStreamClose(info.message)).toEqual({
      code: SHARE_WS_CLOSE_ENDED,
      reason: 'SHARE_ENDED',
    });
  });

  test('普通关闭码仍是干净半关闭，不带终止标记', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<import('@vibeterm/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    new LinkStreamCarrier(incoming).close(1000, 'bye');
    const reader = out.readable.getReader();
    const first = await reader.read();
    expect(first.done).toBe(true);
    out.end();
  });
});

describe('stream-close-code', () => {
  test('编解码只认白名单里的终止码', () => {
    expect(decodeTerminalStreamClose(encodeTerminalStreamClose(4410, 'SHARE_ENDED'))).toEqual({
      code: 4410,
      reason: 'SHARE_ENDED',
    });
    expect(
      decodeTerminalStreamClose(encodeTerminalStreamClose(4401, 'NODE_LOGIN_REQUIRED'))
    ).toEqual({ code: 4401, reason: 'NODE_LOGIN_REQUIRED' });
    expect(decodeTerminalStreamClose('tmex-close:1011:boom')).toBeNull();
    expect(decodeTerminalStreamClose('session-invalid')).toBeNull();
    expect(decodeTerminalStreamClose(undefined)).toBeNull();
    expect(isTerminalStreamClose({ code: 4410 })).toBe(true);
    expect(isTerminalStreamClose({ code: 1011 })).toBe(false);
    expect(isTerminalStreamClose(null)).toBe(false);
  });
});
