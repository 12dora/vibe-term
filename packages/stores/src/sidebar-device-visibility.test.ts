import { describe, expect, test } from 'bun:test';
import {
  isSidebarDeviceVisible,
  isSidebarFilesVisible,
  mayShowSidebarFilesNode,
  pruneStaleSidebarFilesVisibility,
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

describe('mayShowSidebarFilesNode', () => {
  const NODE_B = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';

  test('远端 node 没有任何显式打开的设备时不出分节（缺省隐藏，点开必为空）', () => {
    expect(mayShowSidebarFilesNode({}, NODE_A)).toBe(false);
    expect(mayShowSidebarFilesNode({ [`${NODE_A}:d1`]: false }, NODE_A)).toBe(false);
  });

  test('远端 node 至少一台设备显式打开时出分节', () => {
    expect(
      mayShowSidebarFilesNode({ [`${NODE_A}:d1`]: false, [`${NODE_A}:d2`]: true }, NODE_A)
    ).toBe(true);
  });

  test('别的 node 的开关不串到本 node', () => {
    expect(mayShowSidebarFilesNode({ [`${NODE_B}:d1`]: true, 'self:d1': true }, NODE_A)).toBe(
      false
    );
  });

  test('本机缺省可见，推断不出，一律交给目录列表判断', () => {
    expect(mayShowSidebarFilesNode({}, 'self')).toBe(true);
    expect(mayShowSidebarFilesNode({ 'self:d1': false }, 'self')).toBe(true);
  });
});

describe('pruneStaleSidebarFilesVisibility', () => {
  const NODE_B = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';

  test('显式打开但设备已没有目录（或已删除）的键被清掉，有目录的保留', () => {
    const map = { [`${NODE_A}:d-gone`]: true, [`${NODE_A}:d-kept`]: true };
    expect(pruneStaleSidebarFilesVisibility(map, NODE_A, new Set(['d-kept']))).toEqual({
      [`${NODE_A}:d-kept`]: true,
    });
  });

  test('清掉最后一个打开键后该远端 node 不再出分节头', () => {
    const map = { [`${NODE_A}:d1`]: true };
    expect(mayShowSidebarFilesNode(map, NODE_A)).toBe(true);
    const next = pruneStaleSidebarFilesVisibility(map, NODE_A, new Set());
    expect(mayShowSidebarFilesNode(next, NODE_A)).toBe(false);
  });

  test('显式关闭的键与别的 node 的键原样保留', () => {
    const map = {
      [`${NODE_A}:d-off`]: false,
      [`${NODE_B}:d1`]: true,
      'self:d1': true,
    };
    expect(pruneStaleSidebarFilesVisibility(map, NODE_A, new Set())).toBe(map);
  });

  test('没有要清的键时返回原引用（store 不触发更新）', () => {
    const map = { [`${NODE_A}:d1`]: true };
    expect(pruneStaleSidebarFilesVisibility(map, NODE_A, new Set(['d1']))).toBe(map);
  });
});
