// 分节的「首屏」形态：`/api/devices` 还没落地时分节仍然渲染（节点头 + 占位设备行 / 骨架），
// 以及自动登录的「每个 node 每次页面加载只发一次」记账。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 sidebar-device-list.test.tsx 同一套做法）。

import { describe, expect, test } from 'bun:test';
import type { SidebarDeviceStatsResult } from '@tmex/panels/device-tree';
import type { Device } from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { PendingDeviceRows, isNodeSectionVisible, pendingRows } = await import(
  './sidebar-device-list-runtime'
);
const { claimEagerSignIn, resetEagerSignInForTest } = await import('./sidebar-node-section');

function stats(overrides: Partial<SidebarDeviceStatsResult> = {}): SidebarDeviceStatsResult {
  return {
    total: 0,
    visible: 0,
    pending: false,
    failed: false,
    visibleIds: [],
    devices: [],
    ...overrides,
  } as SidebarDeviceStatsResult;
}

function device(id: string, name: string): Device {
  return {
    id,
    name,
    type: 'local',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  };
}

describe('isNodeSectionVisible', () => {
  test('pending 期间一律渲染：那一刻的零设备不是事实', () => {
    expect(isNodeSectionVisible(stats({ pending: true }), false)).toBe(true);
    expect(isNodeSectionVisible(stats({ pending: true, total: 3 }), false)).toBe(true);
  });

  test('落地后仍按可见设备数隐藏（本机留空态）', () => {
    expect(isNodeSectionVisible(stats(), false)).toBe(false);
    expect(isNodeSectionVisible(stats(), true)).toBe(true);
    expect(isNodeSectionVisible(stats({ total: 3 }), true)).toBe(false);
    expect(isNodeSectionVisible(stats({ total: 3, visible: 1, visibleIds: ['a'] }), false)).toBe(
      true
    );
  });

  test('请求失败时不按零设备隐藏，把重试 UI 留给设备树', () => {
    expect(isNodeSectionVisible(stats({ failed: true }), false)).toBe(true);
  });
});

describe('pendingRows', () => {
  test('只留侧边栏会显示的那几台，顺序沿用列表本身', () => {
    const list = [device('a', 'A'), device('b', 'B'), device('c', 'C')];
    expect(pendingRows({ devices: list, visibleIds: ['c', 'a'] }).map((row) => row.id)).toEqual([
      'a',
      'c',
    ]);
    expect(pendingRows({ devices: list, visibleIds: [] })).toEqual([]);
  });
});

describe('PendingDeviceRows', () => {
  test('有快照就灰显上次的设备名（不做链接）', () => {
    const html = renderToStaticMarkup(
      <PendingDeviceRows nodeId="n1" devices={[device('a', '书房'), device('b', '客厅')]} />
    );
    expect(html).toContain('sidebar-node-placeholder-n1');
    expect(html).toContain('书房');
    expect(html).toContain('客厅');
    expect(html).not.toContain('<a ');
  });

  test('一台都不知道时给骨架，而不是「没有设备」', () => {
    const html = renderToStaticMarkup(<PendingDeviceRows nodeId="n1" devices={[]} />);
    expect(html).toContain('sidebar-node-skeleton-n1');
    expect(html).toContain('animate-pulse');
  });
});

describe('claimEagerSignIn', () => {
  test('同一个 node 每次页面加载只放行一次（连续 401 不会变成登录循环）', () => {
    resetEagerSignInForTest();
    expect(claimEagerSignIn('n1')).toBe(true);
    expect(claimEagerSignIn('n1')).toBe(false);
    expect(claimEagerSignIn('n2')).toBe(true);
    resetEagerSignInForTest();
    expect(claimEagerSignIn('n1')).toBe(true);
    resetEagerSignInForTest();
  });
});
