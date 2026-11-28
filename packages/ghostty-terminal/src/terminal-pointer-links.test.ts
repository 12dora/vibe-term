// 鼠标链接手势（POLICY「Activation」「Hover」）：经 createPointerListeners 驱动真实监听器，
// 断言何时打开、哪些按下/松开被上报给应用、选区是否开始，以及悬停光标/提示的重算时机。
import { describe, expect, test } from 'bun:test';
import { isPointerDragActive } from './terminal-pointer-gesture';
import { createPointerListeners } from './terminal-pointer-handlers';
import {
  DETECTED,
  EXPLICIT,
  click,
  createHarness,
  installPointerTestGlobals,
  mouse,
} from './test-support/pointer-link-harness';

installPointerTestGlobals();

describe('上报关闭', () => {
  test('无修饰单击 explicit / detected 链接：松开时打开，不留选区', () => {
    for (const hit of [EXPLICIT, DETECTED]) {
      const harness = createHarness({ hit });
      click(harness);
      expect(harness.opened).toEqual([hit]);
      expect(harness.calls).toEqual(['beginSelection', 'clearSelection']);
      expect(harness.reports).toHaveLength(0);
    }
  });

  test('按下即打开要求修饰键：修饰键单击在按下时打开且不开始选区', () => {
    const harness = createHarness({ hit: DETECTED });
    const listeners = createPointerListeners(harness.context);
    const down = mouse({ modifier: true });
    listeners.mousedown(down);
    expect(harness.opened).toEqual([DETECTED]);
    expect(down.defaultPrevented).toBe(true);
    expect(harness.calls).toEqual([]);
  });

  test('拖出按下的格子后松开：不打开，正常收尾选区', () => {
    const harness = createHarness({ hit: EXPLICIT });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse({ x: 15 }));
    listeners.dragMove(mouse({ x: 35 }));
    listeners.dragMove(mouse({ x: 15 }));
    listeners.dragUp(mouse({ x: 15, buttons: 0 }));
    expect(harness.opened).toEqual([]);
    expect(harness.calls).toEqual([
      'beginSelection',
      'updateSelection',
      'updateSelection',
      'finishSelection',
    ]);
  });

  test('松开落在别的格子：不打开', () => {
    const harness = createHarness({ hit: EXPLICIT });
    click(harness, { x: 15 }, { x: 25 });
    expect(harness.opened).toEqual([]);
  });

  test('双击：第一次松开打开一次，第二次（detail=2）不再打开、走选词', () => {
    const harness = createHarness({ hit: EXPLICIT });
    click(harness, { detail: 1 });
    click(harness, { detail: 2 });
    expect(harness.opened).toHaveLength(1);
    expect(harness.calls.at(-1)).toBe('finishSelection');
  });

  test('Shift+单击与 Shift+修饰键单击都不打开', () => {
    const harness = createHarness({ hit: EXPLICIT });
    click(harness, { shift: true });
    click(harness, { shift: true, modifier: true });
    expect(harness.opened).toEqual([]);
  });

  test('点在链接外：照常选区', () => {
    const harness = createHarness({ hit: EXPLICIT });
    click(harness, { y: 15 });
    expect(harness.opened).toEqual([]);
    expect(harness.calls).toEqual(['beginSelection', 'finishSelection']);
  });
});

describe('上报开启（应用 DECSET 1000/1002/1003）', () => {
  test('explicit 链接：按下与松开都不上报，松开时打开', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse());
    listeners.dragMove(mouse({ buttons: 1 }));
    listeners.dragUp(mouse({ buttons: 0 }));
    expect(harness.opened).toEqual([EXPLICIT]);
    expect(harness.reports).toEqual([]);
    expect(harness.calls).toEqual([]);
  });

  test('explicit 链接上拖走：仍不上报任何事件，也不打开', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse({ x: 15 }));
    listeners.dragMove(mouse({ x: 75, buttons: 1 }));
    listeners.dragUp(mouse({ x: 75, buttons: 0 }));
    expect(harness.opened).toEqual([]);
    expect(harness.reports).toEqual([]);
  });

  test('explicit 链接上双击：第二次按下也不上报，且不再打开', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    click(harness, { detail: 1 });
    click(harness, { detail: 2 });
    expect(harness.opened).toHaveLength(1);
    expect(harness.reports).toEqual([]);
  });

  test('detected 链接：照旧把按下/松开上报给应用，不打开', () => {
    const harness = createHarness({ hit: DETECTED, reporting: true });
    click(harness);
    expect(harness.opened).toEqual([]);
    expect(harness.reports.map((report) => report.action)).toEqual(['press', 'release']);
  });

  test('修饰键单击任何链接：无视上报立即打开，按下不上报', () => {
    const harness = createHarness({ hit: DETECTED, reporting: true });
    createPointerListeners(harness.context).mousedown(mouse({ modifier: true }));
    expect(harness.opened).toEqual([DETECTED]);
    expect(harness.reports).toEqual([]);
  });

  test('Shift+单击 explicit 链接：绕过上报走本地选区，不打开', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    click(harness, { shift: true });
    expect(harness.opened).toEqual([]);
    expect(harness.reports).toEqual([]);
    expect(harness.calls).toEqual(['beginSelection', 'finishSelection']);
  });

  test('链接外的单击照常上报', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    click(harness, { y: 25 });
    expect(harness.reports.map((report) => report.action)).toEqual(['press', 'release']);
  });
});

describe('悬停光标与提示', () => {
  test('只在格子或修饰键状态变化时重算', () => {
    const harness = createHarness({ hit: EXPLICIT });
    const listeners = createPointerListeners(harness.context);
    listeners.mousemove(mouse({ x: 11, buttons: 0 }));
    listeners.mousemove(mouse({ x: 13, buttons: 0 }));
    listeners.mousemove(mouse({ x: 19, buttons: 0 }));
    expect(harness.linkLookups()).toBe(1);
    expect(harness.cursor).toEqual([[true, 'https://example.com/full']]);

    listeners.mousemove(mouse({ x: 25, buttons: 0 }));
    listeners.mousemove(mouse({ x: 25, buttons: 0, modifier: true }));
    listeners.mousemove(mouse({ x: 25, buttons: 0, modifier: true }));
    expect(harness.linkLookups()).toBe(3);
  });

  test('上报开启：explicit 显示 pointer；detected 只有按住修饰键才 pointer，无 tooltip', () => {
    const explicit = createHarness({ hit: EXPLICIT, reporting: true });
    createPointerListeners(explicit.context).mousemove(mouse({ buttons: 0 }));
    expect(explicit.cursor).toEqual([[true, 'https://example.com/full']]);

    const detected = createHarness({ hit: DETECTED, reporting: true });
    const listeners = createPointerListeners(detected.context);
    listeners.mousemove(mouse({ buttons: 0 }));
    listeners.mousemove(mouse({ buttons: 0, modifier: true }));
    expect(detected.cursor).toEqual([
      [false, null],
      [true, null],
    ]);
  });

  test('按住 Shift 不显示 pointer；离开清空光标与提示', () => {
    const harness = createHarness({ hit: EXPLICIT });
    const listeners = createPointerListeners(harness.context);
    listeners.mousemove(mouse({ buttons: 0, shift: true }));
    listeners.mouseleave();
    expect(harness.cursor).toEqual([
      [false, 'https://example.com/full'],
      [false, null],
    ]);
    expect(harness.context.mouse.linkHover).toBeNull();
  });
});

describe('非平台修饰键不是无修饰单击', () => {
  test('上报关闭：Alt / Meta 单击链接不打开，照常选区', () => {
    for (const init of [{ alt: true }, { meta: true }, { alt: true, modifier: true }]) {
      const harness = createHarness({ hit: EXPLICIT });
      click(harness, init);
      expect(harness.opened).toEqual([]);
      expect(harness.calls).toEqual(['beginSelection', 'finishSelection']);
    }
  });

  test('上报开启：Alt / Meta 单击 explicit 链接照常上报给应用，不打开', () => {
    for (const init of [{ alt: true }, { meta: true }, { alt: true, modifier: true }]) {
      const harness = createHarness({ hit: EXPLICIT, reporting: true });
      click(harness, init);
      expect(harness.opened).toEqual([]);
      expect(harness.reports.map((report) => report.action)).toEqual(['press', 'release']);
    }
  });

  test('按下无修饰、松开时按住 Alt：不打开', () => {
    const harness = createHarness({ hit: EXPLICIT });
    click(harness, {}, { alt: true });
    expect(harness.opened).toEqual([]);
  });

  test('悬停按住 Alt / Meta：不显示 pointer', () => {
    const harness = createHarness({ hit: EXPLICIT });
    const listeners = createPointerListeners(harness.context);
    listeners.mousemove(mouse({ buttons: 0, alt: true }));
    listeners.mousemove(mouse({ buttons: 0, meta: true }));
    listeners.mousemove(mouse({ buttons: 0 }));
    // Alt 与 Meta 同属「其它修饰键」，两次悬停判定键相同，只重算一次。
    expect(harness.cursor.map(([active]) => active)).toEqual([false, true]);
  });
});

describe('多键交错（上报开启）', () => {
  test('左键被吞期间按下/松开右键：左键手势不中断，右键照常上报，左键松开仍打开且不上报', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse());
    listeners.mousedown(mouse({ button: 2, buttons: 3 }));
    listeners.dragUp(mouse({ button: 2, buttons: 1 }));
    expect(harness.context.mouse.primary).toBe('swallowed');
    expect(isPointerDragActive(harness.context.mouse)).toBe(true);

    listeners.dragUp(mouse({ buttons: 0 }));
    expect(harness.opened).toEqual([EXPLICIT]);
    expect(harness.reports.map((report) => [report.action, report.button])).toEqual([
      ['press', 2],
      ['release', 2],
    ]);
    expect(isPointerDragActive(harness.context.mouse)).toBe(false);
    expect(harness.context.mouse.pressedButtons.size).toBe(0);
  });

  test('左键被吞期间右键仍按着时松开左键：右键之后的松开仍会上报', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse());
    listeners.mousedown(mouse({ button: 2, buttons: 3 }));
    listeners.dragUp(mouse({ buttons: 2 }));
    expect(isPointerDragActive(harness.context.mouse)).toBe(true);

    listeners.dragUp(mouse({ button: 2, buttons: 0 }));
    expect(harness.reports.map((report) => report.action)).toEqual(['press', 'release']);
    expect(isPointerDragActive(harness.context.mouse)).toBe(false);
  });

  test('侧键按下不清除被吞的左键手势', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse());
    listeners.mousedown(mouse({ button: 3, buttons: 9 }));
    listeners.dragUp(mouse({ buttons: 0 }));
    expect(harness.opened).toEqual([EXPLICIT]);
    expect(harness.reports).toEqual([]);
  });
});

describe('丢失 mouseup 后的恢复', () => {
  test('被吞手势：buttons=0 的移动结束手势、不打开，之后悬停与点击恢复正常', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse());
    listeners.dragMove(mouse({ buttons: 0 }));
    expect(isPointerDragActive(harness.context.mouse)).toBe(false);
    expect(harness.context.mouse.primary).toBe('none');
    expect(harness.context.mouse.pendingLink).toBeNull();

    click(harness);
    expect(harness.opened).toEqual([EXPLICIT]);
    expect(harness.reports).toEqual([]);
  });

  test('被吞手势未收尾就再次按下：新按下接管，松开正常打开一次', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse());
    click(harness);
    expect(harness.opened).toEqual([EXPLICIT]);
    expect(isPointerDragActive(harness.context.mouse)).toBe(false);
  });

  test('本地模式：buttons=0 的移动收尾选区并取消待定链接', () => {
    const harness = createHarness({ hit: EXPLICIT });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse());
    listeners.dragMove(mouse({ buttons: 0 }));
    expect(harness.context.mouse.pendingLink).toBeNull();
    expect(harness.calls).toEqual(['beginSelection', 'finishSelection']);
  });
});

describe('只读视图（输入关闭）与 openLinkAt 同一上报口径', () => {
  test('应用开了上报但输入关闭：detected 链接悬停显示 pointer，单击打开且不上报', () => {
    const harness = createHarness({ hit: DETECTED, reporting: true, inputDisabled: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousemove(mouse({ buttons: 0 }));
    expect(harness.cursor).toEqual([[true, null]]);

    click(harness);
    expect(harness.opened).toEqual([DETECTED]);
    expect(harness.reports).toEqual([]);
    expect(isPointerDragActive(harness.context.mouse)).toBe(false);
  });
});
