import { describe, expect, test } from 'bun:test';
import {
  CLOSED_MOBILE_SIDEBAR,
  autoOpenMobileSidebar,
  mobileSheetInitialFocus,
  setMobileSidebarOpen,
} from './mobile-open';

describe('setMobileSidebarOpen', () => {
  test('用户自己开的抽屉走默认焦点管理', () => {
    const opened = setMobileSidebarOpen(CLOSED_MOBILE_SIDEBAR, true);
    expect(opened).toEqual({ open: true, suppressInitialFocus: false });
    expect(mobileSheetInitialFocus(opened)).toBeUndefined();
  });

  test('关掉抽屉时把自动弹出的标记复位（下次手动打开焦点照常）', () => {
    const auto = autoOpenMobileSidebar(CLOSED_MOBILE_SIDEBAR);
    const closed = setMobileSidebarOpen(auto, false);
    expect(closed).toEqual({ open: false, suppressInitialFocus: false });
    expect(mobileSheetInitialFocus(setMobileSidebarOpen(closed, true))).toBeUndefined();
  });

  test('自动弹出后再收到一次手动打开 → 标记同样复位', () => {
    const auto = autoOpenMobileSidebar(CLOSED_MOBILE_SIDEBAR);
    expect(setMobileSidebarOpen(auto, true)).toEqual({ open: true, suppressInitialFocus: false });
  });

  test('状态没变化时返回同一个对象，不白白触发重渲染', () => {
    const opened = setMobileSidebarOpen(CLOSED_MOBILE_SIDEBAR, true);
    expect(setMobileSidebarOpen(opened, true)).toBe(opened);
    expect(setMobileSidebarOpen(CLOSED_MOBILE_SIDEBAR, false)).toBe(CLOSED_MOBILE_SIDEBAR);
  });
});

describe('autoOpenMobileSidebar', () => {
  test('替用户弹出的这一次不移动焦点', () => {
    const auto = autoOpenMobileSidebar(CLOSED_MOBILE_SIDEBAR);
    expect(auto).toEqual({ open: true, suppressInitialFocus: true });
    expect(mobileSheetInitialFocus(auto)).toBe(false);
  });

  test('StrictMode 下 effect 跑两遍：第二次是幂等的同一个状态', () => {
    const first = autoOpenMobileSidebar(CLOSED_MOBILE_SIDEBAR);
    const second = autoOpenMobileSidebar(first);
    expect(second).toBe(first);
    expect(mobileSheetInitialFocus(second)).toBe(false);
  });

  test('用户关掉后又被自动弹出（重新挂载）时照样跳过焦点', () => {
    const reopened = autoOpenMobileSidebar(
      setMobileSidebarOpen(autoOpenMobileSidebar(CLOSED_MOBILE_SIDEBAR), false)
    );
    expect(mobileSheetInitialFocus(reopened)).toBe(false);
  });
});

// `false` = Base UI 打开时不移动焦点；`undefined` = 交回它自己的默认行为。
// 传 null / true 都会变成「聚焦第一个可聚焦元素」，正是要避开的那个行为。
describe('mobileSheetInitialFocus', () => {
  test('只有跳过标记为真时才给 false，其余一律 undefined', () => {
    expect(mobileSheetInitialFocus(CLOSED_MOBILE_SIDEBAR)).toBeUndefined();
    expect(mobileSheetInitialFocus({ open: true, suppressInitialFocus: false })).toBeUndefined();
    expect(mobileSheetInitialFocus({ open: true, suppressInitialFocus: true })).toBe(false);
  });
});
