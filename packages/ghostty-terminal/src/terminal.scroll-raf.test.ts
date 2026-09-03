// 滚动渲染的 rAF 合并（第二十一轮 F1）：wheel / touchmove 以 60–120Hz 派发，
// 每个事件同步跑一遍全渲染时，一帧内除最后一次以外的结果全被覆盖，还把合成器堵在
// 事件处理器里。这里锁死三条语义：同帧多次滚动只出一帧、贴边滚动不排帧且如实回报
// 「没滚动」、手势结束后终态一定落到屏上。
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import {
  type FakeBindings,
  type FakeDom,
  TEST_THEME,
  createFakeBindings,
  installFakeDom,
  mockGhosttyWasm,
  restoreRealTerminalModules,
} from './test-support/fake-dom';

const VIEWPORT_ROWS = 24;
const SCROLLBACK_TOTAL = 200;

const renderSpy = { count: 0 };

async function loadControllerModule(bindings: FakeBindings, version: number) {
  mock.restore();
  mockGhosttyWasm(bindings);
  mock.module('./render-state', () => {
    const rows = Array.from({ length: VIEWPORT_ROWS }, (_, index) => ({
      y: index,
      dirty: true,
      wrap: false,
      wrapContinuation: false,
      text: '',
      cells: [],
    }));

    return {
      createRenderState: () => ({ snapshotVersion: 0, appliedScrollDelta: 0, disposed: false }),
      updateRenderState: (state: { snapshotVersion: number }) => {
        renderSpy.count += 1;
        state.snapshotVersion += 1;
      },
      readRenderSnapshotMeta: () => ({
        cols: 80,
        rows: VIEWPORT_ROWS,
        dirty: 'full',
        colors: {
          background: { r: 17, g: 17, b: 17 },
          foreground: { r: 238, g: 238, b: 238 },
          cursor: null,
          palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
        },
        cursor: {
          style: 'block',
          visible: false,
          blinking: false,
          passwordInput: false,
          x: null,
          y: null,
          wideTail: false,
        },
      }),
      iterateRows: function* () {
        yield* rows;
      },
      disposeRenderStateResources: (state: { disposed: boolean }) => {
        state.disposed = true;
      },
    };
  });

  return import(`./terminal.ts?scroll-raf=${version}`);
}

// 可滚 scrollback 的 bindings：readScrollbar 与 scrollViewportDelta 共享同一个 offset，
// 并按内核语义夹取到 [0, total-len]，贴边滚动才是真的空操作。
function installScrollableViewport(bindings: FakeBindings, initialOffset: number) {
  const maxOffset = SCROLLBACK_TOTAL - VIEWPORT_ROWS;
  const state = { offset: Math.max(0, Math.min(maxOffset, initialOffset)) };

  bindings.readScrollbar = () => ({
    total: SCROLLBACK_TOTAL,
    offset: state.offset,
    len: VIEWPORT_ROWS,
  });
  bindings.scrollViewportDelta = (_terminal: number, amount: number) => {
    state.offset = Math.max(0, Math.min(maxOffset, state.offset + amount));
  };
  bindings.scrollViewportTop = () => {
    state.offset = 0;
  };
  bindings.scrollViewportBottom = () => {
    state.offset = maxOffset;
  };

  return { state, maxOffset };
}

describe('GhosttyTerminalController scroll render scheduling', () => {
  let dom: FakeDom | null = null;
  let importVersion = 0;

  afterEach(() => {
    dom?.restore();
    dom = null;
    mock.restore();
  });

  afterAll(restoreRealTerminalModules);

  async function openTerminal(bindings: FakeBindings) {
    importVersion += 1;
    const { createTerminalController } = await loadControllerModule(bindings, importVersion);
    const terminal = await createTerminalController({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });
    const activeDom = dom as FakeDom;
    const container = activeDom.document.createElement('div');
    container.setBoundingClientRect({ width: 800, height: 480 });
    activeDom.document.body.appendChild(container);
    terminal.open(container as unknown as HTMLElement);
    await activeDom.flushAnimationFrames();
    renderSpy.count = 0;
    return terminal;
  }

  test('同一帧内滚动多次只渲染一次，且终态在下一帧落到屏上', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    const { state } = installScrollableViewport(bindings, 100);
    const terminal = await openTerminal(bindings);

    expect(terminal.scrollLines(1)).toBeTrue();
    expect(terminal.scrollLines(1)).toBeTrue();
    expect(terminal.scrollLines(1)).toBeTrue();

    // 三次滚动都已落到内核，但一帧都还没画
    expect(state.offset).toBe(103);
    expect(renderSpy.count).toBe(0);
    expect((dom as FakeDom).pendingAnimationFrames()).toBe(1);

    await (dom as FakeDom).flushAnimationFrames();

    expect(renderSpy.count).toBe(1);
    expect(terminal.buffer.active.viewportY).toBe(103);
    terminal.dispose();
  });

  test('手势结束后不会停在过期帧上', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    installScrollableViewport(bindings, 50);
    const terminal = await openTerminal(bindings);

    for (let index = 0; index < 5; index += 1) {
      terminal.scrollLines(-1);
    }
    // 最后一个事件之后没有任何额外调用，仅靠已排队的 rAF 也必须把终态画出来
    await (dom as FakeDom).flushAnimationFrames();

    expect(renderSpy.count).toBe(1);
    expect(terminal.buffer.active.viewportY).toBe(45);
    expect((dom as FakeDom).pendingAnimationFrames()).toBe(0);
    terminal.dispose();
  });

  test('贴顶滚动如实回报「没滚动」，且不排帧', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    installScrollableViewport(bindings, 0);
    const terminal = await openTerminal(bindings);

    expect(terminal.scrollLines(-5)).toBeFalse();
    expect(renderSpy.count).toBe(0);
    expect((dom as FakeDom).pendingAnimationFrames()).toBe(0);
    terminal.dispose();
  });

  test('贴底滚动同样回报「没滚动」', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    const { maxOffset } = installScrollableViewport(bindings, SCROLLBACK_TOTAL);
    const terminal = await openTerminal(bindings);

    expect(terminal.buffer.active.viewportY).toBe(maxOffset);
    expect(terminal.scrollLines(3)).toBeFalse();
    expect((dom as FakeDom).pendingAnimationFrames()).toBe(0);
    terminal.dispose();
  });

  test('滚轮手势仍被消费（preventDefault 语义不变），一帧只画一次', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    const { state } = installScrollableViewport(bindings, 80);
    const terminal = await openTerminal(bindings);

    const gesture = {
      source: 'wheel' as const,
      deltaX: 0,
      deltaY: 1,
      deltaMode: 1,
      clientX: 0,
      clientY: 0,
    };
    expect(terminal.handleViewportGesture(gesture)).toBeTrue();
    expect(terminal.handleViewportGesture(gesture)).toBeTrue();

    expect(state.offset).toBe(82);
    expect(renderSpy.count).toBe(0);

    await (dom as FakeDom).flushAnimationFrames();
    expect(renderSpy.count).toBe(1);
    terminal.dispose();
  });

  test('跳顶 / 跳底保持同步渲染：调用方紧接着就读 viewportY', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    installScrollableViewport(bindings, 100);
    const terminal = await openTerminal(bindings);

    expect(terminal.scrollToBottom()).toBeTrue();
    expect(terminal.buffer.active.viewportY).toBe(SCROLLBACK_TOTAL - VIEWPORT_ROWS);
    expect(renderSpy.count).toBe(1);
    terminal.dispose();
  });
});
