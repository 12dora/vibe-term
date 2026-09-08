// 合并窗口的契约：首条立即发（单次滚动零延迟），窗口内后到的累积成一条，
// flush 保序，discard 丢弃且不留定时器。
import { describe, expect, test } from 'bun:test';
import { MOUSE_REPORT_COALESCE_MS, MouseReportBatcher } from './mouse-report-batcher';

type FakeTimer = { at: number; callback: () => void };

function createClock() {
  const timers = new Map<number, FakeTimer>();
  let now = 1000;
  let nextId = 1;

  return {
    get now(): number {
      return now;
    },
    get pending(): number {
      return timers.size;
    },
    options: {
      now: () => now,
      setTimer: (callback: () => void, delayMs: number): unknown => {
        const id = nextId++;
        timers.set(id, { at: now + delayMs, callback });
        return id;
      },
      clearTimer: (handle: unknown): void => {
        timers.delete(handle as number);
      },
    },
    advance(ms: number): void {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due || guard++ > 100) {
          break;
        }
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
  };
}

function createBatcher(windowMs = 16) {
  const clock = createClock();
  const emitted: string[] = [];
  const batcher = new MouseReportBatcher({
    ...clock.options,
    windowMs,
    emit: (payload) => emitted.push(payload),
  });
  return { batcher, clock, emitted };
}

describe('MouseReportBatcher', () => {
  test('突发的第一条立即发出，不引入延迟', () => {
    const { batcher, emitted, clock } = createBatcher();

    batcher.push('a');

    expect(emitted).toEqual(['a']);
    expect(clock.pending).toBe(0);
  });

  test('窗口内后到的合并成一条，窗口关闭时发出', () => {
    const { batcher, emitted, clock } = createBatcher();

    batcher.push('a');
    clock.advance(5);
    batcher.push('b');
    clock.advance(3);
    batcher.push('c');

    expect(emitted).toEqual(['a']);
    clock.advance(16);
    expect(emitted).toEqual(['a', 'bc']);
    expect(clock.pending).toBe(0);
  });

  test('窗口过去后的下一条又走立即发', () => {
    const { batcher, emitted, clock } = createBatcher();

    batcher.push('a');
    clock.advance(20);
    batcher.push('b');

    expect(emitted).toEqual(['a', 'b']);
  });

  test('flush 立刻发出挂起字节并撤掉定时器', () => {
    const { batcher, emitted, clock } = createBatcher();

    batcher.push('a');
    clock.advance(1);
    batcher.push('b');
    expect(clock.pending).toBe(1);

    batcher.flush();

    expect(emitted).toEqual(['a', 'b']);
    expect(clock.pending).toBe(0);
    expect(batcher.hasPending).toBeFalse();
  });

  test('flush 无挂起时不发空串', () => {
    const { batcher, emitted } = createBatcher();

    batcher.flush();

    expect(emitted).toEqual([]);
  });

  test('discard 丢弃挂起字节且不留定时器', () => {
    const { batcher, emitted, clock } = createBatcher();

    batcher.push('a');
    clock.advance(1);
    batcher.push('b');
    batcher.discard();
    clock.advance(50);

    expect(emitted).toEqual(['a']);
    expect(clock.pending).toBe(0);
  });

  test('空串不入队', () => {
    const { batcher, emitted } = createBatcher();

    batcher.push('');

    expect(emitted).toEqual([]);
    expect(batcher.hasPending).toBeFalse();
  });
});

test('default window is 0: every gesture is emitted immediately', () => {
  expect(MOUSE_REPORT_COALESCE_MS).toBe(0);
  const { batcher, emitted, clock } = createBatcher(MOUSE_REPORT_COALESCE_MS);
  batcher.push('a');
  clock.advance(1);
  batcher.push('b');
  expect(emitted).toEqual(['a', 'b']);
});
