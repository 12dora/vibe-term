// 指针 → 焦点的判定：真鼠标点击聚焦终端（桌面靠这条输入），触摸手势之后浏览器
// 合成的那套鼠标事件一律作废——它会在触屏上弹出/收起软键盘。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPointerListeners } from './terminal-pointer-handlers';
import { SYNTHETIC_MOUSE_SUPPRESS_MS, createMouseInputState } from './terminal-pointer-shared';
import type { PointerEventContext } from './terminal-pointer-shared';

function createContext(overrides: Partial<PointerEventContext> = {}): {
  context: PointerEventContext;
  calls: string[];
} {
  const calls: string[] = [];
  const context: PointerEventContext = {
    mouse: createMouseInputState(),
    isInputDisabled: () => false,
    focusTerminal: () => calls.push('focus'),
    showScrollbarTransient: () => {},
    getInputRoutingState: () => ({ mouseReporting: false, altScroll: false }),
    isAnyEventTrackingEnabled: () => false,
    pointerMods: () => 0,
    emitMouseInput: () => false,
    clearSelection: () => {},
    linkAtClient: () => null,
    activateLink: () => {},
    setLinkCursor: () => {},
    beginPointerSelection: () => calls.push('beginSelection'),
    updatePointerSelection: () => {},
    finishPointerSelection: () => {},
    handleViewportGesture: () => false,
    ...overrides,
  };
  return { context, calls };
}

// bun 没有 DOM 全局：mousedown 监听器用 `instanceof MouseEvent` 做入口守卫，
// 测试装一个可解析的构造器即可驱动。
class FakeMouseEvent {}

const domGlobals = globalThis as unknown as { MouseEvent?: unknown };
let savedMouseEvent: unknown;

beforeAll(() => {
  savedMouseEvent = domGlobals.MouseEvent;
  domGlobals.MouseEvent = FakeMouseEvent;
});

afterAll(() => {
  domGlobals.MouseEvent = savedMouseEvent;
});

function mousedownEvent(): MouseEvent & { defaultPrevented: boolean } {
  const event = {
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 10,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  Object.setPrototypeOf(event, FakeMouseEvent.prototype);
  return event as unknown as MouseEvent & { defaultPrevented: boolean };
}

describe('指针焦点判定', () => {
  test('真鼠标：click 聚焦终端，mousedown 起本地选区', () => {
    const { context, calls } = createContext();
    const listeners = createPointerListeners(context);

    listeners.mousedown(mousedownEvent());
    listeners.click();

    expect(calls).toEqual(['focus', 'beginSelection', 'focus']);
  });

  test('输入被禁用（editor 模式）时不聚焦', () => {
    const { context, calls } = createContext({ isInputDisabled: () => true });
    const listeners = createPointerListeners(context);

    listeners.click();

    expect(calls).toEqual([]);
  });

  test('触摸消费过的合成序列：click 不聚焦，mousedown 吃掉默认动作（不夺焦点）', () => {
    const { context, calls } = createContext();
    context.mouse.suppressSyntheticUntil = Date.now() + SYNTHETIC_MOUSE_SUPPRESS_MS;
    const listeners = createPointerListeners(context);

    const event = mousedownEvent();
    listeners.mousedown(event);
    listeners.click();

    expect(calls).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  test('抑制窗口过期后恢复真鼠标语义', () => {
    const { context, calls } = createContext();
    context.mouse.suppressSyntheticUntil = Date.now() - 1;
    const listeners = createPointerListeners(context);

    listeners.click();

    expect(calls).toEqual(['focus']);
  });
});
