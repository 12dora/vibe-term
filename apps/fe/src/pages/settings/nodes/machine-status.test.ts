// 卡头那枚状态徽标的分档，与「更改角色」菜单该给哪些目标。

import { describe, expect, test } from 'bun:test';
import { SELECTABLE_ROLES, machineStatusBadge, roleMenuTargets } from './machine-status';

const BASE = {
  standalone: false,
  relayMode: false,
  relayAttached: false,
  relayKicked: false,
  hubAttached: false,
  hubLoading: false,
  rttMs: null,
};

describe('machineStatusBadge', () => {
  test('standalone 压过一切：连中继链路都不看', () => {
    const badge = machineStatusBadge({ ...BASE, standalone: true, relayMode: true });
    expect(badge).toEqual({
      state: 'standalone',
      tone: 'muted',
      key: 'nodes.machine.status.standalone',
    });
  });

  test('中继模式：挂上了就是已连接，有延迟时换成带延迟的那条', () => {
    expect(machineStatusBadge({ ...BASE, relayMode: true, relayAttached: true })).toEqual({
      state: 'relayConnected',
      tone: 'ok',
      key: 'nodes.machine.status.relayConnected',
    });
    expect(
      machineStatusBadge({ ...BASE, relayMode: true, relayAttached: true, rttMs: 45.4 })
    ).toEqual({
      state: 'relayConnected',
      tone: 'ok',
      key: 'nodes.machine.status.relayConnectedRtt',
      params: { ms: 45 },
    });
  });

  test('中继模式：令牌失效压过「没挂上」', () => {
    expect(
      machineStatusBadge({ ...BASE, relayMode: true, relayKicked: true, relayAttached: true }).state
    ).toBe('relayKicked');
    expect(machineStatusBadge({ ...BASE, relayMode: true }).state).toBe('relayDisconnected');
  });

  test('Hub 模式：挂上 / 还在探 / 探过连不上三档分明', () => {
    expect(machineStatusBadge({ ...BASE, hubAttached: true, rttMs: 12 })).toEqual({
      state: 'hubConnected',
      tone: 'ok',
      key: 'nodes.machine.status.hubConnectedRtt',
      params: { ms: 12 },
    });
    expect(machineStatusBadge({ ...BASE, hubLoading: true }).state).toBe('connecting');
    expect(machineStatusBadge(BASE).state).toBe('hubDisconnected');
  });

  test('未连接一律是警示档，连接中只是灰字', () => {
    expect(machineStatusBadge(BASE).tone).toBe('warn');
    expect(machineStatusBadge({ ...BASE, relayMode: true }).tone).toBe('warn');
    expect(machineStatusBadge({ ...BASE, hubLoading: true }).tone).toBe('muted');
  });
});

describe('roleMenuTargets', () => {
  test('五个角色仍是后端认的那五个', () => {
    expect(SELECTABLE_ROLES).toEqual(['standalone', 'node', 'hub,node', 'relay,node', 'relay']);
  });

  test('当前角色不再列出，standalone 交给单独的「离开…」', () => {
    expect(roleMenuTargets('node')).toEqual(['hub,node', 'relay,node', 'relay']);
    expect(roleMenuTargets('hub,node')).toEqual(['node', 'relay,node', 'relay']);
    expect(roleMenuTargets('relay,node')).toEqual(['node', 'hub,node', 'relay']);
    expect(roleMenuTargets('standalone')).toEqual(['node', 'hub,node', 'relay,node', 'relay']);
  });
});
