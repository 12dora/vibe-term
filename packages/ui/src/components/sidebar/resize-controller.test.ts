import { describe, expect, test } from 'bun:test';
import { SIDEBAR_WIDTH_MIN_PX } from './constants';
import { type SidebarResizeHost, createSidebarResizeController } from './resize-controller';

function harness() {
  const widths: number[] = [];
  const resizing: boolean[] = [];
  let commits = 0;
  let frames: (() => void)[] = [];

  const host: SidebarResizeHost = {
    setWidth: (width) => widths.push(width),
    commitWidth: () => {
      commits += 1;
    },
    setResizing: (value) => resizing.push(value),
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: (handle) => {
      frames = frames.filter((_, index) => index !== (handle as number) - 1);
    },
  };

  return {
    controller: createSidebarResizeController(host),
    widths,
    resizing,
    commits: () => commits,
    runFrame: () => {
      const pending = frames;
      frames = [];
      for (const frame of pending) frame();
    },
    pendingFrames: () => frames.length,
  };
}

const START_WIDTH = SIDEBAR_WIDTH_MIN_PX + 100;

describe('createSidebarResizeController', () => {
  test('一帧内的多次 pointermove 只提交最后一次采样', () => {
    const h = harness();
    h.controller.start(1, 500, START_WIDTH);
    for (const x of [510, 520, 530, 540]) {
      h.controller.move(1, x, 'left');
    }

    expect(h.widths).toEqual([]);
    expect(h.pendingFrames()).toBe(1);

    h.runFrame();
    expect(h.widths).toEqual([START_WIDTH + 40]);
  });

  test('一次拖拽只落盘一次，不是每个 pointermove 一次', () => {
    const h = harness();
    h.controller.start(1, 500, START_WIDTH);
    for (let i = 1; i <= 20; i += 1) {
      h.controller.move(1, 500 + i, 'left');
      if (i % 4 === 0) h.runFrame();
    }
    expect(h.commits()).toBe(0);

    h.controller.end(1);
    expect(h.commits()).toBe(1);
    expect(h.widths.at(-1)).toBe(START_WIDTH + 20);
    expect(h.resizing).toEqual([true, false]);
  });

  test('收尾会把最后一次未上屏的采样补上', () => {
    const h = harness();
    h.controller.start(1, 500, START_WIDTH);
    h.controller.move(1, 560, 'left');
    h.controller.end(1);

    expect(h.widths).toEqual([START_WIDTH + 60]);
    expect(h.pendingFrames()).toBe(0);
    expect(h.commits()).toBe(1);
  });

  test('右侧栏按相反方向换算宽度', () => {
    const h = harness();
    h.controller.start(1, 500, START_WIDTH);
    h.controller.move(1, 460, 'right');
    h.controller.end(1);
    expect(h.widths).toEqual([START_WIDTH + 40]);
  });

  test('别的指针 id 的事件一律忽略', () => {
    const h = harness();
    h.controller.start(1, 500, START_WIDTH);
    h.controller.move(2, 700, 'left');
    h.controller.end(2);

    expect(h.widths).toEqual([]);
    expect(h.commits()).toBe(0);
    expect(h.resizing).toEqual([true]);
  });

  test('拖拽途中被卸载（如侧栏折叠）也会收尾并落盘', () => {
    const h = harness();
    h.controller.start(1, 500, START_WIDTH);
    h.controller.move(1, 550, 'left');
    h.controller.dispose();

    expect(h.widths).toEqual([START_WIDTH + 50]);
    expect(h.commits()).toBe(1);
    expect(h.resizing).toEqual([true, false]);
  });

  test('无拖拽时卸载不落盘，只清掉挂着的帧', () => {
    const h = harness();
    h.controller.dispose();
    expect(h.commits()).toBe(0);
    expect(h.resizing).toEqual([]);
  });

  test('没有 rAF 的环境退回同步应用', () => {
    const widths: number[] = [];
    const controller = createSidebarResizeController({
      setWidth: (width) => widths.push(width),
      commitWidth: () => undefined,
      setResizing: () => undefined,
      requestFrame: () => null,
      cancelFrame: () => undefined,
    });
    controller.start(1, 500, START_WIDTH);
    controller.move(1, 530, 'left');
    expect(widths).toEqual([START_WIDTH + 30]);
  });
});
