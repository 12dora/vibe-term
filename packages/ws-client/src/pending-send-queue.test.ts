import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  DEFAULT_MAX_PENDING_BYTES,
  DEFAULT_MAX_PENDING_FRAMES,
  PendingSendQueue,
} from './pending-send-queue';

function payload(size: number, fill = 1): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

describe('PendingSendQueue', () => {
  test('缺省预算足够容纳真实粘贴（2 MiB / 2048 帧）', () => {
    expect(DEFAULT_MAX_PENDING_BYTES).toBe(2 * 1024 * 1024);
    expect(DEFAULT_MAX_PENDING_FRAMES).toBe(2048);
  });

  test('未超限时 FIFO 入队并报告 queued', () => {
    const queue = new PendingSendQueue({ maxBytes: 100, maxFrames: 8 });
    expect(queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(10, 1)).status).toBe('queued');
    expect(queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(10, 2)).status).toBe('queued');
    expect(queue.frameCount).toBe(2);
    expect(queue.pendingBytes).toBe(20);

    const drained = queue.drain();
    expect(drained.map((frame) => [...frame.payload])).toEqual([
      [...payload(10, 1)],
      [...payload(10, 2)],
    ]);
    expect(queue.frameCount).toBe(0);
    expect(queue.pendingBytes).toBe(0);
  });

  test('超出字节预算时拒绝新帧并清空已排队的有序输入', () => {
    const queue = new PendingSendQueue({ maxBytes: 30, maxFrames: 8 });
    expect(queue.enqueue(wsBorsh.KIND_DEVICE_CONNECT, payload(8, 9)).status).toBe('queued');
    expect(queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(10, 1)).status).toBe('queued');
    expect(queue.enqueue(wsBorsh.KIND_TERM_PASTE, payload(10, 2)).status).toBe('queued');

    const overflow = queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(20, 3));
    expect(overflow.status).toBe('overflow');
    expect(overflow.info).toEqual({
      kind: wsBorsh.KIND_TERM_INPUT,
      pendingFrames: 1,
      pendingBytes: 8,
      droppedFrames: 2,
    });

    const drained = queue.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.kind).toBe(wsBorsh.KIND_DEVICE_CONNECT);
  });

  test('超出帧数上限时同样整段丢弃有序输入', () => {
    const queue = new PendingSendQueue({ maxBytes: 10_000, maxFrames: 2 });
    queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(1, 1));
    queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(1, 2));
    const overflow = queue.enqueue(wsBorsh.KIND_TERM_PASTE, payload(1, 3));
    expect(overflow.status).toBe('overflow');
    expect(overflow.info?.droppedFrames).toBe(2);
    expect(queue.frameCount).toBe(0);
  });

  test('单帧本身超过字节预算也视为 overflow，空队列保持为空', () => {
    const queue = new PendingSendQueue({ maxBytes: 16, maxFrames: 8 });
    const overflow = queue.enqueue(wsBorsh.KIND_TERM_PASTE, payload(32));
    expect(overflow.status).toBe('overflow');
    expect(overflow.info?.droppedFrames).toBe(0);
    expect(queue.frameCount).toBe(0);
  });

  test('有序输入 overflow 之后同一周期内后续输入全部拒绝，避免发出残缺尾部', () => {
    const queue = new PendingSendQueue({ maxBytes: 20, maxFrames: 8 });
    queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(12, 1));
    expect(queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(12, 2)).status).toBe('overflow');
    expect(queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(4, 3)).status).toBe('overflow');
    expect(queue.enqueue(wsBorsh.KIND_TERM_PASTE, payload(4, 4)).status).toBe('overflow');
    expect(queue.frameCount).toBe(0);
  });

  test('同一 overflow 周期只给出一次 info（调用方可只记一次日志/事件）', () => {
    const queue = new PendingSendQueue({ maxBytes: 10, maxFrames: 8 });
    queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(8));
    const first = queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(8));
    const second = queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(1));
    expect(first.info).toBeDefined();
    expect(second.info).toBeUndefined();
  });

  test('非有序控制帧 overflow 只丢掉本帧，不拆有序输入', () => {
    const queue = new PendingSendQueue({ maxBytes: 20, maxFrames: 2 });
    queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(4, 1));
    queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(4, 2));
    const overflow = queue.enqueue(wsBorsh.KIND_TERM_RESIZE, payload(4, 9));
    expect(overflow.status).toBe('overflow');
    expect(queue.frameCount).toBe(2);
    expect(queue.drain().map((frame) => frame.kind)).toEqual([
      wsBorsh.KIND_TERM_INPUT,
      wsBorsh.KIND_TERM_INPUT,
    ]);
  });

  test('drain 结束 overflow 周期，之后可以重新排队输入', () => {
    const queue = new PendingSendQueue({ maxBytes: 10, maxFrames: 8 });
    queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(8));
    expect(queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(8)).status).toBe('overflow');
    queue.drain();
    expect(queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(4)).status).toBe('queued');
    expect(queue.frameCount).toBe(1);
  });
});
