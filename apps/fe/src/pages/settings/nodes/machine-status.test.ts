// 卡头那枚状态徽标的分档，与「更改角色」菜单该给哪些目标。

import { describe, expect, test } from 'bun:test';
import { SELECTABLE_ROLES, machineStatusBadge, roleMenuTargets } from './machine-status';

const BASE = {
  standalone: false,
  relayRole: false,
  roleKnown: true,
  relayMode: false,
  relayAttached: false,
  relayKicked: false,
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

  test('mesh 但本机状态还没回来：只说未知，不拿链路快照猜「未连接」', () => {
    expect(machineStatusBadge({ ...BASE, roleKnown: false })).toEqual({
      state: 'unknown',
      tone: 'muted',
      key: 'nodes.machine.status.unknown',
    });
    expect(
      machineStatusBadge({ ...BASE, roleKnown: false, relayMode: true, relayAttached: true }).state
    ).toBe('unknown');
    expect(machineStatusBadge({ ...BASE, roleKnown: false, standalone: true }).state).toBe(
      'standalone'
    );
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

  test('mesh 节点没挂中继：未接入，复用未连接中继徽标并提示加入中继', () => {
    expect(machineStatusBadge(BASE)).toEqual({
      state: 'relayDisconnected',
      tone: 'warn',
      key: 'nodes.machine.status.unattached',
    });
  });

  test('未连接一律是警示档', () => {
    expect(machineStatusBadge(BASE).tone).toBe('warn');
    expect(machineStatusBadge({ ...BASE, relayMode: true }).tone).toBe('warn');
  });
});

describe('machineStatusBadge：中继角色只看中继链路', () => {
  const RELAY_ROLE = { ...BASE, relayRole: true };

  test('从未接入（mode=none）是灰字，不是红字：刚建好就是这样', () => {
    expect(machineStatusBadge({ ...RELAY_ROLE, relayMode: false })).toEqual({
      state: 'relayDisconnected',
      tone: 'muted',
      key: 'nodes.machine.status.relayDisconnected',
    });
  });

  test('接入过（mode=relay）却没挂上是警示档：这是掉线', () => {
    expect(machineStatusBadge({ ...RELAY_ROLE, relayMode: true })).toEqual({
      state: 'relayDisconnected',
      tone: 'warn',
      key: 'nodes.machine.status.relayDisconnected',
    });
  });

  test('挂上且在线：已连接中继，有延迟就带上延迟', () => {
    expect(
      machineStatusBadge({ ...RELAY_ROLE, relayMode: true, relayAttached: true, rttMs: 8.6 })
    ).toEqual({
      state: 'relayConnected',
      tone: 'ok',
      key: 'nodes.machine.status.relayConnectedRtt',
      params: { ms: 9 },
    });
    expect(machineStatusBadge({ ...RELAY_ROLE, relayMode: true, relayAttached: true }).key).toBe(
      'nodes.machine.status.relayConnected'
    );
  });

  test('令牌失效仍是警示档：那不是「刚建好」，是要人动手', () => {
    const badge = machineStatusBadge({ ...RELAY_ROLE, relayMode: true, relayKicked: true });
    expect(badge.state).toBe('relayKicked');
    expect(badge.tone).toBe('warn');
  });

  test('普通节点走中继时没挂上仍是警示档', () => {
    expect(machineStatusBadge({ ...BASE, relayMode: true }).tone).toBe('warn');
  });

  test('角色未知压过一切：不拿中继角色猜', () => {
    expect(machineStatusBadge({ ...RELAY_ROLE, roleKnown: false }).state).toBe('unknown');
  });
});

describe('roleMenuTargets', () => {
  test('四个角色是后端认的那四个', () => {
    expect(SELECTABLE_ROLES).toEqual(['standalone', 'node', 'relay', 'relay,node']);
  });

  test('当前角色不再列出，standalone 交给单独的「离开…」', () => {
    expect(roleMenuTargets('node')).toEqual(['relay', 'relay,node']);
    expect(roleMenuTargets('relay,node')).toEqual(['node', 'relay']);
    expect(roleMenuTargets('standalone')).toEqual(['node', 'relay', 'relay,node']);
  });
});
