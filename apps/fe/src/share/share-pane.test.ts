import { describe, expect, test } from 'bun:test';
import { resolveSharePaneId } from './share-pane';

const PANES = [{ id: '%1' }, { id: '%2' }];

describe('resolveSharePaneId', () => {
  test('查询参数点名的 pane 仍在窗口里就用它', () => {
    expect(resolveSharePaneId(PANES, '%2')).toBe('%2');
  });

  test('点名的 pane 已不在窗口里则回落到第一个', () => {
    expect(resolveSharePaneId(PANES, '%9')).toBe('%1');
  });

  test('没点名时用第一个', () => {
    expect(resolveSharePaneId(PANES, null)).toBe('%1');
    expect(resolveSharePaneId(PANES, undefined)).toBe('%1');
  });

  test('快照未到 / 空窗口返回 undefined', () => {
    expect(resolveSharePaneId(undefined, '%1')).toBeUndefined();
    expect(resolveSharePaneId([], null)).toBeUndefined();
  });
});
