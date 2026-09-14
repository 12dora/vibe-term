// 「连接详情」的内容。Base UI 的 Collapsible 收起时压根不挂载面板，
// 静态渲染看不到：直接渲染导出的内容组件。

import { describe, expect, test } from 'bun:test';
import type { UseMeshRelayResult } from '@/node/mesh-relay';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionDetailsContent } from './connection-details';

const NO_RELAY = {
  mode: 'none',
  relayMode: false,
  quota: null,
  tenantId: null,
  relays: [],
  ordered: [],
  attached: null,
  metaEpoch: 0,
  nodesViaRelay: 0,
  reauthRequired: false,
  readmitPending: 0,
  metaKeyLagging: [],
  preferredUrl: null,
  autoSelect: { enabled: false, lastSwitchAt: null, switchReason: null, nextEvalAt: null },
  writable: true,
  kicked: false,
  loading: false,
  error: null,
  loadedAt: 1,
  unsupported: false,
  refresh: () => undefined,
  switchRelay: () => Promise.resolve(),
} satisfies UseMeshRelayResult;

const RELAY_MODE = {
  ...NO_RELAY,
  mode: 'relay',
  relayMode: true,
  tenantId: 'aabbccddeeff00112233445566778899',
  metaEpoch: 3,
  nodesViaRelay: 4,
  quota: { maxNodes: 8, maxStreams: 16, bandwidthBytesPerSec: null, currentNodes: 5 },
} satisfies UseMeshRelayResult;

/** 带宽不限但有实时用量：不能套「{{used}} / {{total}}」，否则出两道斜杠。 */
const RELAY_UNLIMITED_BANDWIDTH = {
  ...RELAY_MODE,
  quota: {
    maxNodes: 8,
    maxStreams: 16,
    bandwidthBytesPerSec: null,
    currentNodes: 5,
    usage: {
      currentNodes: 6,
      currentStreams: 4,
      bytesInPerSec: 2048,
      bytesOutPerSec: 4096,
      sampledAt: 1,
    },
  },
} satisfies UseMeshRelayResult;

/** 新中继：实时用量与带宽上限都下发。 */
const RELAY_WITH_USAGE = {
  ...RELAY_MODE,
  quota: {
    maxNodes: 8,
    maxStreams: 16,
    bandwidthBytesPerSec: 1024 * 1024,
    currentNodes: 5,
    usage: {
      currentNodes: 6,
      currentStreams: 4,
      bytesInPerSec: 2048,
      bytesOutPerSec: 4096,
      sampledAt: 1,
    },
  },
} satisfies UseMeshRelayResult;

function render(
  relay: UseMeshRelayResult = NO_RELAY,
  selfNodeId: string | null = 'node-1'
): string {
  return renderToStaticMarkup(<ConnectionDetailsContent relay={relay} selfNodeId={selfNodeId} />);
}

describe('连接详情', () => {
  test('本机编号永远可复制', () => {
    const html = render();
    expect(html).toContain('data-testid="local-machine-node-id"');
    expect(html).toContain('data-testid="local-machine-node-id-copy"');
    expect(html).toContain('node-1');
  });

  test('中继模式：租户编号、本机编号、可访问节点与三档配额一次摆齐', () => {
    const html = render(RELAY_MODE);
    expect(html).toContain('data-testid="nodes-relay-tenant-id"');
    expect(html).toContain('relay.tenant.strip.tenantIdHint');
    expect(html).toContain('data-testid="local-machine-node-id"');
    expect(html).toContain('data-testid="nodes-relay-peers"');
    expect(html).toContain('data-testid="nodes-relay-quota"');
    expect(html).toContain('data-testid="nodes-relay-streams"');
    expect(html).toContain('data-testid="nodes-relay-bandwidth"');
  });

  test('本机编号紧跟租户编号，排在可访问节点之前', () => {
    const html = render(RELAY_MODE);
    const tenant = html.indexOf('data-testid="nodes-relay-tenant-id"');
    const node = html.indexOf('data-testid="local-machine-node-id"');
    const peers = html.indexOf('data-testid="nodes-relay-peers"');
    expect(tenant).toBeLessThan(node);
    expect(node).toBeLessThan(peers);
  });

  test('引擎内部游标（元数据代数、密钥日志）一格都不再摆', () => {
    const html = render({
      ...RELAY_MODE,
      keyLog: { skipped: 2, blockedSeq: '42', caughtUp: false },
    });
    expect(html).not.toContain('data-testid="nodes-relay-meta"');
    expect(html).not.toContain('data-testid="nodes-relay-key-log"');
  });

  test('有实时用量时三档都给 used / max，有上限的那两档带进度条', () => {
    const html = render(RELAY_WITH_USAGE);
    expect(html).toContain('nodes.machine.details.quotaValue');
    expect(html).toContain('data-testid="nodes-relay-quota-bar"');
    expect(html).toContain('data-testid="nodes-relay-streams-bar"');
    expect(html).toContain('data-testid="nodes-relay-bandwidth-bar"');
  });

  test('带宽不限又有用量：走「不限」那条合并文案，不套 used / total', () => {
    const html = render(RELAY_UNLIMITED_BANDWIDTH);
    expect(html).toContain('nodes.machine.details.quotaUnlimitedValue');
    expect(html).not.toContain('data-testid="nodes-relay-bandwidth-bar"');
    const bandwidth = html.slice(html.indexOf('data-testid="nodes-relay-bandwidth"'));
    expect(bandwidth).not.toContain('nodes.machine.details.quotaValue');
  });

  test('旧中继不下发用量：并发流与带宽只剩上限，不摆进度条', () => {
    const html = render(RELAY_MODE);
    expect(html).not.toContain('data-testid="nodes-relay-streams-bar"');
    expect(html).not.toContain('data-testid="nodes-relay-bandwidth-bar"');
    // `currentNodes` 是配额本身给的，节点那一档照旧有进度条
    expect(html).toContain('data-testid="nodes-relay-quota-bar"');
  });

  test('旧中继不下发配额：三档整格不出现', () => {
    const html = render({ ...RELAY_MODE, quota: null });
    expect(html).not.toContain('data-testid="nodes-relay-quota"');
    expect(html).not.toContain('data-testid="nodes-relay-streams"');
    expect(html).not.toContain('data-testid="nodes-relay-bandwidth"');
    expect(html).toContain('data-testid="nodes-relay-peers"');
  });

  test('非中继模式：中继那几格一个都不出', () => {
    const html = render();
    expect(html).not.toContain('data-testid="nodes-relay-tenant-id"');
    expect(html).not.toContain('data-testid="nodes-relay-peers"');
  });

  test('不再渲染 Hub 明细', () => {
    expect(render()).not.toContain('data-testid="local-machine-hub-details"');
    expect(render()).not.toContain('nodes.hubs.priority');
  });
});
