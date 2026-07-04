import { describe, expect, test } from 'bun:test';

import { createThemeSubscriptionTracker } from './theme-subscriptions';

describe('theme subscription tracker', () => {
  test('note/clear/has 基本状态转换', () => {
    const tracker = createThemeSubscriptionTracker();
    tracker.note('%1', true);
    tracker.note('%2', true);
    expect(tracker.has('%1')).toBe(true);
    expect(tracker.list().sort()).toEqual(['%1', '%2']);
    tracker.note('%1', false);
    expect(tracker.has('%1')).toBe(false);
    tracker.clear('%2');
    expect(tracker.list()).toEqual([]);
  });

  test('prune 只保留存活 pane', () => {
    const tracker = createThemeSubscriptionTracker();
    tracker.note('%1', true);
    tracker.note('%2', true);
    tracker.prune(new Set(['%2', '%3']));
    expect(tracker.list()).toEqual(['%2']);
  });

  test('restore 批量恢复，reset 清空', () => {
    const tracker = createThemeSubscriptionTracker();
    tracker.restore(['%4', '%5']);
    expect(tracker.list().sort()).toEqual(['%4', '%5']);
    tracker.reset();
    expect(tracker.list()).toEqual([]);
  });
});
