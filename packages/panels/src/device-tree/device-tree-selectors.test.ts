import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload, TmuxWindow } from '@tmex/shared';
import {
  type DeviceConnectivitySlice,
  type DeviceSnapshotSlice,
  selectDeviceOnline,
  selectDeviceWindows,
  selectSidebarVisibleDevices,
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
