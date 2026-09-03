// 滚动条更新曾经是「写 thumb.style.height → 读 viewport.clientHeight」的闭环：
// height 影响布局，无条件重写让布局树每帧失效，下一次读 clientHeight 就得跑一遍
// 同步布局；而在 F1 之前这是每个 wheel / touchmove 事件一次。这里锁死两条：
// 值没变就不写样式、轨道高度只在容器尺寸变化后重新量。
import { afterEach, describe, expect, test } from 'bun:test';
import { TerminalDomSurface } from './terminal-dom';
import {
  type FakeDom,
  type FakeElement,
  TEST_THEME,
  findElementByClass,
  installFakeDom,
} from './test-support/fake-dom';

type StyleWrites = Record<string, number>;

// FakeElement.style 是普通对象：换成计数代理即可精确观察「真正写进 DOM 的样式」。
function countStyleWrites(element: FakeElement): StyleWrites {
  const writes: StyleWrites = {};
  const backing = element.style;
  element.style = new Proxy(backing, {
    set(target, property, value): boolean {
      const key = String(property);
      writes[key] = (writes[key] ?? 0) + 1;
      target[key] = String(value);
      return true;
    },
  });
  return writes;
}

type TrackHeightProbe = { reads: number; height: number };

function trackClientHeight(element: FakeElement, initial: number): TrackHeightProbe {
  const probe: TrackHeightProbe = { reads: 0, height: initial };
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get(): number {
      probe.reads += 1;
      return probe.height;
    },
  });
  return probe;
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly callback: () => void;
  observed: unknown[] = [];

  constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: unknown): void {
    this.observed.push(target);
  }

  disconnect(): void {}
}

describe('终端 DOM 外壳的布局读写缓存', () => {
  let dom: FakeDom | null = null;
  let previousResizeObserver: unknown;

  afterEach(() => {
    (globalThis as Record<string, unknown>).ResizeObserver = previousResizeObserver;
    FakeResizeObserver.instances = [];
    dom?.restore();
    dom = null;
  });

  function setup(trackPixels: number) {
    dom = installFakeDom();
    previousResizeObserver = (globalThis as Record<string, unknown>).ResizeObserver;
    (globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;

    const surface = new TerminalDomSurface({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    surface.mount(container as unknown as HTMLElement);

    const root = surface.element as unknown as FakeElement;
    const viewport = findElementByClass(root, 'xterm-viewport') as FakeElement;
    const thumb = findElementByClass(root, 'xterm-scrollbar-thumb') as FakeElement;
    const track = trackClientHeight(viewport, trackPixels);
    const writes = countStyleWrites(thumb);
    return { surface, root, viewport, thumb, track, writes };
  }

  test('终端根节点自成布局 / 绘制隔离单元', () => {
    const { surface, root } = setup(480);

    expect(root.style.contain).toBe('layout paint style');
    surface.cancelScrollbarFade();
  });

  test('纯滚动只写 transform：height / opacity 值未变则一次都不写', () => {
    const { surface, thumb, track, writes } = setup(480);

    surface.showScrollbarTransient();
    expect(writes.opacity).toBe(1);

    for (let offset = 0; offset < 40; offset += 1) {
      surface.updateScrollbar({ total: 200, offset, len: 24 });
    }

    // 40 次滚动：thumb 高度是常数，只有合成器属性 transform 在变
    expect(writes.height).toBe(1);
    expect(writes.opacity).toBe(1);
    expect(writes.transform).toBe(40);
    // 轨道高度也只量了一次，不再每次滚动强制一遍同步布局
    expect(track.reads).toBe(1);
    expect(thumb.style.opacity).toBe('1');
    surface.cancelScrollbarFade();
  });

  test('同一个偏移重复更新不产生任何样式写', () => {
    const { surface, writes } = setup(480);

    surface.showScrollbarTransient();
    surface.updateScrollbar({ total: 200, offset: 30, len: 24 });
    const baseline = { ...writes };

    for (let index = 0; index < 10; index += 1) {
      surface.updateScrollbar({ total: 200, offset: 30, len: 24 });
    }

    expect(writes).toEqual(baseline);
    surface.cancelScrollbarFade();
  });

  test('容器尺寸变化后轨道高度重新量', () => {
    const { surface, thumb, track } = setup(480);

    surface.updateScrollbar({ total: 200, offset: 0, len: 24 });
    const firstHeight = thumb.style.height;
    expect(track.reads).toBe(1);

    track.height = 240;
    surface.updateScrollbar({ total: 200, offset: 0, len: 24 });
    // 还没收到 resize 通知：仍用缓存值
    expect(thumb.style.height).toBe(firstHeight);
    expect(track.reads).toBe(1);

    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer?.observed.length).toBe(1);
    observer?.callback();

    surface.updateScrollbar({ total: 200, offset: 0, len: 24 });
    expect(track.reads).toBe(2);
    expect(thumb.style.height).not.toBe(firstHeight);
    surface.cancelScrollbarFade();
  });

  test('未布局（clientHeight 为 0）不写进缓存，量到真实高度后立刻生效', () => {
    const { surface, thumb, track } = setup(0);

    surface.updateScrollbar({ total: 200, offset: 0, len: 24 });
    expect(thumb.style.height).toBeUndefined();

    track.height = 480;
    surface.updateScrollbar({ total: 200, offset: 0, len: 24 });
    expect(Number.parseFloat(thumb.style.height)).toBeCloseTo(57.6, 5);
    surface.cancelScrollbarFade();
  });
});
