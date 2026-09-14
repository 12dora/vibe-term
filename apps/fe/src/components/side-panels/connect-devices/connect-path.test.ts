// 默认接入路径与二级默认选择：只看本机现状，不掺任何 UI 状态。

import { describe, expect, test } from 'bun:test';
import {
  type ConnectStatus,
  defaultConnectPath,
  defaultConnectSide,
  isRelayRole,
} from './connect-path';

const TENANT = 'aabbccddeeff00112233445566778899';

function status(over: Partial<ConnectStatus> = {}): ConnectStatus {
  return {
    role: null,
    relayAttached: false,
    relayMode: false,
    tenantId: null,
    meshEnabled: false,
    ...over,
  };
}

describe('角色判定', () => {
  test('带 relay 的两种角色都算中继', () => {
    expect(isRelayRole('relay')).toBe(true);
    expect(isRelayRole('relay,node')).toBe(true);
    expect(isRelayRole('node')).toBe(false);
    expect(isRelayRole(null)).toBe(false);
  });
});

describe('defaultConnectPath', () => {
  test('本机是中继或走中继：默认经中继', () => {
    expect(defaultConnectPath(status({ role: 'relay,node' }))).toBe('relay');
    expect(defaultConnectPath(status({ role: 'relay' }))).toBe('relay');
    expect(defaultConnectPath(status({ relayMode: true, meshEnabled: true }))).toBe('relay');
  });

  test('mesh 成员（含尚未挂上中继）默认经中继', () => {
    expect(defaultConnectPath(status({ role: 'node', meshEnabled: true }))).toBe('relay');
    expect(defaultConnectPath(status({ meshEnabled: true }))).toBe('relay');
  });

  test('未组网：默认经中继', () => {
    expect(defaultConnectPath(status())).toBe('relay');
    expect(defaultConnectPath(status({ role: 'standalone' }))).toBe('relay');
  });
});

describe('defaultConnectSide', () => {
  test('中继：本机已作为租户接入就先给加入，否则先教自建', () => {
    expect(
      defaultConnectSide(
        'relay',
        status({ relayAttached: true, relayMode: true, tenantId: TENANT })
      )
    ).toBe('join');
    expect(defaultConnectSide('relay', status())).toBe('host');
  });

  test('中继：链路一时断开不改判，租户模式仍算已有中继', () => {
    expect(
      defaultConnectSide(
        'relay',
        status({ relayMode: true, tenantId: TENANT, relayAttached: false })
      )
    ).toBe('join');
  });

  test('中继：服务角色建好但本机还没接进去，仍从自建教起', () => {
    expect(defaultConnectSide('relay', status({ role: 'relay,node' }))).toBe('host');
    expect(defaultConnectSide('relay', status({ role: 'relay', relayAttached: true }))).toBe(
      'host'
    );
    // 模式对上但租户编号还没下来：命令仍拼不出来，不能先给加入。
    expect(defaultConnectSide('relay', status({ relayMode: true }))).toBe('host');
  });

  test('SSH 没有二级选择', () => {
    expect(defaultConnectSide('ssh', status())).toBe('join');
  });
});
