import { describe, expect, test } from 'bun:test';
import { hitsTerminalSurface, shouldSuppressTapSyntheticMouse } from './tap-focus';

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
