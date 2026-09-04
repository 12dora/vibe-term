// 中继链路 store：状态映射、404 退化、纯判定函数。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RelayApiError } from '@tmex/api-client/relay/admin-api';
import type { RelayTenantApi, RelayTenantStatus } from '@tmex/api-client/relay/tenant-api';
import {
  attachedRelay,
  getMeshRelayState,
  isRelayMode,
  orderedRelays,
  refreshMeshRelay,
  relayKicked,
  relayWritable,
  resetMeshRelayStateForTest,
  setMeshRelayStateForTest,
} from './mesh-relay';

// store 是宿主级单例，同一进程里的其它测试文件也读它：每个用例跑完必须归零。
afterEach(() => {
  resetMeshRelayStateForTest();
});

function status(overrides: Partial<RelayTenantStatus> = {}): RelayTenantStatus {
  return {
    mode: 'relay',
    tenantId: 'ab'.repeat(16),
    relays: [],
    metaEpoch: 2,
    nodesViaRelay: 3,
    reauthRequired: false,
    readmitPending: 0,
    quota: null,
    ...overrides,
  };
}

function link(url: string, overrides: Partial<RelayTenantStatus['relays'][number]> = {}) {
  return {
    url,
    priority: 0,
    online: true,
    attached: false,
    rttMs: null,
    lastError: null,
    kicked: false,
    ...overrides,
  };
}

function apiOf(impl: () => Promise<RelayTenantStatus>): RelayTenantApi {
  return { status: impl } as unknown as RelayTenantApi;
}

describe('mesh-relay 纯函数', () => {
  test('attached / ordered / writable / kicked', () => {
    const snapshot = {
      ...getMeshRelayState(),
      ...status({
        relays: [
          link('https://b.example', { priority: 2, attached: true }),
          link('https://a.example', { priority: 1 }),
        ],
      }),
    };
    expect(isRelayMode(snapshot)).toBe(true);
    expect(attachedRelay(snapshot)?.url).toBe('https://b.example');
    expect(orderedRelays(snapshot).map((row) => row.url)).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(relayWritable(snapshot)).toBe(true);
    expect(relayKicked(snapshot)).toBe(false);
  });

  test('一条都没挂上时不可写；非中继模式恒可写', () => {
    const detached = { ...getMeshRelayState(), ...status({ relays: [link('https://a.example')] }) };
    expect(relayWritable(detached)).toBe(false);
    expect(relayWritable({ ...detached, mode: 'hub' })).toBe(true);
  });

  test('任一条被踢即视为要重新输入口令', () => {
    const kicked = {
      ...getMeshRelayState(),
      ...status({ relays: [link('https://a.example', { kicked: true })] }),
    };
    expect(relayKicked(kicked)).toBe(true);
  });
});

describe('refreshMeshRelay', () => {
  beforeEach(() => {
    resetMeshRelayStateForTest();
  });

  test('成功后写入快照并清空错误', async () => {
    await refreshMeshRelay(
      apiOf(() =>
        Promise.resolve(status({ relays: [link('https://a.example', { attached: true })] }))
      )
    );
    const state = getMeshRelayState();
    expect(state.mode).toBe('relay');
    expect(state.relays).toHaveLength(1);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.loadedAt).not.toBeNull();
  });

  test('404 记成 unsupported，不当作加载失败', async () => {
    await refreshMeshRelay(
      apiOf(() => Promise.reject(new RelayApiError('not_found', 'not found', 404)))
    );
    const state = getMeshRelayState();
    expect(state.unsupported).toBe(true);
    expect(state.error).toBeNull();
    expect(state.mode).toBe('none');
  });

  test('其它错误保留上一份链路', async () => {
    setMeshRelayStateForTest(status({ relays: [link('https://a.example')] }));
    await refreshMeshRelay(apiOf(() => Promise.reject(new Error('boom'))));
    const state = getMeshRelayState();
    expect(state.relays).toHaveLength(1);
    expect(state.error).toBe('boom');
  });
});
