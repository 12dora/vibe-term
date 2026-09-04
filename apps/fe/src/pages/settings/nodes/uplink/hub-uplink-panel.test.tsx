// 「接入 Hub」面板的两块纯逻辑与合并后的 Hub 列表：挂载解析、列表次序、chip 诊断、上级提示分档。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与本目录其余测试同一套做法）。

import { describe, expect, test } from 'bun:test';
import type { MeshHubsState } from '@/node/mesh-hubs';
import type { MeshHubEndpoint } from '@tmex/api-client/auth/index';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MachineHubList,
  hubFailureNotice,
  orderHubs,
  resolveAttachedHub,
} from './hub-uplink-panel';

function hub(overrides: Partial<MeshHubEndpoint> & { nodeId: string }): MeshHubEndpoint {
  return {
    publicUrl: `https://${overrides.nodeId}.example`,
    name: overrides.nodeId,
    mode: 'active',
    priority: 0,
    writerEpoch: 1,
    online: true,
    ...overrides,
  };
}

function hubsState(overrides: Partial<MeshHubsState> = {}): MeshHubsState {
  return {
    hubs: [],
    attached: null,
    writerHubId: null,
    candidates: [],
    loading: false,
    error: null,
    loadedAt: 1,
    ...overrides,
  } as MeshHubsState;
}

function chipTag(html: string, nodeId: string): string {
  const at = html.indexOf(`data-testid="local-machine-hub-item-${nodeId}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

describe('hubFailureNotice', () => {
  test('hub 拒登与 hub 打不通是两条不同的提示', () => {
    expect(hubFailureNotice({ kind: 'auth', code: 'PASSKEY_REQUIRED', message: 'denied' })).toEqual(
      {
        testId: 'nodes-hub-login-rejected',
        key: 'nodes.hubLoginRejected',
        params: { code: 'PASSKEY_REQUIRED' },
      }
    );
    expect(hubFailureNotice(null).testId).toBe('nodes-hub-offline');
    expect(hubFailureNotice({ kind: 'unreachable', code: null, message: 'boom' }).testId).toBe(
      'nodes-hub-offline'
    );
  });
});

describe('当前挂载的 Hub', () => {
  test('集合里有挂载的那一行时取它，本机自己另作标记', () => {
    const row = hub({ nodeId: 'h1' });
    const snapshot = hubsState({
      hubs: [row],
      attached: {
        hubNodeId: 'h1',
        publicUrl: row.publicUrl,
        mode: 'active',
        writerEpoch: 1,
        since: 1,
      },
    });
    expect(resolveAttachedHub(snapshot, 'h9')).toEqual({ kind: 'hub', hub: row, isSelf: false });
    expect(resolveAttachedHub(snapshot, 'h1')).toEqual({ kind: 'hub', hub: row, isSelf: true });
  });

  test('集合里查不到时退回挂载信息自带的地址，连地址都没有才算未连接', () => {
    const withUrl = hubsState({
      hubs: [hub({ nodeId: 'h1' })],
      attached: {
        hubNodeId: 'h9',
        publicUrl: 'https://new.example',
        mode: 'active',
        writerEpoch: 1,
        since: 1,
      },
    });
    expect(resolveAttachedHub(withUrl, null)).toEqual({ kind: 'url', url: 'https://new.example' });
    const blank = hubsState({
      attached: { hubNodeId: 'h9', publicUrl: '', mode: 'active', writerEpoch: 1, since: 1 },
    });
    expect(resolveAttachedHub(blank, null)).toEqual({ kind: 'none' });
  });

  test('没有 uplink 的 hub 兼节点挂在自己身上', () => {
    const self = hub({ nodeId: 'me' });
    expect(resolveAttachedHub(hubsState({ hubs: [self] }), 'me')).toEqual({
      kind: 'hub',
      hub: self,
      isSelf: true,
    });
    expect(resolveAttachedHub(hubsState({ hubs: [self] }), 'other')).toEqual({ kind: 'none' });
  });
});

describe('orderHubs', () => {
  test('writer 打头，其余按优先级', () => {
    const rows = [
      hub({ nodeId: 'h1', priority: 5 }),
      hub({ nodeId: 'h2', priority: -1 }),
      hub({ nodeId: 'h3', priority: 0 }),
    ];
    expect(orderHubs(rows, 'h1').map((row) => row.nodeId)).toEqual(['h1', 'h2', 'h3']);
  });
});

describe('合并后的 Hub 列表', () => {
  const hubs = [hub({ nodeId: 'h1' }), hub({ nodeId: 'h2', mode: 'standby' })];

  test('一枚 chip 同时带出挂载 / writer / 在线态，写入归属只进悬浮详情', () => {
    const html = renderToStaticMarkup(
      <MachineHubList hubs={hubs} attachedHubId="h2" writerHubId="h1" />
    );
    expect(html).toContain('data-testid="local-machine-hub-list"');
    expect(chipTag(html, 'h1')).toContain('data-hub-writer="true"');
    expect(chipTag(html, 'h1')).toContain('data-hub-attached="false"');
    expect(chipTag(html, 'h1')).toContain('nodes.hubs.writer');
    expect(chipTag(html, 'h2')).toContain('data-hub-attached="true"');
    expect(chipTag(html, 'h2')).toContain('data-hub-mode="standby"');
  });

  test('连不上的那台带警告图标，别的不带', () => {
    const html = renderToStaticMarkup(
      <MachineHubList
        hubs={hubs}
        attachedHubId="h1"
        writerHubId="h1"
        candidates={[
          { publicUrl: 'https://h2.example/', lastError: 'ECONNREFUSED', lastAttemptAt: 2 },
        ]}
      />
    );
    expect(html).toContain('data-testid="local-machine-hub-warning-h2"');
    expect(html).not.toContain('data-testid="local-machine-hub-warning-h1"');
    expect(chipTag(html, 'h2')).toContain('data-hub-failing="true"');
    expect(chipTag(html, 'h2')).toContain('nodes.hubs.lastError');
    expect(chipTag(html, 'h1')).toContain('data-hub-failing="false"');
  });

  test('旧后端不下发 candidates：不出现任何警告', () => {
    const html = renderToStaticMarkup(
      <MachineHubList hubs={hubs} attachedHubId="h1" writerHubId="h1" />
    );
    expect(html).not.toContain('local-machine-hub-warning');
    expect(chipTag(html, 'h1')).toContain('data-hub-failing="false"');
  });

  test('离线那台带离线标记', () => {
    const html = renderToStaticMarkup(
      <MachineHubList
        hubs={[hubs[0] as MeshHubEndpoint, hub({ nodeId: 'h2', online: false })]}
        attachedHubId="h1"
        writerHubId="h1"
      />
    );
    expect(html).toContain('data-testid="local-machine-hub-offline-h2"');
    expect(html).not.toContain('data-testid="local-machine-hub-offline-h1"');
    expect(chipTag(html, 'h2')).toContain('data-hub-online="false"');
  });
});
