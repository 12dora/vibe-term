// 卡片 ⋯ 菜单「连接」那一组：形态决定给哪些动作，动作决定打到哪条中继。

import { describe, expect, test } from 'bun:test';
import type { LocalRole } from '@vibeterm/api-client/local/types';
import type { RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';
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
    uplinkMode: 'hub',
    unsupported: false,
    relays: [],
    changeHubDisabled: false,
    ...overrides,
  };
}

function run(overrides: Partial<ConnectMenuState> = {}) {
  const calls: string[] = [];
  const items = connectMenuItems(t, state(overrides), {
    changeHub: () => calls.push('change-hub'),
    migrateToRelay: () => calls.push('migrate'),
    addRelay: () => calls.push('add'),
    reauthRelay: (url) => calls.push(`reauth:${url}`),
    removeRelay: (url) => calls.push(`remove:${url}`),
    leaveRelay: () => calls.push('leave'),
  });
  return { items, calls, ids: items.map((item) => item.testId) };
}

describe('Hub 形态', () => {
  test('纯节点：换 Hub + 改为接入中继', () => {
    const { ids } = run();
    expect(ids).toEqual(['local-machine-change-hub', 'nodes-relay-enroll']);
  });

  test('Hub 兼节点没有「换 Hub」：它的上级就是自己', () => {
    expect(run({ role: 'hub,node' }).ids).toEqual(['nodes-relay-enroll']);
  });

  test('退出 / 设置在途时「换 Hub」禁用，但仍然摆出来', () => {
    const { items } = run({ changeHubDisabled: true });
    expect(items[0]?.disabled).toBe(true);
  });

  test('压根没有上级时不给「改为接入中继」：入口是连接段里的主按钮', () => {
    expect(run({ uplinkMode: 'none' }).ids).toEqual(['local-machine-change-hub']);
  });

  test('旧节点没有这族路由：一个中继动作都不给', () => {
    expect(run({ unsupported: true }).ids).toEqual(['local-machine-change-hub']);
  });

  // 后端在中继角色尚未接入时把 `mode` 报成 `hub`，照 hub 那一档给菜单会把用户引去接别人的中继。
  test('中继角色即便被报成 hub 形态，也不给「改为接入中继」', () => {
    expect(run({ role: 'relay,node' }).ids).toEqual([]);
    expect(run({ role: 'relay' }).ids).toEqual([]);
  });

  test('点「换 Hub」走对应回调', () => {
    const { items, calls } = run();
    items[0]?.onSelect();
    items[1]?.onSelect();
    expect(calls).toEqual(['change-hub', 'migrate']);
  });
});

describe('中继租户形态', () => {
  const tenant = { relayMode: true, uplinkMode: 'relay', relays: [link()] };

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
});
