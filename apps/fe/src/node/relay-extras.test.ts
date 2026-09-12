// 多中继新增字段的读侧归一化：身份、在线对端数、TURN、`viaRelay` / `relayPresence` 与主机名。

import { describe, expect, test } from 'bun:test';
import type { RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';
import {
  isPrimaryRelay,
  relayHostLabel,
  relayHostList,
  relayPeersOnlineOf,
  relayPresenceOf,
  relayRoleOf,
  relayTurnOf,
  viaRelayOf,
} from './relay-extras';

function row(overrides: Partial<RelayLinkStatus> = {}): RelayLinkStatus {
  const base: RelayLinkStatus = {
    url: 'https://sh.example.com:8443',
    priority: 1,
    online: true,
    attached: false,
  };
  return { ...base, ...overrides };
}

describe('relayRoleOf', () => {
  test('网关下发 role 时直接用', () => {
    expect(relayRoleOf(row({ role: 'primary' }))).toBe('primary');
    expect(relayRoleOf(row({ role: 'secondary' }))).toBe('secondary');
    expect(relayRoleOf(row({ role: null }))).toBeNull();
  });

  test('旧网关只有 attached / online 时按老语义折算', () => {
    expect(relayRoleOf(row({ attached: true }))).toBe('primary');
    expect(relayRoleOf(row({ attached: false }))).toBe('secondary');
    expect(relayRoleOf(row({ online: false, attached: false }))).toBeNull();
  });

  test('role 为 null 但链路还连着：以网关的判定为准，不再拿 attached 猜', () => {
    expect(relayRoleOf(row({ role: null, online: true, attached: true }))).toBeNull();
    expect(isPrimaryRelay(row({ role: 'primary' }))).toBe(true);
    expect(isPrimaryRelay(row({ role: 'secondary' }))).toBe(false);
  });
});

describe('relayPeersOnlineOf', () => {
  test('只认非负整数，其余一律当未知', () => {
    expect(relayPeersOnlineOf(row({ peersOnline: 0 }))).toBe(0);
    expect(relayPeersOnlineOf(row({ peersOnline: 3.7 }))).toBe(3);
    expect(relayPeersOnlineOf(row({ peersOnline: null }))).toBeNull();
    expect(relayPeersOnlineOf(row())).toBeNull();
    expect(relayPeersOnlineOf(row({ peersOnline: -1 }))).toBeNull();
    expect(relayPeersOnlineOf(row({ peersOnline: Number.NaN }))).toBeNull();
  });
});

describe('relayTurnOf', () => {
  test('地址为空一律当作没有 TURN', () => {
    expect(relayTurnOf(row())).toBeNull();
    expect(relayTurnOf(row({ turn: null }))).toBeNull();
    expect(relayTurnOf(row({ turn: { url: '', probeOk: true } }))).toBeNull();
  });

  test('探测结论只认布尔，缺席为「还没探」', () => {
    expect(relayTurnOf(row({ turn: { url: 'turn:a:3478', probeOk: true } }))).toEqual({
      url: 'turn:a:3478',
      probeOk: true,
    });
    expect(relayTurnOf(row({ turn: { url: 'turn:a:3478', probeOk: null } }))).toEqual({
      url: 'turn:a:3478',
      probeOk: null,
    });
  });
});

describe('viaRelay / relayPresence 的归一化', () => {
  test('空串、非字符串一律当没有', () => {
    expect(viaRelayOf('https://a.example')).toBe('https://a.example');
    expect(viaRelayOf('')).toBeNull();
    expect(viaRelayOf(null)).toBeNull();
    expect(viaRelayOf(42)).toBeNull();
  });

  test('名册只留非空字符串，非数组为空', () => {
    expect(relayPresenceOf(['a', '', 1, null, 'b'])).toEqual(['a', 'b']);
    expect(relayPresenceOf('a')).toEqual([]);
    expect(relayPresenceOf(undefined)).toEqual([]);
  });
});

describe('中继主机名', () => {
  test('只取主机名：协议与端口都不上屏', () => {
    expect(relayHostLabel('https://tokyo.example.com:8443/')).toBe('tokyo.example.com');
    expect(relayHostLabel('not a url')).toBe('not a url');
  });

  test('多条按顿号拼接', () => {
    expect(relayHostList(['https://a.example:1', 'https://b.example'])).toBe(
      'a.example、b.example'
    );
    expect(relayHostList([])).toBe('');
  });
});
