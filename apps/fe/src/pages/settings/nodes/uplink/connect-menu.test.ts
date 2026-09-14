// 卡片 ⋯ 菜单「连接」那一组：形态决定给哪些动作，动作决定打到哪条中继。

import { describe, expect, test } from 'bun:test';
import type { LocalRole } from '@vibeterm/api-client/local/types';
import type { RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';
import { RELAY_RECORD_MAX_RELAYS } from '@vibeterm/shared/auth';
import { type ConnectMenuState, connectMenuItems } from './connect-menu';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${JSON.stringify(options)})` : key;

function link(overrides: Partial<RelayLinkStatus> = {}): RelayLinkStatus {
  return {
    url: 'https://relay.example.com',
    priority: 1,
    online: true,
    attached: true,
    rttMs: null,
    lastError: null,
    lastErrorCode: null,
    kicked: false,
    ...overrides,
  };
}

function state(overrides: Partial<ConnectMenuState> = {}): ConnectMenuState {
  return {
    role: 'node' as LocalRole,
    relayMode: false,
    unsupported: false,
    relays: [],
    ...overrides,
  };
}

function run(overrides: Partial<ConnectMenuState> = {}) {
  const calls: string[] = [];
  const items = connectMenuItems(t, state(overrides), {
    addRelay: () => calls.push('add'),
    notifyRelayLimit: () => calls.push('add-max'),
    reauthRelay: (url) => calls.push(`reauth:${url}`),
    removeRelay: (url) => calls.push(`remove:${url}`),
    leaveRelay: () => calls.push('leave'),
  });
  return { items, calls, ids: items.map((item) => item.testId) };
}

describe('未接入中继', () => {
  test('纯节点还没挂中继：连接菜单为空，CTA 在卡面上', () => {
    expect(run().ids).toEqual([]);
  });

  test('中继角色还没接入：同样不给菜单项', () => {
    expect(run({ role: 'relay,node' }).ids).toEqual([]);
    expect(run({ role: 'relay' }).ids).toEqual([]);
  });
});

describe('中继租户形态', () => {
  const tenant = { relayMode: true, relays: [link()] };

  test('追加 → 重新输入接入密码 → 离开，离开是危险档', () => {
    const { items, ids } = run(tenant);
    expect(ids).toEqual(['nodes-relay-add', 'nodes-relay-reauth-menu', 'nodes-relay-leave']);
    expect(items.at(-1)?.destructive).toBe(true);
    expect(items[0]?.destructive).toBeUndefined();
  });

  test('多条中继：逐条给出「移除 {host}」，动作带上各自的地址', () => {
    const relays = [link(), link({ url: 'https://b.example', attached: false, priority: 2 })];
    const { items, ids, calls } = run({ ...tenant, relays });
    expect(ids).toEqual([
      'nodes-relay-add',
      'nodes-relay-reauth-menu',
      'nodes-relay-remove-relay.example.com',
      'nodes-relay-remove-b.example',
      'nodes-relay-leave',
    ]);
    items[3]?.onSelect();
    expect(calls).toEqual(['remove:https://b.example']);
  });

  test('被踢的那条才是重新输入接入密码的目标', () => {
    const relays = [
      link({ attached: false }),
      link({ url: 'https://b.example', kicked: true, priority: 2 }),
    ];
    const { items, calls } = run({ ...tenant, relays });
    items[1]?.onSelect();
    expect(calls).toEqual(['reauth:https://b.example']);
  });

  test('旧节点没有这族路由：整组不出，免得摆一排点了必报错的项', () => {
    expect(run({ ...tenant, unsupported: true }).ids).toEqual([]);
  });

  test('满 16 条时「追加中继」仍可点，点了只说明原因；15 条照常开对话框', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => link({ url: `https://r${i}.example`, priority: i }));
    const atMax = run({ ...tenant, relays: many(RELAY_RECORD_MAX_RELAYS) });
    const full = atMax.items[0];
    expect(full?.testId).toBe('nodes-relay-add');
    expect(full?.disabled).toBeUndefined();
    expect(full?.reason).toBe(`relay.tenant.actions.addMax({"n":${RELAY_RECORD_MAX_RELAYS}})`);
    full?.onSelect();
    expect(atMax.calls).toEqual(['add-max']);
    const hasRoom = run({ ...tenant, relays: many(RELAY_RECORD_MAX_RELAYS - 1) });
    const room = hasRoom.items[0];
    expect(room?.disabled).toBeUndefined();
    expect(room?.reason).toBeUndefined();
    room?.onSelect();
    expect(hasRoom.calls).toEqual(['add']);
  });
});
