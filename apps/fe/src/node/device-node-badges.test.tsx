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
  formatLinkSince,
  linkDetailKind,
  reachLabelKey,
  resolveLinkBadge,
  transportLabelKey,
} = await import('./device-node-badges');

function link(overrides: Partial<NodeLink> = {}): NodeLink {
  return {
    reach: 'lan',
    transport: 'ws-secure',
    rttMs: null,
    peerAddress: null,
    linkSinceAt: null,
    directFailure: null,
    ...overrides,
  };
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

describe('linkDetailKind', () => {
  test('浏览器直连压过 entry 侧承载，其余按承载分类', () => {
    expect(linkDetailKind('direct', 'relay')).toBe('browser-direct');
    expect(linkDetailKind('primary', 'relay')).toBe('relay');
    expect(linkDetailKind('primary', 'ws-secure')).toBe('ws-secure');
    expect(linkDetailKind('primary', 'dc')).toBe('dc');
    expect(linkDetailKind('primary', null)).toBe('none');
  });
});

describe('formatLinkSince', () => {
  test('只取最大的那一档', () => {
    expect(formatLinkSince(12_000)).toEqual({ key: 'nodes.badge.durationSeconds', value: 12 });
    expect(formatLinkSince(185_000)).toEqual({ key: 'nodes.badge.durationMinutes', value: 3 });
    expect(formatLinkSince(3 * 3_600_000)).toEqual({ key: 'nodes.badge.durationHours', value: 3 });
    expect(formatLinkSince(50 * 3_600_000)).toEqual({ key: 'nodes.badge.durationDays', value: 2 });
  });

  test('负数 / NaN 不出行', () => {
    expect(formatLinkSince(-1)).toBeNull();
    expect(formatLinkSince(Number.NaN)).toBeNull();
  });
});

const NOW = 1_700_000_000_000;

describe('NodeLinkDiagnostics', () => {
  test('中转链路给出中转地址与未直连原因，且不出现任何「未知」行', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link({
          reach: 'relay',
          transport: 'relay',
          rttMs: 180,
          peerAddress: 'hub.example.com',
          linkSinceAt: NOW - 185_000,
          directFailure: {
            at: NOW - 200_000,
            ws: 'timeout ws://10.77.88.3:39001/peer',
            dc: 'datachannel open timeout',
          },
        })}
        now={NOW}
      />
    );
    expect(html).toContain('data-testid="ice-diagnostics"');
    expect(html).toContain('nodes.badge.reachRow');
    expect(html).toContain('nodes.reach.relay');
    expect(html).toContain('nodes.badge.transportRelay');
    expect(html).toContain('180ms');
    expect(html).toContain('nodes.badge.durationMinutes');
    expect(html).toContain('nodes.badge.relayVia');
    expect(html).toContain('hub.example.com');
    expect(html).toContain('nodes.badge.directFailureTitle');
    expect(html).toContain('timeout ws://10.77.88.3:39001/peer');
    expect(html).toContain('datachannel open timeout');
    expect(html).not.toContain('nodes.badge.unknown');
    expect(html).not.toContain('nodes.badge.connectionState');
    expect(html).not.toContain('nodes.badge.icePlaceholder');
  });

  test('中转但没记下失败原因时不出「未直连原因」块', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link({ reach: 'relay', transport: 'relay', rttMs: 90 })}
        now={NOW}
      />
    );
    expect(html).not.toContain('nodes.badge.directFailureTitle');
    expect(html).not.toContain('nodes.badge.relayVia');
    expect(html).not.toContain('nodes.badge.unknown');
  });

  test('ws-secure 给对端地址，不列 ICE 行', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link({ reach: 'lan', transport: 'ws-secure', rttMs: 4, peerAddress: '10.0.0.7' })}
        now={NOW}
      />
    );
    expect(html).toContain('nodes.badge.peerAddress');
    expect(html).toContain('10.0.0.7');
    expect(html).not.toContain('nodes.badge.selectedPair');
    expect(html).not.toContain('nodes.badge.icePlaceholder');
  });

  test('浏览器直连有 ICE 明细时照常列出候选对，RTT 取直连那一侧且不借 entry 侧的时长', () => {
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
        link={link({
          reach: 'wan',
          transport: 'dc',
          rttMs: 210,
          linkSinceAt: NOW - 185_000,
        })}
        now={NOW}
      />
    );
    expect(html).toContain('connected');
    expect(html).toContain('host → srflx');
    expect(html).toContain('nodes.badge.transportDc');
    expect(html).toContain('9ms');
    expect(html).not.toContain('210ms');
    expect(html).not.toContain('nodes.badge.since');
    expect(html).not.toContain('nodes.badge.icePlaceholder');
  });

  test('node↔node 的 dc 只给对端地址，不借浏览器那一跳的 ICE 明细', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics({
          ice: {
            connectionState: 'connecting',
            iceConnectionState: 'checking',
            localCandidateType: 'host',
            remoteCandidateType: null,
            selectedPair: null,
          },
        })}
        link={link({ reach: 'wan', transport: 'dc', rttMs: 33, peerAddress: '203.0.113.9' })}
        now={NOW}
      />
    );
    expect(html).toContain('nodes.badge.peerAddress');
    expect(html).toContain('203.0.113.9');
    expect(html).toContain('33ms');
    expect(html).not.toContain('nodes.badge.selectedPair');
    expect(html).not.toContain('checking');
    expect(html).not.toContain('nodes.badge.unknown');
  });

  test('node↔node 的 dc 没有对端地址时不出这一行', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link({ reach: 'wan', transport: 'dc', rttMs: 33 })}
        now={NOW}
      />
    );
    expect(html).not.toContain('nodes.badge.peerAddress');
    expect(html).not.toContain('nodes.badge.unknown');
  });

  test('浏览器直连但还没拿到 ICE 明细时才出占位说明', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics({ path: 'direct' })}
        link={link({ reach: 'wan', transport: 'dc' })}
        now={NOW}
      />
    );
    expect(html).toContain('nodes.badge.icePlaceholder');
  });

  test('RTT 未测得写「测量中」，不写未知', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics diagnostics={diagnostics()} link={link()} now={NOW} />
    );
    expect(html).toContain('nodes.badge.rttPending');
    expect(html).not.toContain('nodes.badge.since');
  });

  test('承载未知时该行落到「未知」', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics diagnostics={diagnostics()} link={link({ transport: null })} now={NOW} />
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
