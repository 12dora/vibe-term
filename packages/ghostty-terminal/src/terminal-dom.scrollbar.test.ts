// 滚动条淡出改成 deadline：悬停以刷新率触发 showScrollbarTransient（120Hz 即每秒 120 次），
// 旧实现每次都 clearTimeout + setTimeout + 重写 style，这里只推后到期时间戳。
import { afterEach, describe, expect, test } from 'bun:test';
import { TerminalDomSurface } from './terminal-dom';
import {
  type FakeDom,
  type FakeElement,
  TEST_THEME,
  findElementByClass,
  installFakeDom,
} from './test-support/fake-dom';

type PendingTimer = { id: number; delay: number; run: () => void };

type TimerHarness = {
  pending: PendingTimer[];
  scheduled: number;
  cleared: number;
  advance(ms: number): void;
  restore(): void;
};

function installTimerHarness(): TimerHarness {
  const previous = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    performance: (globalThis as any).performance,
  };
  const pending: PendingTimer[] = [];
  const harness = {
    pending,
    scheduled: 0,
    cleared: 0,
    advance(ms: number): void {
      clock += ms;
    },
    restore(): void {
      (globalThis as any).setTimeout = previous.setTimeout;
      (globalThis as any).clearTimeout = previous.clearTimeout;
      (globalThis as any).performance = previous.performance;
    },
  };

  let clock = 0;
  let nextId = 1;
  (globalThis as any).performance = { now: () => clock };
  (globalThis as any).setTimeout = (callback: () => void, delay: number): number => {
    const id = nextId;
    nextId += 1;
    harness.scheduled += 1;
    pending.push({ id, delay, run: callback });
    return id;
  };
  (globalThis as any).clearTimeout = (id: number): void => {
    harness.cleared += 1;
    const index = pending.findIndex((timer) => timer.id === id);
    if (index >= 0) {
      pending.splice(index, 1);
    }
  };

  return harness;
}

function fireOldestTimer(harness: TimerHarness): void {
  const timer = harness.pending.shift();
  expect(timer).toBeDefined();
  timer?.run();
}

describe('滚动条淡出 deadline', () => {
  let dom: FakeDom | null = null;
  let timers: TimerHarness | null = null;

  afterEach(() => {
    timers?.restore();
    timers = null;
    dom?.restore();
    dom = null;
  });

  function setup(): { surface: TerminalDomSurface; thumb: FakeElement } {
    dom = installFakeDom();
    const surface = new TerminalDomSurface({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    surface.mount(container as unknown as HTMLElement);

    const thumb = findElementByClass(
      surface.element as unknown as FakeElement,
      'xterm-scrollbar-thumb'
    );
    expect(thumb).toBeDefined();
    timers = installTimerHarness();
    return { surface, thumb: thumb as FakeElement };
  }

  test('已可见时的连续调用不重建定时器', () => {
    const { surface, thumb } = setup();
    const harness = timers as TimerHarness;

    surface.showScrollbarTransient();
    expect(harness.scheduled).toBe(1);
    expect(thumb.style.opacity).toBe('1');

    for (let index = 0; index < 120; index += 1) {
      harness.advance(8);
      surface.showScrollbarTransient();
    }

    expect(harness.scheduled).toBe(1);
    expect(harness.cleared).toBe(0);
  });

  test('到点时 deadline 未过则续期，过了才隐藏', () => {
    const { surface, thumb } = setup();
    const harness = timers as TimerHarness;

    surface.showScrollbarTransient();
    harness.advance(1000);
    surface.showScrollbarTransient();

    // 第一只定时器在 t=3000 到点，但 deadline 已被推到 4000：续期而不是隐藏。
    harness.advance(2000);
    fireOldestTimer(harness);
    expect(thumb.style.opacity).toBe('1');
    expect(harness.scheduled).toBe(2);
    expect(harness.pending[0]?.delay).toBe(1000);

    harness.advance(1000);
    fireOldestTimer(harness);
    expect(thumb.style.opacity).toBe('0');
    expect(harness.pending.length).toBe(0);
  });

  test('失焦会立即隐藏并取消续期', () => {
    const { surface, thumb } = setup();
    const harness = timers as TimerHarness;

    surface.showScrollbarTransient();
    surface.setFocused(false);

    expect(thumb.style.opacity).toBe('0');
    expect(harness.pending.length).toBe(0);

    surface.showScrollbarTransient();
    expect(harness.scheduled).toBe(1);
  });
});
