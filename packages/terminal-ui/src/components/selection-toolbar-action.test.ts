import { describe, expect, test } from 'bun:test';
import { createToolbarActionBinder } from './selection-toolbar-action';

function pointerEvent(pointerType: string) {
  const event = {
    pointerType,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

function mouseEvent() {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

describe('createToolbarActionBinder', () => {
  test('鼠标：mousedown 防焦点，click 触发一次', () => {
    const calls: string[] = [];
    const binder = createToolbarActionBinder(() => calls.push('action'));
    const down = mouseEvent();
    binder.onMouseDown(down);
    expect(down.defaultPrevented).toBe(true);
    binder.onClick();
    expect(calls).toEqual(['action']);
  });

  test('触摸：pointerup 触发并 preventDefault，后续 click 不重复', () => {
    const calls: string[] = [];
    const binder = createToolbarActionBinder(() => calls.push('action'));
    const up = pointerEvent('touch');
    binder.onPointerUp(up);
    expect(up.defaultPrevented).toBe(true);
    expect(calls).toEqual(['action']);

    const down = mouseEvent();
    binder.onMouseDown(down);
    expect(down.defaultPrevented).toBe(false);
    binder.onClick();
    expect(calls).toEqual(['action']);
  });

  test('非触摸 pointerup 不触发，留给 click', () => {
    const calls: string[] = [];
    const binder = createToolbarActionBinder(() => calls.push('action'));
    const up = pointerEvent('mouse');
    binder.onPointerUp(up);
    expect(up.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    binder.onClick();
    expect(calls).toEqual(['action']);
  });
});
