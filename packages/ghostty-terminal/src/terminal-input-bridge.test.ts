// 滚轮余量的复位契约：resetPointerAccumulation（清除选择时调用）必须把纵向与横向
// 两条像素累加器一起清零，否则残留的半格余量会让下一次滚动提前跨格。
import { describe, expect, test } from 'bun:test';
import type { GhosttyBindings } from './ghostty-wasm';
import {
  type InputBridgeHost,
  type TerminalHandles,
  TerminalInputBridge,
} from './terminal-input-bridge';
import { GHOSTTY_MOUSE_BUTTON_LEFT } from './terminal-pointer';
import type { GhosttyViewportGesture } from './types';

type MouseEncodeOptions = Parameters<GhosttyBindings['encodeMouseEvent']>[2];

const CELL_WIDTH = 9;
const CELL_HEIGHT = 16;
const MOUSE_REPORTING_MODES = new Set([1000, 1006]);

type FakeTimer = { at: number; callback: () => void };

// 合并窗口用假时钟驱动：真实 setTimeout 会让「5ms 后第二次手势」这类断言变成竞态。
function createClock() {
  const timers = new Map<number, FakeTimer>();
  let now = 1000;
  let nextId = 1;

  return {
    get pending(): number {
      return timers.size;
    },
    timing: {
      windowMs: 16,
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
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
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

type Harness = {
  bridge: TerminalInputBridge;
  mouseCalls: MouseEncodeOptions[];
  scrolled: number[];
  emitted: string[];
  modeQueries: number[];
  clock: ReturnType<typeof createClock>;
  setMode(mode: number, enabled: boolean): void;
};

function createHarness(
  modes: ReadonlySet<number> = MOUSE_REPORTING_MODES,
  scrollResult?: boolean
): Harness {
  const mouseCalls: MouseEncodeOptions[] = [];
  const scrolled: number[] = [];
  const emitted: string[] = [];
  const modeQueries: number[] = [];
  const activeModes = new Set(modes);
  const clock = createClock();

  const bindings = {
    isTerminalModeEnabled: (_terminal: number, mode: number) => {
      modeQueries.push(mode);
      return activeModes.has(mode);
    },
    setTerminalMode: () => {},
    resetMouseEncoder: () => {},
    encodeMouseEvent: (_encoder: number, _terminal: number, options: MouseEncodeOptions) => {
      mouseCalls.push(options);
      // 编码器只认 options.modes（桥接层的按代缓存），不再自己问 WASM
      return options.modes?.(1000) === false ? null : `mouse:${options.button ?? 'none'}`;
    },
    encodeKeyEvent: () => 'key',
    encodePaste: () => 'paste',
  } as unknown as GhosttyBindings;

  const handles: TerminalHandles = { terminal: 1, keyEncoder: 2, mouseEncoder: 3 };
  const host: InputBridgeHost = {
    cellDimensions: () => ({ width: CELL_WIDTH, height: CELL_HEIGHT }),
    screenBounds: () => ({ left: 0, top: 0, width: 960, height: 480 }),
    isInputDisabled: () => false,
    emitData: (data: string) => {
      emitted.push(data);
    },
    viewportCols: () => 80,
    viewportRows: () => 24,
    scrollLines: (amount: number) => {
      scrolled.push(amount);
      return scrollResult;
    },
  };

  return {
    bridge: new TerminalInputBridge(bindings, handles, host, clock.timing),
    mouseCalls,
    scrolled,
    emitted,
    modeQueries,
    clock,
    setMode: (mode: number, enabled: boolean) => {
      if (enabled) {
        activeModes.add(mode);
      } else {
        activeModes.delete(mode);
      }
    },
  };
}

function wheel(deltaX: number, deltaY: number): GhosttyViewportGesture {
  return {
    source: 'wheel',
    deltaX,
    deltaY,
    deltaMode: 0,
    clientX: 40,
    clientY: 30,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  };
}

describe('TerminalInputBridge.resetPointerAccumulation', () => {
  test('横向滚动余量在复位后从零开始（partial horizontal scroll → clearSelection/reset → new scroll starts from zero）', () => {
    const { bridge, mouseCalls } = createHarness();

    // 5px < 9px cell：只累积不产出
    bridge.handleViewportGesture(wheel(5, 0));
    expect(mouseCalls.length).toBe(0);

    bridge.resetPointerAccumulation();

    // 复位后再来 5px 仍不足一格；若余量残留会凑成 10px → 误报一次按钮 7
    bridge.handleViewportGesture(wheel(5, 0));
    expect(mouseCalls.length).toBe(0);

    // 复位只清余量，不影响正常的整格换算
    bridge.handleViewportGesture(wheel(4, 0));
    expect(mouseCalls.map((call) => call.button)).toEqual([7]);
  });

  test('未复位时横向余量正常跨事件累积', () => {
    const { bridge, mouseCalls } = createHarness();

    bridge.handleViewportGesture(wheel(5, 0));
    bridge.handleViewportGesture(wheel(5, 0));

    expect(mouseCalls.map((call) => call.button)).toEqual([7]);
  });

  test('纵向余量同样在复位后清零', () => {
    const { bridge, scrolled } = createHarness(new Set());

    bridge.handleViewportGesture(wheel(0, 10));
    expect(scrolled).toEqual([]);

    bridge.resetPointerAccumulation();

    bridge.handleViewportGesture(wheel(0, 10));
    expect(scrolled).toEqual([]);

    bridge.handleViewportGesture(wheel(0, 6));
    expect(scrolled).toEqual([1]);
  });

  test('复位同时清空已按下按钮记录', () => {
    const { bridge } = createHarness();

    bridge.mouse.pressedButtons.add(1);
    bridge.resetPointerAccumulation();

    expect(bridge.mouse.pressedButtons.size).toBe(0);
  });
});

describe('TerminalInputBridge.handleViewportGesture local scroll result', () => {
  test('returns the host boundary result instead of consuming a clamped scroll', () => {
    const { bridge, scrolled } = createHarness(new Set(), false);

    expect(bridge.handleViewportGesture(wheel(0, CELL_HEIGHT))).toBeFalse();
    expect(scrolled).toEqual([1]);
  });

  test('keeps the legacy consumed fallback when the host returns void', () => {
    const { bridge, scrolled } = createHarness(new Set());

    expect(bridge.handleViewportGesture(wheel(0, CELL_HEIGHT))).toBeTrue();
    expect(scrolled).toEqual([1]);
  });
});

function touch(deltaY: number): GhosttyViewportGesture {
  return {
    source: 'touch',
    deltaX: 0,
    deltaY,
    deltaMode: 0,
    clientX: 40,
    clientY: 30,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  };
}

describe('TerminalInputBridge 滚轮上报的合并窗口', () => {
  test('一次滚轮通知的 N 行合成一条 emitData', () => {
    const { bridge, mouseCalls, emitted } = createHarness();

    expect(bridge.handleViewportGesture(wheel(0, CELL_HEIGHT * 5))).toBeTrue();

    expect(mouseCalls.length).toBe(5);
    expect(emitted).toEqual(['mouse:5'.repeat(5)]);
  });

  test('5ms 后的第二次手势落进尾随窗口，窗口关闭时一次发出', () => {
    const { bridge, emitted, clock } = createHarness();

    bridge.handleViewportGesture(wheel(0, CELL_HEIGHT * 2));
    expect(emitted).toEqual(['mouse:5mouse:5']);

    clock.advance(5);
    bridge.handleViewportGesture(wheel(0, CELL_HEIGHT));
    bridge.handleViewportGesture(wheel(0, CELL_HEIGHT));
    expect(emitted.length).toBe(1);

    clock.advance(16);
    expect(emitted).toEqual(['mouse:5mouse:5', 'mouse:5mouse:5']);
    expect(clock.pending).toBe(0);
  });

  test('触摸惯性帧走同一条合并窗口', () => {
    const { bridge, emitted, clock } = createHarness();

    bridge.handleViewportGesture(touch(CELL_HEIGHT));
    clock.advance(4);
    bridge.handleViewportGesture(touch(CELL_HEIGHT));
    clock.advance(4);
    bridge.handleViewportGesture(touch(CELL_HEIGHT));

    expect(emitted).toEqual(['mouse:5']);
    clock.advance(16);
    expect(emitted).toEqual(['mouse:5', 'mouse:5mouse:5']);
  });

  test('窗口挂起时的其他鼠标输入先把批次发出去再发自己', () => {
    const { bridge, emitted, clock } = createHarness();

    bridge.handleViewportGesture(wheel(0, CELL_HEIGHT));
    clock.advance(2);
    bridge.handleViewportGesture(wheel(0, CELL_HEIGHT));

    expect(
      bridge.emitMouseInput({
        action: 'press',
        button: GHOSTTY_MOUSE_BUTTON_LEFT,
        clientX: 40,
        clientY: 30,
        mods: 0,
        anyButtonPressed: true,
      })
    ).toBeTrue();

    expect(emitted).toEqual(['mouse:5', 'mouse:5', 'mouse:1']);
    expect(clock.pending).toBe(0);
  });

  test('上报模式在窗口内被关掉：挂起字节直接丢弃', () => {
    const { bridge, emitted, clock, setMode } = createHarness();

    bridge.handleViewportGesture(wheel(0, CELL_HEIGHT));
    clock.advance(2);
    bridge.handleViewportGesture(wheel(0, CELL_HEIGHT));
    expect(emitted.length).toBe(1);

    // 应用写入 ESC[?1000l 后控制器会 invalidateModeCache
    setMode(1000, false);
    bridge.invalidateModeCache();

    clock.advance(50);
    expect(emitted).toEqual(['mouse:5']);
    expect(clock.pending).toBe(0);
  });

  test('discardMouseReports（销毁 / 禁用输入）丢弃挂起字节且不留定时器', () => {
    const { bridge, emitted, clock } = createHarness();

    bridge.handleViewportGesture(wheel(0, CELL_HEIGHT));
    clock.advance(2);
    bridge.handleViewportGesture(wheel(0, CELL_HEIGHT));
    bridge.discardMouseReports();

    clock.advance(50);
    expect(emitted).toEqual(['mouse:5']);
    expect(clock.pending).toBe(0);
  });

  test('alt-scroll 分支仍逐条发方向键，且先冲掉挂起的滚轮批次', () => {
    const { bridge, emitted, clock } = createHarness();

    bridge.handleViewportGesture(wheel(0, CELL_HEIGHT));
    clock.advance(2);
    bridge.handleViewportGesture(wheel(0, CELL_HEIGHT));

    // 另起一个 alt-screen + alt-scroll（无鼠标上报）的桥接
    const alt = createHarness(new Set([1007, 1049]));
    expect(alt.bridge.handleViewportGesture(wheel(0, CELL_HEIGHT * 3))).toBeTrue();
    expect(alt.emitted).toEqual(['key', 'key', 'key']);

    bridge.discardMouseReports();
    expect(emitted).toEqual(['mouse:5']);
  });

  test('六行滚轮只做一轮模式查询', () => {
    const { bridge, mouseCalls, modeQueries } = createHarness();

    bridge.invalidateModeCache();
    modeQueries.length = 0;
    bridge.handleViewportGesture(wheel(0, CELL_HEIGHT * 6));

    expect(mouseCalls.length).toBe(6);
    // 同一代缓存内每个模式至多问一次 WASM
    expect(modeQueries.length).toBe(new Set(modeQueries).size);
    expect(modeQueries.length).toBeLessThanOrEqual(10);
  });
});
