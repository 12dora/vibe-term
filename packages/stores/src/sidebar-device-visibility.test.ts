import { describe, expect, test } from 'bun:test';
import {
  isSidebarDeviceVisible,
  isSidebarFilesVisible,
  sidebarDeviceVisibilityKey,
} from './sidebar-device-visibility';

const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

describe('sidebarDeviceVisibilityKey', () => {
  test('按 `${runtimeNodeId}:${deviceId}` 组合（device id 只在 node 内唯一）', () => {
    expect(sidebarDeviceVisibilityKey('self', 'd1')).toBe('self:d1');
    expect(sidebarDeviceVisibilityKey(NODE_A, 'd1')).toBe(`${NODE_A}:d1`);
  });
});

describe('isSidebarDeviceVisible', () => {
  test('无记录时本机设备默认显示、远端设备默认隐藏', () => {
    expect(isSidebarDeviceVisible({}, 'self', 'd1')).toBe(true);
    expect(isSidebarDeviceVisible({}, NODE_A, 'd1')).toBe(false);
  });

  test('显式记录优先于默认值（两个方向都生效）', () => {
    expect(isSidebarDeviceVisible({ 'self:d1': false }, 'self', 'd1')).toBe(false);
    expect(isSidebarDeviceVisible({ [`${NODE_A}:d1`]: true }, NODE_A, 'd1')).toBe(true);
  });

  test('同名 device id 在不同 node 下互不影响', () => {
    const map = { 'self:d1': false, [`${NODE_A}:d1`]: true };
    expect(isSidebarDeviceVisible(map, 'self', 'd1')).toBe(false);
    expect(isSidebarDeviceVisible(map, NODE_A, 'd1')).toBe(true);
  });
});

describe('isSidebarFilesVisible', () => {
  test('无记录时只有本机且配了目录的设备默认显示', () => {
    expect(isSidebarFilesVisible({}, 'self', 'd1', true)).toBe(true);
    expect(isSidebarFilesVisible({}, 'self', 'd1', false)).toBe(false);
  });

  test('无记录时远端 node 的设备默认隐藏，配了目录也一样', () => {
    expect(isSidebarFilesVisible({}, NODE_A, 'd1', true)).toBe(false);
    expect(isSidebarFilesVisible({}, NODE_A, 'd1', false)).toBe(false);
  });

  test('显式记录优先于默认值（两个方向都生效）', () => {
    expect(isSidebarFilesVisible({ 'self:d1': false }, 'self', 'd1', true)).toBe(false);
    expect(isSidebarFilesVisible({ [`${NODE_A}:d1`]: true }, NODE_A, 'd1', false)).toBe(true);
  });

  test('与终端页共用复合键，但读的是各自的表', () => {
    const filesMap = { 'self:d1': true };
    expect(isSidebarFilesVisible(filesMap, 'self', 'd1', false)).toBe(true);
    expect(isSidebarDeviceVisible({}, 'self', 'd1')).toBe(true);
    expect(isSidebarFilesVisible({}, NODE_A, 'd1', false)).toBe(false);
  });
});
