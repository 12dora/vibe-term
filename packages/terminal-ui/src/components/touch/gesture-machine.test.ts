import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from 'bun:test';
import { MobileTouchGestureMachine } from './gesture-machine';
import { LONG_PRESS_SELECT_MS } from './touch-geometry';
import type { TerminalScroller } from './types';

// bun 没有 DOM 全局：scroll-bypass 里的 `instanceof Element/HTMLElement` 需要可解析的构造器。
class FakeElement {
  constructor(private readonly selectors: string[] = []) {}

  closest(selector: string): FakeElement | null {
    return this.selectors.includes(selector) ? this : null;
  }

  querySelector(_selector: string): FakeElement | null {
    return null;
  }
}

const domGlobals = globalThis as unknown as { Element?: unknown; HTMLElement?: unknown };
let savedElement: unknown;
let savedHtmlElement: unknown;

beforeAll(() => {
  savedElement = domGlobals.Element;
  savedHtmlElement = domGlobals.HTMLElement;
  domGlobals.Element = FakeElement;
  domGlobals.HTMLElement = FakeElement;
});

afterAll(() => {
  domGlobals.Element = savedElement;
  domGlobals.HTMLElement = savedHtmlElement;
});

afterEach(() => {
  jest.useRealTimers();
});

const CELL_HEIGHT = 20;

interface FakeTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

function touch(identifier: number, clientX: number, clientY: number): FakeTouch {
  return { identifier, clientX, clientY };
}

function touchEvent(touches: FakeTouch[], changedTouches: FakeTouch[] = touches) {
  const event = {
    touches: { length: touches.length, item: (i: number) => touches[i] ?? null },
    changedTouches: {
      length: changedTouches.length,
      item: (i: number) => changedTouches[i] ?? null,
    },
    target: null,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

function asTouchEvent(event: ReturnType<typeof touchEvent>): TouchEvent {
  return event as unknown as TouchEvent;
}

interface Harness {
  machine: MobileTouchGestureMachine;
  calls: string[];
  setReporting: (reporting: boolean) => void;
}

function createHarness(options: { reporting: boolean; pressSucceeds?: boolean }): Harness {
  const calls: string[] = [];
  let reporting = options.reporting;
  const pressSucceeds = options.pressSucceeds ?? true;

  const terminal: TerminalScroller = {
    scrollLines: (amount) => calls.push(`scrollLines(${amount})`),
    handleViewportGesture: (gesture) => {
      calls.push(`viewportGesture(${gesture.deltaY},${gesture.clientX},${gesture.clientY})`);
      return true;
    },
    isMouseReporting: () => reporting,
    sendTouchMouseEvent: ({ action, clientX, clientY }) => {
      if (action === 'press' && !pressSucceeds) {
        calls.push(`press-rejected(${clientX},${clientY})`);
        return false;
      }
      calls.push(`${action}(${clientX},${clientY})`);
      return true;
    },
    startTouchSelection: (clientX, clientY, mode) => {
      calls.push(`startSelection(${clientX},${clientY},${mode})`);
      return true;
    },
    updateTouchSelection: (clientX, clientY) =>
      calls.push(`updateSelection(${clientX},${clientY})`),
    endTouchSelection: () => calls.push('endSelection'),
    noteTouchHandled: () => calls.push('noteTouchHandled'),
    focus: () => calls.push('focus'),
  };
  (terminal as any)._core = {
    _renderService: { dimensions: { css: { cell: { height: CELL_HEIGHT } } } },
  };

  const machine = new MobileTouchGestureMachine({
    container: new FakeElement() as unknown as Element,
    resolveTerminal: () => terminal,
    elementFromPoint: () => null,
  });

  return {
    machine,
    calls,
    setReporting: (next) => {
      reporting = next;
    },
  };
}

describe('mouse reporting gestures', () => {
  test('tap emits press+release at the start point with no motion', () => {
    const { machine, calls } = createHarness({ reporting: true });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    const end = touchEvent([], [touch(1, 103, 101)]);
    machine.handleTouchEnd(asTouchEvent(end));

    expect(calls).toEqual(['press(100,100)', 'release(100,100)', 'noteTouchHandled', 'focus']);
    expect(end.defaultPrevented).toBe(true);
    expect(machine.currentState()).toBe('idle');
  });

  test('a within-tolerance move stays a tap', () => {
    const { machine, calls } = createHarness({ reporting: true });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    machine.handleTouchMove(asTouchEvent(touchEvent([touch(1, 108, 106)])));

    expect(calls).toEqual([]);
    expect(machine.currentState()).toBe('pending');
  });

  test('drag emits exactly one press, streaming motion and one release', () => {
    const { machine, calls } = createHarness({ reporting: true });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    machine.handleTouchMove(asTouchEvent(touchEvent([touch(1, 108, 100)])));
    machine.handleTouchMove(asTouchEvent(touchEvent([touch(1, 140, 100)])));
    machine.handleTouchMove(asTouchEvent(touchEvent([touch(1, 160, 120)])));
    machine.handleTouchEnd(asTouchEvent(touchEvent([], [touch(1, 170, 130)])));

    expect(calls).toEqual([
      'press(100,100)',
      'motion(140,100)',
      'motion(160,120)',
      'release(170,130)',
      'noteTouchHandled',
    ]);
    expect(machine.currentState()).toBe('idle');
  });

  test('a rejected press aborts the gesture without further reports', () => {
    const { machine, calls } = createHarness({ reporting: true, pressSucceeds: false });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    machine.handleTouchMove(asTouchEvent(touchEvent([touch(1, 140, 100)])));
    machine.handleTouchMove(asTouchEvent(touchEvent([touch(1, 160, 100)])));

    expect(calls).toEqual(['press-rejected(100,100)']);
    expect(machine.currentState()).toBe('idle');
  });

  test('a non-primary finger lifting does not end the drag', () => {
    const { machine, calls } = createHarness({ reporting: true });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    machine.handleTouchMove(asTouchEvent(touchEvent([touch(1, 140, 100)])));
    calls.length = 0;
    machine.handleTouchEnd(asTouchEvent(touchEvent([touch(1, 140, 100)], [touch(2, 300, 300)])));

    expect(calls).toEqual([]);
    expect(machine.currentState()).toBe('drag');
  });

  test('touchcancel during a drag releases at the last motion point', () => {
    const { machine, calls } = createHarness({ reporting: true });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    machine.handleTouchMove(asTouchEvent(touchEvent([touch(1, 140, 100)])));
    machine.handleTouchMove(asTouchEvent(touchEvent([touch(1, 155, 111)])));
    calls.length = 0;
    machine.handleTouchCancel(asTouchEvent(touchEvent([], [touch(1, 155, 111)])));

    expect(calls).toEqual(['release(155,111)', 'noteTouchHandled']);
    expect(machine.currentState()).toBe('idle');
  });
});

describe('two-finger wheel', () => {
  test('a second finger before any press turns the gesture into wheel reports', () => {
    const { machine, calls } = createHarness({ reporting: true });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100), touch(2, 160, 100)])));
    expect(machine.currentState()).toBe('wheel');

    machine.handleTouchMove(asTouchEvent(touchEvent([touch(1, 100, 60), touch(2, 160, 60)])));

    // 质心位移 40px * 1.3 = 52px → 2 整行 = 40px，余 12px 留在累积器
    expect(calls).toEqual(['viewportGesture(40,100,60)']);
    expect(calls.some((call) => call.startsWith('press'))).toBe(false);
    expect(calls.some((call) => call.startsWith('motion'))).toBe(false);
  });

  test('fingers lifting one at a time re-anchor the centroid without emitting', () => {
    const { machine, calls } = createHarness({ reporting: true });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100), touch(2, 160, 100)])));
    machine.handleTouchEnd(asTouchEvent(touchEvent([touch(1, 100, 100)], [touch(2, 160, 100)])));
    expect(machine.currentState()).toBe('wheel');
    expect(calls).toEqual([]);

    machine.handleTouchEnd(asTouchEvent(touchEvent([], [touch(1, 100, 100)])));
    expect(machine.currentState()).toBe('idle');
  });
});

describe('non-reporting scroll', () => {
  test('single-finger movement feeds whole lines to the viewport gesture', () => {
    const { machine, calls } = createHarness({ reporting: false });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 200)])));
    expect(machine.currentState()).toBe('scroll');

    const move = touchEvent([touch(1, 100, 160)]);
    machine.handleTouchMove(asTouchEvent(move));

    expect(calls).toEqual(['viewportGesture(40,100,160)']);
    expect(move.defaultPrevented).toBe(true);
  });

  test('sub-line movement neither scrolls nor swallows the event', () => {
    const { machine, calls } = createHarness({ reporting: false });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 200)])));

    const move = touchEvent([touch(1, 100, 195)]);
    machine.handleTouchMove(asTouchEvent(move));

    expect(calls).toEqual([]);
    expect(move.defaultPrevented).toBe(false);
  });
});

describe('long-press selection', () => {
  test('holding still starts a word selection and drives it with further moves', () => {
    jest.useFakeTimers();
    const { machine, calls } = createHarness({ reporting: true });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    jest.advanceTimersByTime(LONG_PRESS_SELECT_MS);
    expect(machine.currentState()).toBe('select');

    const move = touchEvent([touch(1, 130, 100)]);
    machine.handleTouchMove(asTouchEvent(move));
    const end = touchEvent([], [touch(1, 130, 100)]);
    machine.handleTouchEnd(asTouchEvent(end));

    expect(calls).toEqual([
      'startSelection(100,100,word)',
      'updateSelection(130,100)',
      'endSelection',
      'noteTouchHandled',
    ]);
    expect(move.defaultPrevented).toBe(true);
    expect(end.defaultPrevented).toBe(true);
    expect(machine.currentState()).toBe('idle');
  });

  test('crossing the drag threshold disarms the long press', () => {
    jest.useFakeTimers();
    const { machine, calls } = createHarness({ reporting: true });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    machine.handleTouchMove(asTouchEvent(touchEvent([touch(1, 140, 100)])));
    jest.advanceTimersByTime(LONG_PRESS_SELECT_MS * 2);

    expect(calls).toEqual(['press(100,100)', 'motion(140,100)']);
    expect(machine.currentState()).toBe('drag');
  });

  test('a second finger disarms the long press', () => {
    jest.useFakeTimers();
    const { machine, calls } = createHarness({ reporting: true });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100), touch(2, 160, 100)])));
    jest.advanceTimersByTime(LONG_PRESS_SELECT_MS * 2);

    expect(calls).toEqual([]);
    expect(machine.currentState()).toBe('wheel');
  });

  test('contextmenu is suppressed only while a selection is live', () => {
    jest.useFakeTimers();
    const { machine } = createHarness({ reporting: true });
    const before = touchEvent([]);
    machine.handleContextMenu(asTouchEvent(before));
    expect(before.defaultPrevented).toBe(false);

    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    jest.advanceTimersByTime(LONG_PRESS_SELECT_MS);
    const during = touchEvent([]);
    machine.handleContextMenu(asTouchEvent(during));
    expect(during.defaultPrevented).toBe(true);
  });

  test('dispose disarms a pending long press', () => {
    jest.useFakeTimers();
    const { machine, calls } = createHarness({ reporting: true });
    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 100)])));
    machine.dispose();
    jest.advanceTimersByTime(LONG_PRESS_SELECT_MS * 2);

    expect(calls).toEqual([]);
    expect(machine.currentState()).toBe('pending');
  });

  test('handing the gesture back to the native scrollbar disarms the long press', () => {
    jest.useFakeTimers();
    const calls: string[] = [];
    const terminal: TerminalScroller = {
      scrollLines: () => {},
      isMouseReporting: () => false,
      startTouchSelection: (clientX, clientY, mode) => {
        calls.push(`startSelection(${clientX},${clientY},${mode})`);
        return true;
      },
    };
    let inScrollbar = false;
    const scrollbar = new FakeElement(['.scrollbar']);
    const machine = new MobileTouchGestureMachine({
      container: new FakeElement() as unknown as Element,
      resolveTerminal: () => terminal,
      elementFromPoint: () => (inScrollbar ? (scrollbar as unknown as Element) : null),
    });

    machine.handleTouchStart(asTouchEvent(touchEvent([touch(1, 100, 200)])));
    expect(machine.currentState()).toBe('scroll');

    inScrollbar = true;
    machine.handleTouchMove(asTouchEvent(touchEvent([touch(1, 104, 202)])));
    expect(machine.currentState()).toBe('bypass');

    jest.advanceTimersByTime(LONG_PRESS_SELECT_MS * 2);
    expect(calls).toEqual([]);
    expect(machine.currentState()).toBe('bypass');
  });
});
