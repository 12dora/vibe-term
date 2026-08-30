import { describe, expect, test } from 'bun:test';
import { PANE_CLOSE_ATTR, isPaneCloseTarget } from './paneCloseTarget';

/** 只按 `closest(selector)` 的结果判定，用最小替身模拟命中 / 未命中。 */
function target(matches: boolean): { closest: (selector: string) => unknown } {
  return { closest: (selector) => (matches && selector === `[${PANE_CLOSE_ATTR}]` ? {} : null) };
}

describe('isPaneCloseTarget', () => {
  test('关闭控件本身与它内部的子节点都算命中', () => {
    expect(isPaneCloseTarget(target(true))).toBe(true);
  });

  test('pane 里的其他元素不算', () => {
    expect(isPaneCloseTarget(target(false))).toBe(false);
  });

  test('没有 closest 的事件目标（document / 文本节点等）一律不算', () => {
    expect(isPaneCloseTarget(null)).toBe(false);
    expect(isPaneCloseTarget(undefined)).toBe(false);
    expect(isPaneCloseTarget({})).toBe(false);
    expect(isPaneCloseTarget({ closest: 'not-a-function' })).toBe(false);
  });
});
