// 滚轮余量的复位契约：resetPointerAccumulation（清除选择时调用）必须把纵向与横向
// 两条像素累加器一起清零，否则残留的半格余量会让下一次滚动提前跨格。
import { describe, expect, test } from 'bun:test';
import type { GhosttyBindings } from './ghostty-wasm';
import {
  type InputBridgeHost,
  type TerminalHandles,
  TerminalInputBridge,
} from './terminal-input-bridge';
import type { GhosttyViewportGesture } from './types';

type MouseEncodeOptions = Parameters<GhosttyBindings['encodeMouseEvent']>[2];

const CELL_WIDTH = 9;
const CELL_HEIGHT = 16;
const MOUSE_REPORTING_MODES = new Set([1000, 1006]);

type Harness = {
  bridge: TerminalInputBridge;
  mouseCalls: MouseEncodeOptions[];
  scrolled: number[];
};

function createHarness(
  modes: ReadonlySet<number> = MOUSE_REPORTING_MODES,
  scrollResult?: boolean
): Harness {
  const mouseCalls: MouseEncodeOptions[] = [];
  const scrolled: number[] = [];

  const bindings = {
    isTerminalModeEnabled: (_terminal: number, mode: number) => modes.has(mode),
    setTerminalMode: () => {},
    resetMouseEncoder: () => {},
    encodeMouseEvent: (_encoder: number, _terminal: number, options: MouseEncodeOptions) => {
      mouseCalls.push(options);
      return `mouse:${options.button ?? 'none'}`;
    },
    encodeKeyEvent: () => 'key',
    encodePaste: () => 'paste',
  } as unknown as GhosttyBindings;

  const handles: TerminalHandles = { terminal: 1, keyEncoder: 2, mouseEncoder: 3 };
  const host: InputBridgeHost = {
    cellDimensions: () => ({ width: CELL_WIDTH, height: CELL_HEIGHT }),
    screenBounds: () => ({ left: 0, top: 0, width: 960, height: 480 }),
    isInputDisabled: () => false,
    emitData: () => {},
    viewportCols: () => 80,
    viewportRows: () => 24,
    scrollLines: (amount: number) => {
      scrolled.push(amount);
      return scrollResult;
    },
  };

  return { bridge: new TerminalInputBridge(bindings, handles, host), mouseCalls, scrolled };
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
