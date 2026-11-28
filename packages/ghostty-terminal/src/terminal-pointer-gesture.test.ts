// 主键手势与已上报按键的不变式（CR3 #2）：修饰键打开链接不留拖拽状态；丢失的 mouseup
// 在下一次任意事件时收尾；只对上报过 press 的按键上报 release / motion；其它键的上报成对不丢。
import { describe, expect, test } from 'bun:test';
import { isPointerDragActive } from './terminal-pointer-gesture';
import { createPointerListeners } from './terminal-pointer-handlers';
import type { MouseInputRequest } from './terminal-pointer-shared';
import { TerminalSelection } from './terminal-selection';
import {
  CELL,
  DETECTED,
  EXPLICIT,
  type Harness,
  createHarness,
  installPointerTestGlobals,
  mouse,
} from './test-support/pointer-link-harness';
import { lineModelFromText } from './test-support/selection-line-model';

installPointerTestGlobals();

const LINK_X = 15;
const PLAIN_X = 75;

function actions(harness: Harness): Array<[string, number | null | undefined]> {
  return harness.reports.map((report) => [report.action, report.button]);
}

describe('修饰键点击链接接管丢了 mouseup 的手势', () => {
  test('上报模式：被吞手势丢 mouseup 后修饰键单击，之后的移动/松开不上报、不留拖拽', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse());
    listeners.mousedown(mouse({ modifier: true }));
    expect(harness.opened).toEqual([EXPLICIT]);

    listeners.dragMove(mouse({ x: 35, buttons: 1 }));
    listeners.dragUp(mouse({ x: 35, buttons: 0 }));
    listeners.dragMove(mouse({ x: 45, buttons: 0 }));
    expect(harness.reports).toEqual([]);
    expect(harness.calls).toEqual([]);
    expect(isPointerDragActive(harness.context.mouse)).toBe(false);
  });

  test('本地模式：选区丢 mouseup 后修饰键单击，只收尾旧选区，不再更新或开始选区', () => {
    const harness = createHarness({ hit: DETECTED });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse({ x: PLAIN_X }));
    listeners.mousedown(mouse({ modifier: true }));
    listeners.dragMove(mouse({ x: 35, buttons: 1 }));
    listeners.dragUp(mouse({ x: 35, buttons: 0 }));
    expect(harness.opened).toEqual([DETECTED]);
    expect(harness.calls).toEqual(['beginSelection', 'finishSelection']);
    expect(isPointerDragActive(harness.context.mouse)).toBe(false);
  });

  test('右键按住期间修饰键单击链接：左键松开不发孤立 release，右键 press/release 成对', () => {
    const harness = createHarness({ hit: DETECTED, reporting: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse({ button: 2, buttons: 2 }));
    listeners.mousedown(mouse({ modifier: true, buttons: 3 }));
    listeners.dragMove(mouse({ x: 25, buttons: 3 }));
    listeners.dragUp(mouse({ buttons: 2 }));
    listeners.dragUp(mouse({ button: 2, buttons: 0 }));
    expect(harness.opened).toEqual([DETECTED]);
    expect(actions(harness)).toEqual([
      ['press', 2],
      ['motion', 2],
      ['release', 2],
    ]);
    expect(isPointerDragActive(harness.context.mouse)).toBe(false);
  });
});

describe('丢失的 mouseup 在下一次按下时收尾', () => {
  test('上报的左键丢 mouseup：再次按下先补发 release 再上报新的 press', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse({ x: PLAIN_X }));
    listeners.mousedown(mouse({ x: PLAIN_X }));
    listeners.dragUp(mouse({ x: PLAIN_X, buttons: 0 }));
    expect(actions(harness)).toEqual([
      ['press', 1],
      ['release', 1],
      ['press', 1],
      ['release', 1],
    ]);
  });

  test('右键丢 mouseup：按下左键时（buttons 不含右键）补发右键 release', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse({ button: 2, buttons: 2, x: PLAIN_X }));
    listeners.mousedown(mouse({ x: PLAIN_X }));
    expect(actions(harness)).toEqual([
      ['press', 2],
      ['release', 2],
      ['press', 1],
    ]);
  });

  test('未上报过的按键松开（上报中途开启）不发 release', () => {
    let reporting = false;
    const harness = createHarness({ hit: EXPLICIT });
    harness.context.getInputRoutingState = () => ({ mouseReporting: reporting, altScroll: false });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse({ x: PLAIN_X }));
    reporting = true;
    listeners.dragMove(mouse({ x: PLAIN_X + CELL, buttons: 1 }));
    listeners.dragUp(mouse({ x: PLAIN_X + CELL, buttons: 0 }));
    expect(harness.reports).toEqual([]);
    expect(harness.calls.at(-1)).toBe('finishSelection');
  });
});

// CR4 #1：丢了左键 mouseup 后由右键事件收尾选区，真实 TerminalSelection 必须结束拖拽并停掉自动滚动。
function wireRealSelection(harness: Harness): { selection: TerminalSelection; scrolls: number[] } {
  const scrolls: number[] = [];
  const selection = new TerminalSelection({
    getLineModel: (line) => lineModelFromText(`line-${line} content`),
    hitTest: (clientX, clientY) => ({
      line: Math.floor(clientY / CELL),
      col: Math.floor(clientX / CELL),
    }),
    getScreenBounds: () => ({ top: 0, bottom: 100 }),
    scrollViewportBy: (delta) => {
      scrolls.push(delta);
      return true;
    },
    render: () => {},
    renderSelection: () => {},
  });
  harness.context.beginPointerSelection = (event) =>
    selection.begin(event.clientX, event.clientY, 'character');
  harness.context.updatePointerSelection = (event) =>
    selection.update(event.clientX, event.clientY);
  harness.context.finishPointerSelection = (point) =>
    selection.finishPointerDrag(point.clientX, point.clientY);
  return { selection, scrolls };
}

async function expectAutoScrollStopped(selection: TerminalSelection, scrolls: number[]) {
  expect(selection.dragging).toBe(false);
  const before = scrolls.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(scrolls.length).toBe(before);
}

describe('丢了左键 mouseup 的选区由其它键的事件收尾', () => {
  test('自动滚动中丢左键 mouseup → 右键按下：拖拽结束、自动滚动停止', async () => {
    const harness = createHarness({ hit: EXPLICIT });
    const { selection, scrolls } = wireRealSelection(harness);
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse({ x: PLAIN_X }));
    listeners.dragMove(mouse({ x: PLAIN_X, y: 300, buttons: 1 }));
    expect(selection.dragging).toBe(true);

    listeners.mousedown(mouse({ x: PLAIN_X, button: 2, buttons: 2 }));
    expect(isPointerDragActive(harness.context.mouse)).toBe(false);
    await expectAutoScrollStopped(selection, scrolls);
  });

  test('左键选区 + 右键按住 → 丢左键 mouseup → 右键松开：拖拽结束、自动滚动停止', async () => {
    const harness = createHarness({ hit: EXPLICIT });
    const { selection, scrolls } = wireRealSelection(harness);
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse({ x: PLAIN_X }));
    listeners.mousedown(mouse({ x: PLAIN_X, button: 2, buttons: 3 }));
    listeners.dragMove(mouse({ x: PLAIN_X, y: 300, buttons: 3 }));
    expect(selection.dragging).toBe(true);

    listeners.dragUp(mouse({ x: PLAIN_X, button: 2, buttons: 0 }));
    expect(isPointerDragActive(harness.context.mouse)).toBe(false);
    await expectAutoScrollStopped(selection, scrolls);
  });
});

describe('press 没发出去的键不记为已上报', () => {
  test('输入关闭期间按下、恢复后移动/松开：不发孤立 motion / release', () => {
    let accepting = false;
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    harness.context.emitMouseInput = (request) => {
      if (accepting) {
        harness.reports.push(request);
      }
      return accepting;
    };
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse({ x: PLAIN_X }));
    listeners.mousedown(mouse({ x: PLAIN_X, button: 2, buttons: 3 }));
    expect(harness.context.mouse.pressedButtons.size).toBe(0);

    accepting = true;
    listeners.dragMove(mouse({ x: PLAIN_X + CELL, buttons: 3 }));
    listeners.dragUp(mouse({ x: PLAIN_X + CELL, buttons: 2 }));
    listeners.dragUp(mouse({ x: PLAIN_X + CELL, button: 2, buttons: 0 }));
    expect(harness.reports).toEqual([]);
    expect(isPointerDragActive(harness.context.mouse)).toBe(false);
  });
});

describe('Shift 绕过上报的本地选区贯穿整次手势', () => {
  test('选区中按下/松开右键：不上报、不清选区，选区拖动照常更新', () => {
    const harness = createHarness({ hit: EXPLICIT, reporting: true });
    const listeners = createPointerListeners(harness.context);
    listeners.mousedown(mouse({ x: PLAIN_X, shift: true }));
    listeners.mousedown(mouse({ x: PLAIN_X, shift: true, button: 2, buttons: 3 }));
    listeners.dragMove(mouse({ x: PLAIN_X + CELL, buttons: 3 }));
    listeners.dragUp(mouse({ x: PLAIN_X + CELL, button: 2, buttons: 1 }));
    listeners.dragMove(mouse({ x: PLAIN_X + 2 * CELL, buttons: 1 }));
    listeners.dragUp(mouse({ x: PLAIN_X + 2 * CELL, buttons: 0 }));
    expect(harness.reports).toEqual([]);
    expect(harness.calls).toEqual([
      'beginSelection',
      'updateSelection',
      'updateSelection',
      'finishSelection',
    ]);
  });
});

// 伪随机序列：模拟一只物理鼠标（按键 0/1/2，随机修饰键，随机落在链接/非链接格），
// 偶尔丢掉 mouseup。每一步都断言上报流满足不变式，序列结束时全部按键都已成对收尾。
type Physical = { held: Set<number>; reporting: boolean };

const DOM_BIT: Record<number, number> = { 0: 1, 1: 4, 2: 2 };

function heldMask(held: Set<number>): number {
  let mask = 0;
  for (const button of held) {
    mask |= DOM_BIT[button] ?? 0;
  }
  return mask;
}

function createRandom(seed: number): () => number {
  let state = seed % 2147483647 || 1;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

function checkReports(reports: MouseInputRequest[], appPressed: Set<number>, from: number): void {
  for (const report of reports.slice(from)) {
    const button = report.button ?? null;
    expect(button).not.toBeNull();
    if (report.action === 'press') {
      expect(appPressed.has(button as number)).toBe(false);
      appPressed.add(button as number);
    } else if (report.action === 'release') {
      expect(appPressed.delete(button as number)).toBe(true);
      expect(report.anyButtonPressed).toBe(appPressed.size > 0);
    } else {
      expect(appPressed.has(button as number)).toBe(true);
    }
  }
}

function runSequence(seed: number, physical: Physical): void {
  const random = createRandom(seed);
  const hit = random() < 0.5 ? EXPLICIT : DETECTED;
  const harness = createHarness({ hit, reporting: physical.reporting });
  const listeners = createPointerListeners(harness.context);
  const appPressed = new Set<number>();
  let checked = 0;
  const event = () => ({
    x: random() < 0.5 ? LINK_X : PLAIN_X,
    modifier: random() < 0.3,
    shift: random() < 0.15,
    buttons: heldMask(physical.held),
  });

  for (let step = 0; step < 40; step += 1) {
    const roll = random();
    const button = Math.floor(random() * 3);
    if (roll < 0.35 && !physical.held.has(button)) {
      physical.held.add(button);
      listeners.mousedown(mouse({ ...event(), button }));
    } else if (roll < 0.7 && physical.held.has(button)) {
      physical.held.delete(button);
      if (random() >= 0.2) {
        listeners.dragUp(mouse({ ...event(), button }));
      }
    } else {
      const move = mouse(event());
      listeners.mousemove(move);
      listeners.dragMove(move);
    }
    checkReports(harness.reports, appPressed, checked);
    checked = harness.reports.length;
  }

  physical.held.clear();
  listeners.dragMove(mouse({ x: PLAIN_X, buttons: 0 }));
  checkReports(harness.reports, appPressed, checked);
  expect(appPressed.size).toBe(0);
  expect(isPointerDragActive(harness.context.mouse)).toBe(false);
  expect(harness.context.mouse.pendingLink).toBeNull();
}

describe('任意按键交错序列下的上报不变式', () => {
  test('上报开启 / 关闭各 200 条序列', () => {
    for (const reporting of [true, false]) {
      for (let seed = 1; seed <= 200; seed += 1) {
        runSequence(seed * 7919 + (reporting ? 1 : 0), { held: new Set(), reporting });
      }
    }
  });

  test('松开到无按键时（mouseup 未丢）拖拽状态立即清空', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = createRandom(seed);
      const harness = createHarness({ hit: EXPLICIT, reporting: random() < 0.5 });
      const listeners = createPointerListeners(harness.context);
      const held = new Set<number>();
      for (let step = 0; step < 30; step += 1) {
        const button = Math.floor(random() * 3);
        const x = random() < 0.5 ? LINK_X : PLAIN_X;
        const modifier = random() < 0.3;
        if (held.has(button)) {
          held.delete(button);
          listeners.dragUp(mouse({ x, modifier, button, buttons: heldMask(held) }));
        } else {
          held.add(button);
          listeners.mousedown(mouse({ x, modifier, button, buttons: heldMask(held) }));
        }
        if (held.size === 0) {
          expect(isPointerDragActive(harness.context.mouse)).toBe(false);
        }
      }
    }
  });
});
