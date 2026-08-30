// 设备页链路徽标：取值矩阵（直连优先，其次到达路径，RTT 测不到就不带后缀）与诊断浮层的行。
// 无 DOM 测试环境，渲染用 react-dom/server；未初始化 i18n 时 `t()` 原样返回 key。

import { afterEach, describe, expect, test } from 'bun:test';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';
import type { DirectDiagnostics } from '@tmex/ws-client/direct/types';
import type { NodeLink } from './direct-diagnostics';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('./mesh-nodes');
const {
  DeviceNodeBadges,
  NodeLinkDiagnostics,
  formatLinkBadgeLabel,
  reachLabelKey,
  resolveLinkBadge,
  transportLabelKey,
} = await import('./device-node-badges');

function link(overrides: Partial<NodeLink> = {}): NodeLink {
  return { reach: 'lan', transport: 'ws-secure', rttMs: null, ...overrides };
}

function diagnostics(overrides: Partial<DirectDiagnostics> = {}): DirectDiagnostics {
  return { path: 'primary', route: null, rtt: null, ice: null, ...overrides };
}

/** 徽标最终展示的那串文本（未初始化 i18n 时 key 即译文）。 */
function badgeLabel(input: Parameters<typeof resolveLinkBadge>[0]): string {
  const badge = resolveLinkBadge(input);
  return formatLinkBadgeLabel(badge.labelKey, badge.rttMs);
}

function meshNode(overrides: Partial<MeshNode> & { id: string }): MeshNode {
  return {
    name: overrides.id,
    publicKey: '',
    online: true,
    reach: 'lan',
    version: null,
    direct_capable: false,
    loggedIn: true,
    ...overrides,
  };
}

afterEach(() => {
  resetMeshNodesStateForTest();
});

describe('resolveLinkBadge', () => {
  test('直连活着时以 WebRTC RTT 为准，且压过 entry 侧的到达路径', () => {
    const badge = resolveLinkBadge({
      path: 'direct',
      directRttMs: 8.6,
      link: link({ reach: 'relay', transport: 'relay', rttMs: 180 }),
    });
    expect(badge).toEqual({ labelKey: 'nodes.badge.direct', rttMs: 8.6, tone: 'ok' });
    expect(formatLinkBadgeLabel(badge.labelKey, badge.rttMs)).toBe('nodes.badge.direct · 9ms');
  });

  test('到达路径矩阵：标签、色调与延迟后缀', () => {
    expect(
      resolveLinkBadge({ path: 'primary', directRttMs: null, link: link({ rttMs: 12 }) })
    ).toEqual({ labelKey: 'nodes.reach.lan', rttMs: 12, tone: 'ok' });
    expect(
      resolveLinkBadge({
        path: 'primary',
        directRttMs: null,
        link: link({ reach: 'wan', rttMs: 37.2 }),
      })
    ).toEqual({ labelKey: 'nodes.reach.wan', rttMs: 37.2, tone: 'ok' });
    expect(
      resolveLinkBadge({
        path: 'primary',
        directRttMs: null,
        link: link({ reach: 'relay', transport: 'relay', rttMs: 210 }),
      })
    ).toEqual({ labelKey: 'nodes.reach.relay', rttMs: 210, tone: 'muted' });
    expect(
      resolveLinkBadge({
        path: 'primary',
        directRttMs: null,
        link: link({ reach: null, transport: null }),
      })
    ).toEqual({ labelKey: 'nodes.reach.none', rttMs: null, tone: 'muted' });
  });

  test('RTT 未测得就不带后缀（不再显示「延迟未知」）', () => {
    expect(badgeLabel({ path: 'primary', directRttMs: null, link: link() })).toBe(
      'nodes.reach.lan'
    );
    expect(badgeLabel({ path: 'direct', directRttMs: null, link: link() })).toBe(
      'nodes.badge.direct'
    );
    expect(badgeLabel({ path: 'primary', directRttMs: null, link: link({ rttMs: 37.2 }) })).toBe(
      'nodes.reach.lan · 37ms'
    );
  });

  test('负数 / NaN 的 RTT 当作未测得', () => {
    expect(badgeLabel({ path: 'primary', directRttMs: null, link: link({ rttMs: -1 }) })).toBe(
      'nodes.reach.lan'
    );
    expect(badgeLabel({ path: 'direct', directRttMs: Number.NaN, link: link() })).toBe(
      'nodes.badge.direct'
    );
  });
});

describe('reachLabelKey / transportLabelKey', () => {
  test('到达路径四态各有 key', () => {
    expect(reachLabelKey('lan')).toBe('nodes.reach.lan');
    expect(reachLabelKey('wan')).toBe('nodes.reach.wan');
    expect(reachLabelKey('relay')).toBe('nodes.reach.relay');
    expect(reachLabelKey(null)).toBe('nodes.reach.none');
  });

  test('承载三态各有 key，未知为 null', () => {
    expect(transportLabelKey('ws-secure')).toBe('nodes.badge.transportWs');
    expect(transportLabelKey('dc')).toBe('nodes.badge.transportDc');
    expect(transportLabelKey('relay')).toBe('nodes.badge.transportRelay');
    expect(transportLabelKey(null)).toBeNull();
  });
});

describe('NodeLinkDiagnostics', () => {
  test('浮层带到达路径与承载两行；没有直连时给出占位说明', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link({ reach: 'relay', transport: 'relay' })}
      />
    );
    expect(html).toContain('data-testid="ice-diagnostics"');
    expect(html).toContain('nodes.badge.reachRow');
    expect(html).toContain('nodes.reach.relay');
    expect(html).toContain('nodes.badge.transportRow');
    expect(html).toContain('nodes.badge.transportRelay');
    expect(html).toContain('nodes.badge.icePlaceholder');
  });

  test('有 ICE 明细时照常列出候选对，不再出占位说明', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics({
          path: 'direct',
          rtt: 9,
          ice: {
            connectionState: 'connected',
            iceConnectionState: 'completed',
            localCandidateType: 'host',
            remoteCandidateType: 'srflx',
            selectedPair: 'host → srflx',
          },
        })}
        link={link({ reach: 'wan', transport: 'dc' })}
      />
    );
    expect(html).toContain('connected');
    expect(html).toContain('host → srflx');
    expect(html).toContain('nodes.badge.transportDc');
    expect(html).not.toContain('nodes.badge.icePlaceholder');
  });

  test('承载未知时该行落到「未知」', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics diagnostics={diagnostics()} link={link({ transport: null })} />
    );
    expect(html).toContain('nodes.badge.unknown');
  });
});

const REMOTE_NODE_ID = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

describe('DeviceNodeBadges', () => {
  test('self 不显示徽标（浏览器连的就是 entry 自己）', () => {
    expect(renderToStaticMarkup(<DeviceNodeBadges nodeId="self" />)).toBe('');
  });

  test('远端 node 只渲染一枚徽标，文本取到达路径与 entry 侧 RTT', () => {
    setMeshNodesStateForTest({
      entryNodeId: 'entry',
      nodes: [meshNode({ id: REMOTE_NODE_ID, reach: 'wan', transport: 'ws-secure', rttMs: 21.4 })],
    });
    const html = renderToStaticMarkup(<DeviceNodeBadges nodeId={REMOTE_NODE_ID} />);
    expect(html).toContain('data-testid="badge-node-link"');
    expect(html).toContain('nodes.reach.wan · 21ms');
    expect(html).not.toContain('nodes.badge.rttUnknown');
    // 浮层默认收起
    expect(html).not.toContain('data-testid="ice-diagnostics"');
  });

  test('列表里没有这一行时按不可达渲染', () => {
    setMeshNodesStateForTest({ entryNodeId: 'entry', nodes: [] });
    const html = renderToStaticMarkup(<DeviceNodeBadges nodeId={REMOTE_NODE_ID} />);
    expect(html).toContain('nodes.reach.none');
  });
});
