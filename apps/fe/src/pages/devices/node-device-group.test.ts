// 设备页「在线未登录」那一档：分组状态怎么定、静默登录失败后补哪一行原因。

import { afterEach, describe, expect, test } from 'bun:test';
import { nodeLoginFailureTextKey } from '@/auth/login-failure-kind';
import { clearSessionKey } from '@/auth/session-key-store';
import { type NodeDeviceGroupEntry, nodeDeviceGroupState } from './node-device-group';

afterEach(() => clearSessionKey());

function entry(over: Partial<NodeDeviceGroupEntry> = {}): NodeDeviceGroupEntry {
  return {
    id: 'n1',
    runtimeNodeId: 'n1',
    name: 'n1',
    online: true,
    loggedIn: false,
    isSelf: false,
    version: null,
    inventory: null,
    ...over,
  };
}

describe('nodeDeviceGroupState', () => {
  test('待同步且打不通才算 pending；链路通的那台读到的是真实设备', () => {
    expect(nodeDeviceGroupState(entry({ pending: true, online: false }))).toBe('pending');
    expect(nodeDeviceGroupState(entry({ pending: true, online: true, loggedIn: true }))).toBe(
      'ready'
    );
  });

  test('离线 / 已登录照旧', () => {
    expect(nodeDeviceGroupState(entry({ online: false }))).toBe('offline');
    expect(nodeDeviceGroupState(entry({ loggedIn: true }))).toBe('ready');
    expect(nodeDeviceGroupState(entry())).toBe('signedOut');
  });

  test('传输层失败单列一档：不说未登录，改说连接不上', () => {
    expect(nodeDeviceGroupState(entry(), 'NODE_UNREACHABLE')).toBe('unreachable');
    expect(nodeDeviceGroupState(entry(), 'NETWORK_ERROR')).toBe('unreachable');
    expect(nodeDeviceGroupState(entry(), 'HTTP_504')).toBe('unreachable');
  });

  test('凭证类失败仍是「未登录」：用户登一次就能进去', () => {
    expect(nodeDeviceGroupState(entry(), 'NO_SESSION_KEY')).toBe('signedOut');
    expect(nodeDeviceGroupState(entry(), 'PASSKEY_REQUIRED')).toBe('signedOut');
  });

  test('离线优先于失败码：节点压根不在线时不必谈登录', () => {
    expect(nodeDeviceGroupState(entry({ online: false }), 'NODE_UNREACHABLE')).toBe('offline');
  });
});

describe('nodeLoginFailureTextKey', () => {
  test('还没失败过：不多给一行', () => {
    expect(nodeLoginFailureTextKey(null)).toBeNull();
  });

  test('网络类失败说「连接不上」，绝不说「登录失败」', () => {
    expect(nodeLoginFailureTextKey('NETWORK_ERROR')).toBe('auth.node.unreachable');
    expect(nodeLoginFailureTextKey('NODE_LIST_FAILED')).toBe('auth.node.unreachable');
    expect(nodeLoginFailureTextKey('NODE_UNREACHABLE')).toBe('auth.node.unreachable');
  });

  test('凭证 / 授权类失败必须说清楚原因', () => {
    expect(nodeLoginFailureTextKey('NO_SESSION_KEY')).toBe('auth.errors.NO_SESSION_KEY');
    expect(nodeLoginFailureTextKey('TOTP_REQUIRED')).toBe('auth.errors.TOTP_REQUIRED');
    expect(nodeLoginFailureTextKey('DELEGATION_EXPIRED')).toBe('auth.errors.DELEGATION_EXPIRED');
    expect(nodeLoginFailureTextKey('NODE_PK_MISMATCH')).toBe('auth.errors.NODE_PK_MISMATCH');
  });

  test('认不出的码落到通用文案，绝不把原始码显示出来', () => {
    expect(nodeLoginFailureTextKey('SOMETHING_NEW')).toBe('auth.errors.LOGIN_FAILED');
  });

  test('没有会话时按密码路径取文案：凭证类失败一律是同一句中性文案', () => {
    expect(nodeLoginFailureTextKey('BAD_SIGNATURE')).toBe('auth.errors.invalidCredentials');
  });
});
