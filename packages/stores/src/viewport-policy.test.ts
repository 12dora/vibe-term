import { describe, expect, test } from 'bun:test';
import {
  type ViewportPolicyMap,
  applyViewportPolicy,
  clearViewportPolicyForDevice,
  paneViewportKey,
  selectPaneViewportOwner,
  selectPaneViewportPolicy,
} from './viewport-policy';

const event = (overrides: Partial<Parameters<typeof applyViewportPolicy>[1]> = {}) => ({
  deviceId: 'dev-a',
  windowId: '@1',
  paneId: '%1',
  owner: false,
  cols: 120,
  rows: 40,
  ...overrides,
});

describe('applyViewportPolicy', () => {
  test('stores the policy under the device:pane key', () => {
    const next = applyViewportPolicy({}, event());
    expect(next[paneViewportKey('dev-a', '%1')]).toEqual({
      owner: false,
      cols: 120,
      rows: 40,
      windowId: '@1',
    });
  });

  test('keeps the same map reference when nothing changed', () => {
    const first = applyViewportPolicy({}, event());
    expect(applyViewportPolicy(first, event())).toBe(first);
  });

  test('replaces the entry when the winner or geometry changes', () => {
    const first = applyViewportPolicy({}, event());
    const second = applyViewportPolicy(first, event({ owner: true, cols: 200 }));
    expect(second).not.toBe(first);
    expect(second[paneViewportKey('dev-a', '%1')]).toMatchObject({ owner: true, cols: 200 });
  });

  test('ignores events without a device or pane', () => {
    const map: ViewportPolicyMap = {};
    expect(applyViewportPolicy(map, event({ deviceId: '' }))).toBe(map);
    expect(applyViewportPolicy(map, event({ paneId: '' }))).toBe(map);
  });
});

describe('clearViewportPolicyForDevice', () => {
  test('drops every pane of that device and leaves the others alone', () => {
    let map: ViewportPolicyMap = {};
    map = applyViewportPolicy(map, event());
    map = applyViewportPolicy(map, event({ paneId: '%2' }));
    map = applyViewportPolicy(map, event({ deviceId: 'dev-b' }));

    const cleared = clearViewportPolicyForDevice(map, 'dev-a');
    expect(Object.keys(cleared)).toEqual([paneViewportKey('dev-b', '%1')]);
  });

  test('keeps the same map reference when the device holds no policy', () => {
    const map = applyViewportPolicy({}, event());
    expect(clearViewportPolicyForDevice(map, 'dev-b')).toBe(map);
  });
});

describe('selectPaneViewportOwner', () => {
  test('defaults to owner when no policy has been received', () => {
    expect(selectPaneViewportOwner({ viewportPolicy: {} }, 'dev-a', '%1')).toBe(true);
    expect(selectPaneViewportOwner({ viewportPolicy: {} }, undefined, '%1')).toBe(true);
    expect(selectPaneViewportOwner({ viewportPolicy: {} }, 'dev-a', undefined)).toBe(true);
  });

  test('follows the received policy', () => {
    const viewportPolicy = applyViewportPolicy({}, event());
    expect(selectPaneViewportOwner({ viewportPolicy }, 'dev-a', '%1')).toBe(false);
    expect(selectPaneViewportPolicy({ viewportPolicy }, 'dev-a', '%1')).toMatchObject({
      cols: 120,
      rows: 40,
    });
    // 另一个 pane 没有策略：仍按默认 owner 处理
    expect(selectPaneViewportOwner({ viewportPolicy }, 'dev-a', '%9')).toBe(true);
  });
});
