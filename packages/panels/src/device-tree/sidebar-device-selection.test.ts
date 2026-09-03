// 设备行的选中 props：DeviceRow 是 memo 组件，React 对这三个 prop 做浅比较，
// 所以「切 pane 时未选中设备拿到的 props 逐字段同值」等价于「那些行不会重渲染」。

import { describe, expect, test } from 'bun:test';
import type { DeviceTreeSelection } from './device-tree-navigation';
import { deviceRowSelection } from './sidebar-device-list';

const SELECTION_A1: DeviceTreeSelection = {
  selectedDeviceId: 'dev-a',
  selectedWindowId: '@1',
  selectedPaneId: '%1',
};
const SELECTION_A2: DeviceTreeSelection = {
  selectedDeviceId: 'dev-a',
  selectedWindowId: '@2',
  selectedPaneId: '%9',
};

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

describe('deviceRowSelection', () => {
  test('选中的设备拿到完整的窗口/pane 选中态', () => {
    expect(deviceRowSelection(SELECTION_A1, 'dev-a')).toEqual({
      isSelected: true,
      selectedWindowId: '@1',
      selectedPaneId: '%1',
    });
  });

  test('未选中的设备只拿到 isSelected=false', () => {
    expect(deviceRowSelection(SELECTION_A1, 'dev-b')).toEqual({ isSelected: false });
  });

  test('在 dev-a 里切 pane 时，其它设备行的 props 逐字段同值（memo 可 bail）', () => {
    for (const deviceId of ['dev-b', 'dev-c', 'dev-d']) {
      const before = deviceRowSelection(SELECTION_A1, deviceId);
      const after = deviceRowSelection(SELECTION_A2, deviceId);
      expect(shallowEqual(before, after)).toBe(true);
    }

    // 选中的那台确实变了，否则等于什么都没渲染
    expect(
      shallowEqual(
        deviceRowSelection(SELECTION_A1, 'dev-a'),
        deviceRowSelection(SELECTION_A2, 'dev-a')
      )
    ).toBe(false);
  });

  test('窗口/pane id 跨设备撞号也不会误标选中', () => {
    // tmux 的 @1/%1 在每台设备上都存在：未选中的设备必须拿不到这两个值
    const other = deviceRowSelection(SELECTION_A1, 'dev-b');
    expect(other.selectedWindowId).toBeUndefined();
    expect(other.selectedPaneId).toBeUndefined();
  });

  test('没有任何设备被选中时全部为未选中', () => {
    expect(deviceRowSelection({}, 'dev-a')).toEqual({ isSelected: false });
  });
});
