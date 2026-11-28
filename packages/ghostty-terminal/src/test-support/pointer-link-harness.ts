// 鼠标链接手势测试共用的假 context 与事件：terminal-pointer-links.test.ts、
// terminal-pointer-gesture.test.ts 共享。
import { afterAll, beforeAll } from 'bun:test';
import { createPointerListeners } from '../terminal-pointer-handlers';
import {
  type MouseInputRequest,
  type PointerEventContext,
  type TerminalLinkHit,
  createMouseInputState,
} from '../terminal-pointer-shared';

class FakeMouseEvent {}
const domGlobals = globalThis as unknown as { MouseEvent?: unknown; navigator?: unknown };

// 固定为非 Mac：平台主修饰键 = Ctrl，Meta 属于「其它修饰键」。在测试文件顶层调用。
export function installPointerTestGlobals(): void {
  let savedMouseEvent: unknown;
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  beforeAll(() => {
    savedMouseEvent = domGlobals.MouseEvent;
    domGlobals.MouseEvent = FakeMouseEvent;
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform: 'Linux x86_64', userAgent: '' },
      configurable: true,
      writable: true,
    });
  });
  afterAll(() => {
    domGlobals.MouseEvent = savedMouseEvent;
    if (savedNavigator) {
      Object.defineProperty(globalThis, 'navigator', savedNavigator);
    } else {
      Reflect.deleteProperty(domGlobals, 'navigator');
    }
  });
}

export const CELL = 10;
export const EXPLICIT: TerminalLinkHit = {
  kind: 'url',
  url: 'https://example.com/full',
  explicit: true,
  tooltip: 'https://example.com/full',
};
export const DETECTED: TerminalLinkHit = {
  kind: 'url',
  url: 'https://example.com',
  explicit: false,
};

export type Harness = {
  context: PointerEventContext;
  opened: TerminalLinkHit[];
  reports: MouseInputRequest[];
  calls: string[];
  cursor: Array<[boolean, string | null]>;
  linkLookups: () => number;
};

// 第 0 行第 0–4 列是链接，其余格子没有；每格 CELL 像素见方。
export function createHarness(options: {
  hit: TerminalLinkHit;
  reporting?: boolean;
  inputDisabled?: boolean;
}): Harness {
  const opened: TerminalLinkHit[] = [];
  const reports: MouseInputRequest[] = [];
  const calls: string[] = [];
  const cursor: Array<[boolean, string | null]> = [];
  let lookups = 0;
  const cellAt = (x: number, y: number) => ({
    line: Math.floor(y / CELL),
    col: Math.floor(x / CELL),
  });
  const context: PointerEventContext = {
    mouse: createMouseInputState(),
    isInputDisabled: () => options.inputDisabled ?? false,
    focusTerminal: () => {},
    showScrollbarTransient: () => {},
    getInputRoutingState: () => ({ mouseReporting: options.reporting ?? false, altScroll: false }),
    isAnyEventTrackingEnabled: () => false,
    pointerMods: () => 0,
    emitMouseInput: (request) => {
      reports.push(request);
      return true;
    },
    clearSelection: () => calls.push('clearSelection'),
    cellAtClient: cellAt,
    linkAtClient: (x, y) => {
      lookups += 1;
      const point = cellAt(x, y);
      return point.line === 0 && point.col <= 4 ? options.hit : null;
    },
    activateLink: (hit) => opened.push(hit),
    setLinkCursor: (active, title) => cursor.push([active, title]),
    beginPointerSelection: () => calls.push('beginSelection'),
    updatePointerSelection: () => calls.push('updateSelection'),
    finishPointerSelection: () => calls.push('finishSelection'),
    handleViewportGesture: () => false,
  };
  return { context, opened, reports, calls, cursor, linkLookups: () => lookups };
}

export type EventInit = {
  x?: number;
  y?: number;
  button?: number;
  detail?: number;
  buttons?: number;
  shift?: boolean;
  /** 平台主修饰键（本文件固定非 Mac，即 Ctrl） */
  modifier?: boolean;
  meta?: boolean;
  alt?: boolean;
};

export function mouse(init: EventInit = {}): MouseEvent & { defaultPrevented: boolean } {
  const event = {
    button: init.button ?? 0,
    buttons: init.buttons ?? 1,
    detail: init.detail ?? 1,
    clientX: init.x ?? 15,
    clientY: init.y ?? 5,
    shiftKey: init.shift ?? false,
    ctrlKey: init.modifier ?? false,
    metaKey: init.meta ?? false,
    altKey: init.alt ?? false,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  Object.setPrototypeOf(event, FakeMouseEvent.prototype);
  return event as unknown as MouseEvent & { defaultPrevented: boolean };
}

export function click(harness: Harness, down: EventInit = {}, up: EventInit = down): void {
  const listeners = createPointerListeners(harness.context);
  listeners.mousedown(mouse(down));
  listeners.dragUp(mouse({ ...up, buttons: 0 }));
}
