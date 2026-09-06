import { describe, expect, test } from 'bun:test';
import {
  cursorRowFromTerminal,
  hitsTerminalSurface,
  shouldSuppressTapSyntheticMouse,
  tapHitsCursorRow,
} from './tap-focus';

function target(selectors: string[]) {
  return {
    closest(selector: string) {
      return selectors.includes(selector) ? this : null;
    },
  };
}

describe('hitsTerminalSurface', () => {
  test('命中终端画布子树', () => {
    expect(hitsTerminalSurface(target(['.xterm']))).toBe(true);
  });

  test('覆盖层（选区工具条 / 快捷键栏）不算画布', () => {
    expect(hitsTerminalSurface(target(['[data-testid="terminal-selection-toolbar"]']))).toBe(false);
  });

  test('非元素目标一律 false', () => {
    expect(hitsTerminalSurface(null)).toBe(false);
    expect(hitsTerminalSurface('x')).toBe(false);
    expect(hitsTerminalSurface({})).toBe(false);
  });
});

describe('shouldSuppressTapSyntheticMouse', () => {
  test('画布上的轻点要压掉合成鼠标序列（不弹也不收软键盘）', () => {
    expect(shouldSuppressTapSyntheticMouse({ moved: false, target: target(['.xterm']) })).toBe(
      true
    );
  });

  test('滚动过的手势不是轻点，合成序列本就不会产生，不干预', () => {
    expect(shouldSuppressTapSyntheticMouse({ moved: true, target: target(['.xterm']) })).toBe(
      false
    );
  });

  test('覆盖层上的轻点必须放行，否则工具条按钮点不动', () => {
    expect(
      shouldSuppressTapSyntheticMouse({
        moved: false,
        target: target(['[data-testid="terminal-selection-toolbar"]']),
      })
    ).toBe(false);
  });
});

describe('cursorRowFromTerminal', () => {
  const atBottom = { viewportY: 12, baseY: 12 };

  test('可见光标给出视口行号', () => {
    expect(
      cursorRowFromTerminal({ lastCursor: { visible: true, y: 7 }, buffer: { active: atBottom } })
    ).toBe(7);
  });

  test('光标不可见 / 无行号 / 读不到时为 null', () => {
    expect(cursorRowFromTerminal({ lastCursor: { visible: false, y: 7 } })).toBeNull();
    expect(cursorRowFromTerminal({ lastCursor: { visible: true, y: null } })).toBeNull();
    expect(cursorRowFromTerminal({})).toBeNull();
    expect(cursorRowFromTerminal(null)).toBeNull();
  });

  test('滚回历史时光标行不在屏上，不认', () => {
    expect(
      cursorRowFromTerminal({
        lastCursor: { visible: true, y: 7 },
        buffer: { active: { viewportY: 4, baseY: 12 } },
      })
    ).toBeNull();
  });
});

describe('tapHitsCursorRow', () => {
  const base = { screenTop: 100, cellHeight: 20, cursorRow: 5 };

  test('点在光标行上命中', () => {
    // 行 5 = client y ∈ [200, 220)
    expect(tapHitsCursorRow({ ...base, clientY: 210 })).toBe(true);
  });

  test('上下各一行容差内也命中', () => {
    expect(tapHitsCursorRow({ ...base, clientY: 185 })).toBe(true);
    expect(tapHitsCursorRow({ ...base, clientY: 230 })).toBe(true);
  });

  test('容差之外不命中', () => {
    expect(tapHitsCursorRow({ ...base, clientY: 165 })).toBe(false);
    expect(tapHitsCursorRow({ ...base, clientY: 255 })).toBe(false);
  });

  test('拿不到光标行或 cell 尺寸时一律不命中', () => {
    expect(tapHitsCursorRow({ ...base, cursorRow: null, clientY: 210 })).toBe(false);
    expect(tapHitsCursorRow({ ...base, cellHeight: 0, clientY: 210 })).toBe(false);
  });
});
