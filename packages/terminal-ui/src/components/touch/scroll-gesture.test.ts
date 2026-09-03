// 滚动渲染改成 rAF 合并后，buffer.active.viewportY 要到下一帧才更新，
// 「本次 move 是否真的滚动了」（决定 preventDefault）必须改由 scrollLines 的返回值给出。
import { describe, expect, test } from 'bun:test';
import { TouchScrollGesture } from './scroll-gesture';
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
