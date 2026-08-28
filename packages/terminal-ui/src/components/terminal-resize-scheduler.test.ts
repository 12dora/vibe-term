import { describe, expect, test } from 'bun:test';
import { type TerminalResizeGate, TerminalResizeReporter } from './terminal-resize-reporter';
import {
  POST_SELECT_RETRY_MS,
  RESIZE_DEBOUNCE_MS,
  RafCoalescer,
  type ResizeSchedulerTimers,
  TerminalResizeScheduler,
} from './terminal-resize-scheduler';

interface ScheduledTimeout {
  at: number;
  handler: () => void;
}

class FakeClock {
  now = 0;
  private readonly timeouts = new Map<number, ScheduledTimeout>();
  private readonly frames = new Map<number, () => void>();
  private nextId = 1;

  readonly timers: ResizeSchedulerTimers = {
    setTimeout: (handler, ms) => {
      const id = this.nextId++;
      this.timeouts.set(id, { at: this.now + ms, handler });
      return id;
    },
    clearTimeout: (id) => {
      this.timeouts.delete(id);
    },
    requestAnimationFrame: (handler) => {
      const id = this.nextId++;
      this.frames.set(id, handler);
      return id;
    },
    cancelAnimationFrame: (id) => {
      this.frames.delete(id);
    },
  };

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.takeDueTimeout(target);
      if (!due) break;
      this.now = due.at;
      due.handler();
    }
    this.now = target;
  }

  flushFrames(): void {
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const handler of pending) handler();
  }

  get pendingFrames(): number {
    return this.frames.size;
  }

  get pendingTimeouts(): number {
    return this.timeouts.size;
  }

  private takeDueTimeout(target: number): ScheduledTimeout | null {
    let bestId: number | null = null;
    let best: ScheduledTimeout | null = null;
    for (const [id, entry] of this.timeouts) {
      if (entry.at > target) continue;
      if (!best || entry.at < best.at) {
        bestId = id;
        best = entry;
      }
    }
    if (bestId === null || !best) return null;
    this.timeouts.delete(bestId);
    return best;
  }
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createRecorder(): { calls: string[]; run: (label: string) => () => void } {
  const calls: string[] = [];
  return {
    calls,
    run: (label) => () => {
      calls.push(label);
    },
  };
}

describe('TerminalResizeScheduler', () => {
  test('默认路径：150ms 防抖 + 一帧 RAF 后才执行', () => {
    const clock = new FakeClock();
    const scheduler = new TerminalResizeScheduler(clock.timers);
    const recorder = createRecorder();

    scheduler.schedule(recorder.run('a'));
    clock.advance(RESIZE_DEBOUNCE_MS - 1);
    expect(clock.pendingFrames).toBe(0);

    clock.advance(1);
    expect(clock.pendingFrames).toBe(1);
    expect(recorder.calls).toEqual([]);

    clock.flushFrames();
    expect(recorder.calls).toEqual(['a']);
  });

  test('immediate 路径跳过防抖，仍等一帧 RAF', () => {
    const clock = new FakeClock();
    const scheduler = new TerminalResizeScheduler(clock.timers);
    const recorder = createRecorder();

    scheduler.schedule(recorder.run('a'), { immediate: true });
    expect(clock.pendingTimeouts).toBe(0);
    expect(recorder.calls).toEqual([]);

    clock.flushFrames();
    expect(recorder.calls).toEqual(['a']);
  });

  test('连续请求被合并：只有最后一次生效', () => {
    const clock = new FakeClock();
    const scheduler = new TerminalResizeScheduler(clock.timers);
    const recorder = createRecorder();

    scheduler.schedule(recorder.run('a'));
    clock.advance(10);
    scheduler.schedule(recorder.run('b'));
    clock.advance(10);
    scheduler.schedule(recorder.run('c'));
    clock.advance(RESIZE_DEBOUNCE_MS);
    clock.flushFrames();

    expect(recorder.calls).toEqual(['c']);
  });

  test('新请求会取消已排队的 RAF', () => {
    const clock = new FakeClock();
    const scheduler = new TerminalResizeScheduler(clock.timers);
    const recorder = createRecorder();

    scheduler.schedule(recorder.run('a'), { immediate: true });
    scheduler.schedule(recorder.run('b'), { immediate: true });
    expect(clock.pendingFrames).toBe(1);

    clock.flushFrames();
    expect(recorder.calls).toEqual(['b']);
  });

  test('dispose 取消待执行的 RAF', () => {
    const clock = new FakeClock();
    const scheduler = new TerminalResizeScheduler(clock.timers);
    const recorder = createRecorder();

    scheduler.schedule(recorder.run('a'));
    clock.advance(RESIZE_DEBOUNCE_MS);
    expect(clock.pendingFrames).toBe(1);

    scheduler.dispose();
    expect(clock.pendingFrames).toBe(0);
    clock.flushFrames();
    expect(recorder.calls).toEqual([]);
  });

  test('dispose 取消待执行的防抖定时器', () => {
    const clock = new FakeClock();
    const scheduler = new TerminalResizeScheduler(clock.timers);
    const recorder = createRecorder();

    scheduler.schedule(recorder.run('a'));
    scheduler.dispose();
    clock.advance(RESIZE_DEBOUNCE_MS);
    clock.flushFrames();

    expect(recorder.calls).toEqual([]);
  });

  test('runPostSelect：立即一次 + 60ms 重试 + 字体就绪重试', async () => {
    const clock = new FakeClock();
    const scheduler = new TerminalResizeScheduler(clock.timers);
    const recorder = createRecorder();
    const fonts = createDeferred();

    scheduler.runPostSelect(recorder.run('post'), () => fonts.promise);
    clock.flushFrames();
    expect(recorder.calls).toEqual(['post']);

    clock.advance(POST_SELECT_RETRY_MS);
    clock.flushFrames();
    expect(recorder.calls).toEqual(['post', 'post']);

    fonts.resolve();
    await fonts.promise;
    clock.flushFrames();
    expect(recorder.calls).toEqual(['post', 'post', 'post']);
  });

  test('runPostSelect：字体加载失败被吞掉，不额外触发', async () => {
    const clock = new FakeClock();
    const scheduler = new TerminalResizeScheduler(clock.timers);
    const recorder = createRecorder();
    const fonts = Promise.reject(new Error('font failure'));

    scheduler.runPostSelect(recorder.run('post'), () => fonts);
    clock.flushFrames();
    await fonts.catch(() => {});
    clock.flushFrames();

    expect(recorder.calls).toEqual(['post']);
  });

  test('runPostSelect：无字体接口时只保留立即与 60ms 两次', () => {
    const clock = new FakeClock();
    const scheduler = new TerminalResizeScheduler(clock.timers);
    const recorder = createRecorder();

    scheduler.runPostSelect(recorder.run('post'), () => null);
    clock.flushFrames();
    clock.advance(POST_SELECT_RETRY_MS);
    clock.flushFrames();

    expect(recorder.calls).toEqual(['post', 'post']);
  });

  test('再次 runPostSelect 会清掉上一轮的重试定时器', () => {
    const clock = new FakeClock();
    const scheduler = new TerminalResizeScheduler(clock.timers);
    const recorder = createRecorder();

    scheduler.runPostSelect(recorder.run('first'), () => null);
    clock.advance(POST_SELECT_RETRY_MS / 2);
    scheduler.runPostSelect(recorder.run('second'), () => null);
    clock.advance(POST_SELECT_RETRY_MS);
    clock.flushFrames();

    expect(recorder.calls).toEqual(['first', 'second', 'second']);
  });

  test('dispose 后重新调度仍可用（StrictMode 下 hook 复用同一实例）', () => {
    const clock = new FakeClock();
    const scheduler = new TerminalResizeScheduler(clock.timers);
    const recorder = createRecorder();

    scheduler.dispose();
    scheduler.schedule(recorder.run('after-dispose'), { immediate: true });
    clock.flushFrames();

    expect(recorder.calls).toEqual(['after-dispose']);
  });
});

describe('RafCoalescer', () => {
  test('同一帧内的多次请求只保留最后一次', () => {
    const clock = new FakeClock();
    const coalescer = new RafCoalescer(clock.timers);
    const recorder = createRecorder();

    coalescer.request(recorder.run('a'));
    coalescer.request(recorder.run('b'));
    expect(clock.pendingFrames).toBe(1);

    clock.flushFrames();
    expect(recorder.calls).toEqual(['b']);
  });

  test('cancel 取消待执行帧', () => {
    const clock = new FakeClock();
    const coalescer = new RafCoalescer(clock.timers);
    const recorder = createRecorder();

    coalescer.request(recorder.run('a'));
    coalescer.cancel();
    clock.flushFrames();

    expect(recorder.calls).toEqual([]);
  });
});

const GATE: TerminalResizeGate = {
  deviceId: 'device-1',
  paneId: 'pane-1',
  deviceConnected: true,
  isSelectionInvalid: false,
  sizingMode: 'report',
};

interface PipelineHarness {
  clock: FakeClock;
  scheduler: TerminalResizeScheduler;
  events: Array<{ kind: string; cols: number; rows: number }>;
  scheduleResize: (
    kind: 'resize' | 'sync',
    options?: { immediate?: boolean; force?: boolean }
  ) => void;
  runPostSelect: (fonts: () => Promise<unknown> | null) => void;
  setRect: (rect: { width: number; height: number } | null) => void;
}

function createPipeline(): PipelineHarness {
  const clock = new FakeClock();
  const scheduler = new TerminalResizeScheduler(clock.timers);
  const events: Array<{ kind: string; cols: number; rows: number }> = [];
  const state = { rect: { width: 800, height: 480 } as { width: number; height: number } | null };
  const terminal = {
    cols: 0,
    rows: 0,
    element: { tag: 'div' },
    _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
    resize: (cols: number, rows: number) => {
      terminal.cols = cols;
      terminal.rows = rows;
    },
  };

  const reporter = new TerminalResizeReporter({
    getTerminal: () => terminal,
    getProposer: () => ({ proposeDimensions: () => null }),
    getContainerRect: () => state.rect,
    getHandlers: () => ({
      onResize: (cols, rows) => events.push({ kind: 'resize', cols, rows }),
      onSync: (cols, rows) => events.push({ kind: 'sync', cols, rows }),
      onResizeSettled: (cols, rows) => events.push({ kind: 'settled', cols, rows }),
    }),
    now: () => clock.now,
  });

  const scheduleResize: PipelineHarness['scheduleResize'] = (kind, options = {}) => {
    const { immediate = false, force = false } = options;
    scheduler.schedule(() => reporter.report({ kind, force, gate: GATE }), { immediate });
  };

  return {
    clock,
    scheduler,
    events,
    scheduleResize,
    runPostSelect: (fonts) => {
      scheduler.runPostSelect(
        () => scheduleResize('sync', { immediate: true, force: true }),
        fonts
      );
    },
    setRect: (rect) => {
      state.rect = rect;
    },
  };
}

describe('resize 流水线特征行为', () => {
  test('初次挂载：runPostSelect 产出三次 force sync 上报', async () => {
    const pipeline = createPipeline();
    const fonts = createDeferred();

    pipeline.runPostSelect(() => fonts.promise);
    pipeline.clock.flushFrames();
    pipeline.clock.advance(POST_SELECT_RETRY_MS);
    pipeline.clock.flushFrames();
    fonts.resolve();
    await fonts.promise;
    pipeline.clock.flushFrames();

    expect(pipeline.events).toEqual([
      { kind: 'sync', cols: 80, rows: 24 },
      { kind: 'settled', cols: 80, rows: 24 },
      { kind: 'sync', cols: 80, rows: 24 },
      { kind: 'settled', cols: 80, rows: 24 },
      { kind: 'sync', cols: 80, rows: 24 },
      { kind: 'settled', cols: 80, rows: 24 },
    ]);
  });

  test('快速连续 resize 被合并成一次上报', () => {
    const pipeline = createPipeline();

    pipeline.setRect({ width: 400, height: 200 });
    pipeline.scheduleResize('resize');
    pipeline.clock.advance(20);
    pipeline.setRect({ width: 600, height: 300 });
    pipeline.scheduleResize('resize');
    pipeline.clock.advance(20);
    pipeline.setRect({ width: 800, height: 480 });
    pipeline.scheduleResize('resize');
    pipeline.clock.advance(RESIZE_DEBOUNCE_MS);
    pipeline.clock.flushFrames();

    expect(pipeline.events).toEqual([
      { kind: 'resize', cols: 80, rows: 24 },
      { kind: 'settled', cols: 80, rows: 24 },
    ]);
  });

  test('字体加载后的重试在尺寸未变时依然 force 上报', async () => {
    const pipeline = createPipeline();
    pipeline.scheduleResize('resize', { immediate: true });
    pipeline.clock.flushFrames();
    pipeline.events.length = 0;

    const fonts = Promise.resolve();
    pipeline.runPostSelect(() => fonts);
    pipeline.clock.flushFrames();
    pipeline.clock.advance(POST_SELECT_RETRY_MS);
    pipeline.clock.flushFrames();
    await fonts;
    pipeline.clock.flushFrames();

    expect(pipeline.events.filter((event) => event.kind === 'sync')).toHaveLength(3);
  });

  test('RAF 未执行时 dispose：不产生任何上报', () => {
    const pipeline = createPipeline();

    pipeline.scheduleResize('resize');
    pipeline.clock.advance(RESIZE_DEBOUNCE_MS);
    pipeline.scheduler.dispose();
    pipeline.clock.advance(POST_SELECT_RETRY_MS);
    pipeline.clock.flushFrames();

    expect(pipeline.events).toEqual([]);
  });

  test('容器隐藏（0×0）时整条链路静默', () => {
    const pipeline = createPipeline();
    pipeline.setRect({ width: 0, height: 0 });

    pipeline.runPostSelect(() => null);
    pipeline.clock.flushFrames();
    pipeline.clock.advance(POST_SELECT_RETRY_MS);
    pipeline.clock.flushFrames();
    pipeline.scheduleResize('resize');
    pipeline.clock.advance(RESIZE_DEBOUNCE_MS);
    pipeline.clock.flushFrames();

    expect(pipeline.events).toEqual([]);

    pipeline.setRect({ width: 800, height: 480 });
    pipeline.scheduleResize('resize');
    pipeline.clock.advance(RESIZE_DEBOUNCE_MS);
    pipeline.clock.flushFrames();

    expect(pipeline.events).toEqual([
      { kind: 'resize', cols: 80, rows: 24 },
      { kind: 'settled', cols: 80, rows: 24 },
    ]);
  });
});
