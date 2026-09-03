// 滚动渲染改成 rAF 合并后，buffer.active.viewportY 要到下一帧才更新，
// 「本次 move 是否真的滚动了」（决定 preventDefault）必须改由 scrollLines 的返回值给出。
import { describe, expect, test } from 'bun:test';
import { FLING_MAX_VELOCITY_PX, TouchScrollGesture, flingVelocityPerFrame } from './scroll-gesture';
import { FALLBACK_CELL_HEIGHT_PX } from './touch-geometry';
import type { TerminalScroller } from './types';

// 一次 move 至少要推出一整行：增益 1.3，18px 行高 ⇒ 15px 位移足够。
const ONE_LINE_DELTA = Math.ceil(FALLBACK_CELL_HEIGHT_PX / 1.3) + 1;

function createGesture(): TouchScrollGesture {
  return new TouchScrollGesture({} as unknown as Element);
}

// handleViewportGesture 缺席 ⇒ 走 scrollLinesDirect 分支。
function reportingTerminal(reported: boolean | undefined): {
  terminal: TerminalScroller;
  amounts: number[];
} {
  const amounts: number[] = [];
  const terminal: TerminalScroller = {
    scrollLines: (amount: number) => {
      amounts.push(amount);
      return reported;
    },
    buffer: { active: { viewportY: 40 } },
  };
  return { terminal, amounts };
}

describe('TouchScrollGesture 的 didScroll 判定', () => {
  test('scrollLines 报告滚动成功即视为已消费，无需等 viewportY 更新', () => {
    const gesture = createGesture();
    const { terminal, amounts } = reportingTerminal(true);

    const outcome = gesture.applyVerticalDelta(() => terminal, ONE_LINE_DELTA, 10, 20);

    expect(amounts).toEqual([1]);
    // viewportY 一动不动（渲染排到了下一帧），但手势必须判为已消费
    expect(terminal.buffer?.active?.viewportY).toBe(40);
    expect(outcome).toEqual({ didScroll: true, atTopWhilePullingDown: false });
  });

  test('贴顶时 scrollLines 报告未滚动 ⇒ 不消费，交还原生（下拉刷新语义）', () => {
    const gesture = createGesture();
    const { terminal, amounts } = reportingTerminal(false);

    const outcome = gesture.applyVerticalDelta(() => terminal, -ONE_LINE_DELTA, 10, 20);

    expect(amounts).toEqual([-1]);
    expect(outcome).toEqual({ didScroll: false, atTopWhilePullingDown: true });
  });

  test('贴底时同样不消费，但不是「下拉到顶」', () => {
    const gesture = createGesture();
    const { terminal } = reportingTerminal(false);

    const outcome = gesture.applyVerticalDelta(() => terminal, ONE_LINE_DELTA, 10, 20);

    expect(outcome).toEqual({ didScroll: false, atTopWhilePullingDown: false });
  });

  test('不足一行的位移不调用 scrollLines', () => {
    const gesture = createGesture();
    const { terminal, amounts } = reportingTerminal(true);

    const outcome = gesture.applyVerticalDelta(() => terminal, 2, 10, 20);

    expect(amounts).toEqual([]);
    expect(outcome).toEqual({ didScroll: false, atTopWhilePullingDown: false });
  });

  test('返回 void 的旧终端回落到 viewportY 前后差比对', () => {
    const gesture = createGesture();
    const amounts: number[] = [];
    const buffer = { active: { viewportY: 40 } };
    const terminal: TerminalScroller = {
      scrollLines: (amount: number) => {
        amounts.push(amount);
        buffer.active.viewportY += amount;
      },
      buffer,
    };

    const outcome = gesture.applyVerticalDelta(() => terminal, ONE_LINE_DELTA, 10, 20);

    expect(amounts).toEqual([1]);
    expect(outcome).toEqual({ didScroll: true, atTopWhilePullingDown: false });
  });
});

// ---- 抬指惯性（T7）----

interface FakeFrames {
  requestFrame: (callback: () => void) => unknown | null;
  cancelFrame: (handle: unknown) => void;
  runFrame: () => boolean;
  pending: () => number;
}

function fakeFrames(): FakeFrames {
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
      if (entries.length === 0) return false;
      queue.clear();
      for (const [, callback] of entries) callback();
      return true;
    },
    pending: () => queue.size,
  };
}

// 可控时钟：每次 now() 前由测试显式推进。
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let time = 1000;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

function alwaysScrollingTerminal(): { terminal: TerminalScroller; amounts: number[] } {
  const amounts: number[] = [];
  const terminal: TerminalScroller = {
    scrollLines: (amount: number) => {
      amounts.push(amount);
      return true;
    },
    buffer: { active: { viewportY: 500 } },
  };
  return { terminal, amounts };
}

interface FlingHarness {
  gesture: TouchScrollGesture;
  frames: FakeFrames;
  clock: { now: () => number; advance: (ms: number) => void };
  amounts: number[];
  terminal: TerminalScroller;
  /** 模拟一次匀速上滑手势（手指往上 ⇒ deltaY 为正 ⇒ 向下滚） */
  swipeUp: (steps: number, pxPerStep: number, msPerStep: number) => void;
}

function createFlingHarness(prefersReducedMotion = false): FlingHarness {
  const frames = fakeFrames();
  const clock = fakeClock();
  const { terminal, amounts } = alwaysScrollingTerminal();
  const gesture = new TouchScrollGesture({} as unknown as Element, {
    frames: { requestFrame: frames.requestFrame, cancelFrame: frames.cancelFrame },
    now: clock.now,
    prefersReducedMotion: () => prefersReducedMotion,
  });
  const resolve = () => terminal;

  return {
    gesture,
    frames,
    clock,
    amounts,
    terminal,
    swipeUp: (steps, pxPerStep, msPerStep) => {
      let y = 600;
      gesture.anchorSingle(y);
      for (let i = 0; i < steps; i += 1) {
        clock.advance(msPerStep);
        y -= pxPerStep;
        const delta = gesture.takeVerticalDelta(y);
        gesture.applyVerticalDelta(resolve, delta, 10, y);
      }
    },
  };
}

describe('TouchScrollGesture 的抬指惯性', () => {
  test('快速上滑抬指后按指数衰减继续滚动，最终自行停止', () => {
    const harness = createFlingHarness();
    harness.swipeUp(6, 40, 16);
    const duringGesture = harness.amounts.length;
    expect(duringGesture).toBeGreaterThan(0);

    harness.gesture.endGesture();
    expect(harness.frames.pending()).toBe(1);

    let frameCount = 0;
    while (harness.frames.runFrame()) {
      frameCount += 1;
      if (frameCount > 500) throw new Error('惯性没有停止');
    }

    // 惯性确实继续喂了 scrollLines，且全部朝同一方向（向下滚 ⇒ 正数）
    const inertiaAmounts = harness.amounts.slice(duringGesture);
    expect(inertiaAmounts.length).toBeGreaterThan(3);
    expect(inertiaAmounts.every((amount) => amount > 0)).toBe(true);
    // 衰减：末尾的单帧行数不超过起始（0.95^n 单调下降）
    expect(inertiaAmounts[inertiaAmounts.length - 1] as number).toBeLessThanOrEqual(
      inertiaAmounts[0] as number
    );
    expect(harness.frames.pending()).toBe(0);
  });

  test('惯性途中 touchstart（anchorSingle）立刻取消', () => {
    const harness = createFlingHarness();
    harness.swipeUp(6, 40, 16);
    harness.gesture.endGesture();

    harness.frames.runFrame();
    expect(harness.frames.pending()).toBe(1);
    const beforeAnchor = harness.amounts.length;

    harness.gesture.anchorSingle(300);
    expect(harness.frames.pending()).toBe(0);

    harness.frames.runFrame();
    expect(harness.amounts.length).toBe(beforeAnchor);
  });

  test('慢速挪动（速度低于起始阈值）不产生惯性', () => {
    const harness = createFlingHarness();
    // 每 16 ms 走 1 px ≈ 1 px/帧，远低于 4 px/帧的起始阈值
    harness.swipeUp(40, 1, 16);
    const duringGesture = harness.amounts.length;
    expect(duringGesture).toBeGreaterThan(0);

    harness.gesture.endGesture();

    expect(harness.frames.pending()).toBe(0);
    expect(harness.amounts.length).toBe(duringGesture);
  });

  test('未真正滚过的手势（无终端上下文）不产生惯性', () => {
    const harness = createFlingHarness();
    harness.gesture.anchorSingle(600);
    harness.clock.advance(16);
    harness.gesture.takeVerticalDelta(560);

    harness.gesture.endGesture();

    expect(harness.frames.pending()).toBe(0);
  });

  test('prefers-reduced-motion 下关闭惯性', () => {
    const harness = createFlingHarness(true);
    harness.swipeUp(6, 40, 16);
    const duringGesture = harness.amounts.length;

    harness.gesture.endGesture();

    expect(harness.frames.pending()).toBe(0);
    expect(harness.amounts.length).toBe(duringGesture);
  });

  test('无 rAF 的宿主不做惯性（不同步一次性甩完）', () => {
    const clock = fakeClock();
    const { terminal, amounts } = alwaysScrollingTerminal();
    const gesture = new TouchScrollGesture({} as unknown as Element, {
      frames: { requestFrame: () => null, cancelFrame: () => {} },
      now: clock.now,
      prefersReducedMotion: () => false,
    });

    let y = 600;
    gesture.anchorSingle(y);
    for (let i = 0; i < 6; i += 1) {
      clock.advance(16);
      y -= 40;
      gesture.applyVerticalDelta(() => terminal, gesture.takeVerticalDelta(y), 10, y);
    }
    const duringGesture = amounts.length;

    gesture.endGesture();

    expect(amounts.length).toBe(duringGesture);
  });
});

describe('flingVelocityPerFrame', () => {
  test('只取窗口内的取样，换算成每帧位移（手指上滑为正）', () => {
    const samples = [
      { time: 0, y: 900 },
      { time: 900, y: 800 },
      { time: 950, y: 700 },
      { time: 1000, y: 600 },
    ];
    // 窗口 100 ms：只保留 t=900/950/1000 三点，位移 200 px / 100 ms
    const velocity = flingVelocityPerFrame(samples, 1000, 100, 16);
    expect(velocity).toBeCloseTo(32, 5);
  });

  test('取样不足两点或零耗时返回 0', () => {
    expect(flingVelocityPerFrame([{ time: 1000, y: 600 }], 1000)).toBe(0);
    expect(
      flingVelocityPerFrame(
        [
          { time: 1000, y: 700 },
          { time: 1000, y: 600 },
        ],
        1000
      )
    ).toBe(0);
  });

  test('离谱速度被钳到上限', () => {
    const velocity = flingVelocityPerFrame(
      [
        { time: 999, y: 5000 },
        { time: 1000, y: 0 },
      ],
      1000
    );
    expect(velocity).toBe(FLING_MAX_VELOCITY_PX);
  });
});
