import { describe, expect, test } from 'bun:test';
import {
  SELECTION_TOOLBAR_SELECTOR,
  type SelectionDismissIntent,
  shouldDismissSelectionOnPointerDown,
} from './selection-dismiss';

// bun 没有 DOM 全局：用鸭子类型的 closest 模拟事件 target 的祖先链。
function target(selectors: string[] = []) {
  const node = {
    closest(selector: string) {
      return selectors.includes(selector) ? node : null;
    },
  };
  return node;
}

function intent(overrides: Partial<SelectionDismissIntent> = {}): SelectionDismissIntent {
  return {
    hasSelection: true,
    pointerType: 'mouse',
    button: 0,
    target: target(),
    ...overrides,
  };
}

describe('shouldDismissSelectionOnPointerDown', () => {
  test('有选区时在画布上按下左键：收起工具条', () => {
    expect(shouldDismissSelectionOnPointerDown(intent())).toBeTrue();
  });

  test('没有选区时不动作', () => {
    expect(shouldDismissSelectionOnPointerDown(intent({ hasSelection: false }))).toBeFalse();
  });

  test('按在工具条内（复制/粘贴/关闭）不收起', () => {
    expect(
      shouldDismissSelectionOnPointerDown(intent({ target: target([SELECTION_TOOLBAR_SELECTOR]) }))
    ).toBeFalse();
  });

  test('触摸不参与：交给移动端手势机', () => {
    expect(shouldDismissSelectionOnPointerDown(intent({ pointerType: 'touch' }))).toBeFalse();
  });

  test('触控笔与鼠标同路径', () => {
    expect(shouldDismissSelectionOnPointerDown(intent({ pointerType: 'pen' }))).toBeTrue();
  });

  test('非左键（右键菜单/中键）不收起', () => {
    expect(shouldDismissSelectionOnPointerDown(intent({ button: 2 }))).toBeFalse();
    expect(shouldDismissSelectionOnPointerDown(intent({ button: 1 }))).toBeFalse();
  });

  test('target 缺失或非元素时按画布处理', () => {
    expect(shouldDismissSelectionOnPointerDown(intent({ target: null }))).toBeTrue();
    expect(shouldDismissSelectionOnPointerDown(intent({ target: {} }))).toBeTrue();
  });
});
