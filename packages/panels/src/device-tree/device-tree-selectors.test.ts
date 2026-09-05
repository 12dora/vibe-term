import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload, TmuxWindow } from '@tmex/shared';
import {
  type DeviceConnectivitySlice,
  type DeviceSnapshotSlice,
  mergeReorderedVisibleIds,
  selectDeviceOnline,
  selectDeviceWindows,
  selectSidebarVisibleDevices,
  shouldHideSidebarNodeSection,
} from './device-tree-selectors';

const makeWindow = (id: string): TmuxWindow => ({
  id,
  name: id,
  index: 0,
  active: false,
  panes: [],
});

const makeSnapshot = (deviceId: string, windows: TmuxWindow[]): StateSnapshotPayload => ({
  deviceId,
  session: { id: `session-${deviceId}`, name: deviceId, windows },
});

const connectivity = (
  overrides: Partial<DeviceConnectivitySlice> = {}
): DeviceConnectivitySlice => ({
  deviceConnected: {},
  deviceErrors: {},
  deviceReconnecting: {},
  ...overrides,
});

describe('selectDeviceWindows', () => {
  test('returns the same array identity for the same state', () => {
    const state: DeviceSnapshotSlice = {
      snapshots: { d1: makeSnapshot('d1', [makeWindow('w1')]) },
    };

    expect(selectDeviceWindows(state, 'd1')).toBe(selectDeviceWindows(state, 'd1'));
  });

  test('keeps another device slice identical when one device gets patched', () => {
    const snapshotA = makeSnapshot('d1', [makeWindow('w1')]);
    const before: DeviceSnapshotSlice = {
      snapshots: { d1: snapshotA, d2: makeSnapshot('d2', [makeWindow('w2')]) },
    };
    const after: DeviceSnapshotSlice = {
      snapshots: {
        ...before.snapshots,
        d2: makeSnapshot('d2', [makeWindow('w2'), makeWindow('w3')]),
      },
    };

    expect(after.snapshots).not.toBe(before.snapshots);
    expect(selectDeviceWindows(after, 'd1')).toBe(selectDeviceWindows(before, 'd1'));
    expect(selectDeviceWindows(after, 'd2')).not.toBe(selectDeviceWindows(before, 'd2'));
  });

  test('returns null for an unknown device or a session-less snapshot', () => {
    const state: DeviceSnapshotSlice = {
      snapshots: { d1: { deviceId: 'd1', session: null } },
    };

    expect(selectDeviceWindows(state, 'd1')).toBeNull();
    expect(selectDeviceWindows(state, 'missing')).toBeNull();
  });

  test('does not resolve prototype keys', () => {
    expect(selectDeviceWindows({ snapshots: {} }, '__proto__')).toBeNull();
    expect(selectDeviceWindows({ snapshots: {} }, 'constructor')).toBeNull();
  });
});

describe('selectDeviceOnline', () => {
  test('is true only when connected without error and not reconnecting', () => {
    const state = connectivity({ deviceConnected: { d1: true } });
    expect(selectDeviceOnline(state, 'd1')).toBe(true);
  });

  test('is false when disconnected, errored or reconnecting', () => {
    expect(selectDeviceOnline(connectivity(), 'd1')).toBe(false);
    expect(selectDeviceOnline(connectivity({ deviceConnected: { d1: false } }), 'd1')).toBe(false);
    expect(
      selectDeviceOnline(
        connectivity({ deviceConnected: { d1: true }, deviceErrors: { d1: { message: 'boom' } } }),
        'd1'
      )
    ).toBe(false);
    expect(
      selectDeviceOnline(
        connectivity({ deviceConnected: { d1: true }, deviceReconnecting: { d1: { at: 1 } } }),
        'd1'
      )
    ).toBe(false);
  });

  test('is unaffected by another device flipping state', () => {
    const before = connectivity({ deviceConnected: { d1: true } });
    const after = connectivity({ deviceConnected: { ...before.deviceConnected, d2: true } });

    expect(selectDeviceOnline(after, 'd1')).toBe(selectDeviceOnline(before, 'd1'));
  });

  test('does not resolve prototype keys', () => {
    expect(selectDeviceOnline(connectivity(), '__proto__')).toBe(false);
    expect(selectDeviceOnline(connectivity(), 'constructor')).toBe(false);
  });
});

describe('selectSidebarVisibleDevices', () => {
  const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
  const devices = [{ id: 'd1' }, { id: 'd2' }];

  test('本机 runtime 缺省全部显示', () => {
    expect(selectSidebarVisibleDevices(devices, {}, 'self')).toEqual(devices);
  });

  test('本机 runtime 显式关掉的那台被滤掉', () => {
    expect(selectSidebarVisibleDevices(devices, { 'self:d1': false }, 'self')).toEqual([
      { id: 'd2' },
    ]);
  });

  test('远端 node 缺省一台都不显示，勾选后才出现', () => {
    expect(selectSidebarVisibleDevices(devices, {}, NODE_A)).toEqual([]);
    expect(selectSidebarVisibleDevices(devices, { [`${NODE_A}:d2`]: true }, NODE_A)).toEqual([
      { id: 'd2' },
    ]);
  });

  test('当前选中的设备无条件保留（否则点进隐藏的远端设备后没有树可点）', () => {
    expect(selectSidebarVisibleDevices(devices, {}, NODE_A, 'd1')).toEqual([{ id: 'd1' }]);
    expect(selectSidebarVisibleDevices(devices, { 'self:d1': false }, 'self', 'd1')).toEqual(
      devices
    );
  });

  test('选中的设备不属于本 runtime 时不影响过滤结果', () => {
    expect(selectSidebarVisibleDevices(devices, {}, NODE_A, 'other')).toEqual([]);
  });
});

describe('shouldHideSidebarNodeSection', () => {
  test('有可显示的设备就渲染', () => {
    expect(shouldHideSidebarNodeSection({ total: 3, visible: 1 }, false)).toBe(false);
    expect(shouldHideSidebarNodeSection({ total: 1, visible: 1 }, true)).toBe(false);
  });

  test('有设备但一台都没勾选显示时整节隐藏（本机也一样）', () => {
    expect(shouldHideSidebarNodeSection({ total: 3, visible: 0 }, false)).toBe(true);
    expect(shouldHideSidebarNodeSection({ total: 3, visible: 0 }, true)).toBe(true);
  });

  test('一台设备都没有：远端 node 隐藏，本机保留空态引导', () => {
    expect(shouldHideSidebarNodeSection({ total: 0, visible: 0 }, false)).toBe(true);
    expect(shouldHideSidebarNodeSection({ total: 0, visible: 0 }, true)).toBe(false);
  });

  test('设备列表还没落地（pending）时一律不隐藏，节点头必须先出来', () => {
    expect(shouldHideSidebarNodeSection({ total: 0, visible: 0, pending: true }, false)).toBe(
      false
    );
    expect(shouldHideSidebarNodeSection({ total: 3, visible: 0, pending: true }, false)).toBe(
      false
    );
    // 落地之后（pending=false）照旧
    expect(shouldHideSidebarNodeSection({ total: 3, visible: 0, pending: false }, false)).toBe(
      true
    );
  });
});

describe('mergeReorderedVisibleIds', () => {
  test('没有隐藏设备时结果就是拖拽后的顺序', () => {
    const all = ['a', 'b', 'c'];

    expect(mergeReorderedVisibleIds(all, all, ['b', 'a', 'c'])).toEqual(['b', 'a', 'c']);
  });

  test('隐藏设备夹在中间时留在原槽位', () => {
    const all = ['a', 'hidden', 'b', 'c'];
    const visibleBefore = ['a', 'b', 'c'];

    expect(mergeReorderedVisibleIds(all, visibleBefore, ['c', 'a', 'b'])).toEqual([
      'c',
      'hidden',
      'a',
      'b',
    ]);
  });

  test('隐藏设备在首尾时同样留在原槽位', () => {
    const all = ['h1', 'a', 'b', 'h2'];
    const visibleBefore = ['a', 'b'];

    expect(mergeReorderedVisibleIds(all, visibleBefore, ['b', 'a'])).toEqual([
      'h1',
      'b',
      'a',
      'h2',
    ]);
  });

  test('把首个可见设备拖到最后', () => {
    const all = ['a', 'h1', 'b', 'h2', 'c'];
    const visibleBefore = ['a', 'b', 'c'];

    expect(mergeReorderedVisibleIds(all, visibleBefore, ['b', 'c', 'a'])).toEqual([
      'b',
      'h1',
      'c',
      'h2',
      'a',
    ]);
  });

  test('把最后一个可见设备拖到最前', () => {
    const all = ['a', 'h1', 'b', 'h2', 'c'];
    const visibleBefore = ['a', 'b', 'c'];

    expect(mergeReorderedVisibleIds(all, visibleBefore, ['c', 'a', 'b'])).toEqual([
      'c',
      'h1',
      'a',
      'h2',
      'b',
    ]);
  });

  test('结果始终是完整设备集合的一个排列（不丢不重）', () => {
    const all = ['h1', 'a', 'h2', 'b', 'c', 'h3'];
    const merged = mergeReorderedVisibleIds(all, ['a', 'b', 'c'], ['c', 'b', 'a']);

    expect([...merged].sort()).toEqual([...all].sort());
    expect(new Set(merged).size).toBe(all.length);
  });

  test('可见 id 尚未出现在完整顺序里时补到末尾，不被丢掉', () => {
    const merged = mergeReorderedVisibleIds(['h1', 'a'], ['a', 'fresh'], ['fresh', 'a']);

    expect(merged).toEqual(['h1', 'fresh', 'a']);
  });
});
