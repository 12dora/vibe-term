// 分屏拖拽的两条契约：一帧只应用一次更新；候选 rect 一次拖拽只量一次。
import { describe, expect, test } from 'bun:test';
import { type DragFrames, createDragFrameScheduler, createDragMeasurement } from './dragScheduling';

function fakeFrames(): DragFrames & { runFrame: () => void; pending: () => number } {
  const queue = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    requestFrame: (callback) => {
      const handle = nextHandle++;
      queue.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      queue.delete(handle as number);
    },
    runFrame: () => {
      const entries = Array.from(queue.entries());
      queue.clear();
      for (const [, callback] of entries) callback();
    },
    pending: () => queue.size,
  };
}

describe('createDragFrameScheduler', () => {
  test('一帧内的 N 次 pointermove 只产生一次状态更新，且取最后一个值', () => {
    const frames = fakeFrames();
    const scheduler = createDragFrameScheduler(frames);
    const applied: number[] = [];

    for (let delta = 1; delta <= 8; delta += 1) {
      scheduler.schedule(() => applied.push(delta));
    }
    expect(applied).toEqual([]);
    expect(frames.pending()).toBe(1);

    frames.runFrame();
    expect(applied).toEqual([8]);
  });

  test('跨帧继续调度：每帧各一次', () => {
    const frames = fakeFrames();
    const scheduler = createDragFrameScheduler(frames);
    const applied: number[] = [];

    scheduler.schedule(() => applied.push(1));
    scheduler.schedule(() => applied.push(2));
    frames.runFrame();
    scheduler.schedule(() => applied.push(3));
    frames.runFrame();

    expect(applied).toEqual([2, 3]);
  });

  test('cancel 丢弃未应用的帧（pointerup 清空状态后不得被残帧覆盖）', () => {
    const frames = fakeFrames();
    const scheduler = createDragFrameScheduler(frames);
    const applied: number[] = [];

    scheduler.schedule(() => applied.push(1));
    scheduler.cancel();
    frames.runFrame();

    expect(applied).toEqual([]);
    expect(frames.pending()).toBe(0);
  });

  test('无 rAF 的宿主退回同步应用', () => {
    const scheduler = createDragFrameScheduler({
      requestFrame: () => null,
      cancelFrame: () => {},
    });
    const applied: number[] = [];

    scheduler.schedule(() => applied.push(1));
    expect(applied).toEqual([1]);
  });
});

describe('createDragMeasurement', () => {
  test('一次拖拽内多次读取只量测一次', () => {
    let calls = 0;
    const measurement = createDragMeasurement(() => {
      calls += 1;
      return { value: calls };
    });

    expect(measurement.read()).toEqual({ value: 1 });
    expect(measurement.read()).toEqual({ value: 1 });
    expect(measurement.read()).toEqual({ value: 1 });
    expect(calls).toBe(1);
  });

  test('invalidate（滚动 / 改窗口）后重新量测', () => {
    let calls = 0;
    const measurement = createDragMeasurement(() => {
      calls += 1;
      return calls;
    });

    expect(measurement.read()).toBe(1);
    measurement.invalidate();
    expect(measurement.read()).toBe(2);
    expect(measurement.read()).toBe(2);
    expect(calls).toBe(2);
  });
});
