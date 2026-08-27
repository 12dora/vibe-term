// bindMouseEvents 只负责注册 / 注销：监听器顺序、window 级拖拽监听、以及注销时
// 必须传回同一个函数引用，都是行为契约（拆分出 terminal-pointer-handlers 后需锁死）。
import { afterEach, describe, expect, test } from 'bun:test';
import {
  type PointerEventContext,
  bindMouseEvents,
  createMouseInputState,
} from './terminal-pointer';

type Registration = { target: string; type: string; listener: unknown; options: unknown };

function createRecorder() {
  const added: Registration[] = [];
  const removed: Registration[] = [];

  const makeTarget = (target: string) =>
    ({
      addEventListener: (type: string, listener: unknown, options?: unknown) => {
        added.push({ target, type, listener, options });
      },
      removeEventListener: (type: string, listener: unknown, options?: unknown) => {
        removed.push({ target, type, listener, options });
      },
    }) as unknown as HTMLElement;

  return { added, removed, makeTarget };
}

function createContext(): PointerEventContext {
  return {
    mouse: createMouseInputState(),
    isInputDisabled: () => false,
    focusTerminal: () => {},
    showScrollbarTransient: () => {},
    getInputRoutingState: () => ({ mouseReporting: false, altScroll: false }),
    isAnyEventTrackingEnabled: () => false,
    pointerMods: () => 0,
    emitMouseInput: () => false,
    clearSelection: () => {},
    linkAtClient: () => null,
    activateLink: () => {},
    setLinkCursor: () => {},
    beginPointerSelection: () => {},
    updatePointerSelection: () => {},
    finishPointerSelection: () => {},
    handleViewportGesture: () => false,
  };
}

const globalScope = globalThis as { window?: unknown };
const previousWindow = globalScope.window;

afterEach(() => {
  globalScope.window = previousWindow;
});

describe('bindMouseEvents 注册契约', () => {
  test('注册顺序与目标固定，wheel 为非 passive', () => {
    const { added, makeTarget } = createRecorder();
    const root = makeTarget('root');
    const surface = makeTarget('surface');
    globalScope.window = makeTarget('window');

    bindMouseEvents(root, surface, createContext());

    expect(added.map((item) => `${item.target}:${item.type}`)).toEqual([
      'root:click',
      'surface:mousedown',
      'surface:mousemove',
      'surface:mouseleave',
      'root:wheel',
      'window:mousemove',
      'window:mouseup',
    ]);
    expect(added[4]?.options).toEqual({ passive: false });
  });

  test('注销覆盖全部注册，且传回同一函数引用', () => {
    const { added, removed, makeTarget } = createRecorder();
    const root = makeTarget('root');
    const surface = makeTarget('surface');
    globalScope.window = makeTarget('window');

    const dispose = bindMouseEvents(root, surface, createContext());
    dispose();

    expect(removed.map((item) => `${item.target}:${item.type}`)).toEqual(
      added.map((item) => `${item.target}:${item.type}`)
    );
    for (const registration of added) {
      const match = removed.find(
        (item) => item.target === registration.target && item.type === registration.type
      );
      expect(match?.listener).toBe(registration.listener);
    }
  });

  test('没有 window 时只注册元素级监听', () => {
    const { added, removed, makeTarget } = createRecorder();
    const root = makeTarget('root');
    const surface = makeTarget('surface');
    globalScope.window = undefined;

    const dispose = bindMouseEvents(root, surface, createContext());
    dispose();

    expect(added.some((item) => item.target === 'window')).toBeFalse();
    expect(added.length).toBe(5);
    expect(removed.length).toBe(5);
  });
});
