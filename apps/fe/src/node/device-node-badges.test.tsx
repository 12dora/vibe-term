// 设备页链路徽标：合计延迟（浏览器 → node + node → tmux）的取值矩阵与诊断浮层的行。
// 无 DOM 测试环境，渲染用 react-dom/server；未初始化 i18n 时 `t()` 原样返回 key。

import { afterEach, describe, expect, test } from 'bun:test';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { DirectDiagnostics, DirectIceDiagnostics } from '@vibeterm/ws-client/direct/types';
import type { NodeLatency, NodeLink } from './direct-diagnostics';

installWindowStorage();

const NOW = 1_700_000_000_000;

const { renderToStaticMarkup } = await import('react-dom/server');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('./mesh-nodes');
const { appNodeRuntimes } = await import('./node-runtimes');
const { DeviceNodeBadges, NodeLinkDiagnostics, directFailureRows, formatLinkSince } = await import(
  './device-node-badges'
);
const {
  formatLinkBadgeLabel,
  freshHostHop,
  linkDetailKind,
  reachLabelKey,
  resolveLinkBadge,
  totalLatencyMs,
  transportLabelKey,
} = await import('./link-badge');

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

function latency(overrides: Partial<NodeLatency> = {}): NodeLatency {
  return {
    browserToNodeMs: null,
    browserToNodeRawMs: null,
    hostHop: null,
    hostHopSupported: false,
    ...overrides,
  };
}

/**
 * 宿主一跳的读数片段，和 `latency()` 一起用：`latency({ browserToNodeMs: 8, ...hostHop(2) })`。
 * 采样时刻默认取 `NOW`，判过期的用例自己给一个更早的时刻。
 */
function hostHop(
  rttMs: number,
  hop: 'local' | 'ssh' = 'local',
  rawMs = rttMs,
  sampledAt = NOW
): Pick<NodeLatency, 'hostHop' | 'hostHopSupported'> {
  return {
    hostHop: { rttMs, rawMs, hop, sampledAt },
    hostHopSupported: true,
  };
}

function diagnostics(overrides: Partial<DirectDiagnostics> = {}): DirectDiagnostics {
  return { path: 'primary', route: null, rtt: null, ice: null, ...overrides };
}

/** 徽标最终展示的那串文本（未初始化 i18n 时 key 即译文）。 */
function badgeLabel(input: Parameters<typeof resolveLinkBadge>[0]): string {
  const badge = resolveLinkBadge({ now: NOW, ...input });
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

describe('totalLatencyMs', () => {
  test('两段相加；宿主一跳缺席时只算浏览器到 node 那一段', () => {
    expect(totalLatencyMs(latency({ browserToNodeMs: 18, ...hostHop(4) }), NOW)).toBe(22);
    expect(totalLatencyMs(latency({ browserToNodeMs: 18 }), NOW)).toBe(18);
    expect(totalLatencyMs(latency({ browserToNodeMs: 18, hostHopSupported: true }), NOW)).toBe(18);
  });

  test('浏览器那一段还没测出来时整体未知', () => {
    expect(totalLatencyMs(latency({ ...hostHop(4) }), NOW)).toBeNull();
    expect(totalLatencyMs(latency({ browserToNodeMs: Number.NaN, ...hostHop(4) }), NOW)).toBeNull();
  });

  test('宿主一跳的负数 / NaN 当作未测得，不污染合计', () => {
    expect(totalLatencyMs(latency({ browserToNodeMs: 18, ...hostHop(-1) }), NOW)).toBe(18);
    expect(totalLatencyMs(latency({ browserToNodeMs: 18, ...hostHop(Number.NaN) }), NOW)).toBe(18);
  });

  test('宿主一跳超过 45s 没有新样本就不再计入', () => {
    const fresh = latency({ browserToNodeMs: 18, ...hostHop(4, 'local', 4, NOW - 44_000) });
    expect(totalLatencyMs(fresh, NOW)).toBe(22);
    const stale = latency({ browserToNodeMs: 18, ...hostHop(4, 'local', 4, NOW - 46_000) });
    expect(totalLatencyMs(stale, NOW)).toBe(18);
    expect(freshHostHop(stale, NOW)).toBeNull();
  });

  test('采样时刻不可信（0 / 非有限 / 网关时钟超前）时不判过期', () => {
    expect(
      totalLatencyMs(latency({ browserToNodeMs: 18, ...hostHop(4, 'local', 4, 0) }), NOW)
    ).toBe(22);
    expect(
      totalLatencyMs(latency({ browserToNodeMs: 18, ...hostHop(4, 'local', 4, Number.NaN) }), NOW)
    ).toBe(22);
    expect(
      totalLatencyMs(latency({ browserToNodeMs: 18, ...hostHop(4, 'local', 4, NOW + 60_000) }), NOW)
    ).toBe(22);
  });
});

describe('resolveLinkBadge', () => {
  test('数字是整条链路：浏览器 → node 的心跳中位数加上 node → tmux 的宿主一跳', () => {
    const badge = resolveLinkBadge({
      now: NOW,
      path: 'direct',
      link: link({ reach: 'wan', transport: 'dc', rttMs: 180 }),
      latency: latency({ browserToNodeMs: 12, ...hostHop(6) }),
    });
    expect(badge).toEqual({ labelKey: 'nodes.badge.direct', rttMs: 18, tone: 'ok' });
    expect(formatLinkBadgeLabel(badge.labelKey, badge.rttMs)).toBe('nodes.badge.direct · 18ms');
  });

  test('标签按链路怎么走给：本机 / 直连压过到达路径，其余按到达路径', () => {
    const measured = latency({ browserToNodeMs: 10 });
    expect(
      resolveLinkBadge({
        now: NOW,
        path: 'primary',
        link: link({ reach: 'relay' }),
        latency: measured,
        isSelf: true,
      }).labelKey
    ).toBe('nodes.badge.local');
    expect(
      resolveLinkBadge({
        path: 'direct',
        link: link({ reach: 'relay' }),
        latency: measured,
        now: NOW,
      }).labelKey
    ).toBe('nodes.badge.direct');
    expect(
      resolveLinkBadge({
        path: 'primary',
        link: link({ reach: 'wan' }),
        latency: measured,
        now: NOW,
      }).labelKey
    ).toBe('nodes.reach.wan');
    expect(
      resolveLinkBadge({
        path: 'primary',
        link: link({ reach: null }),
        latency: measured,
        now: NOW,
      }).labelKey
    ).toBe('nodes.reach.none');
  });

  test('色调：不可达 / 中转灰，其余绿，合计到 200ms 一律告警色', () => {
    const measured = latency({ browserToNodeMs: 10 });
    expect(
      resolveLinkBadge({ path: 'primary', link: link(), latency: measured, now: NOW }).tone
    ).toBe('ok');
    expect(
      resolveLinkBadge({
        now: NOW,
        path: 'primary',
        link: link({ reach: 'relay', transport: 'relay' }),
        latency: measured,
      }).tone
    ).toBe('muted');
    expect(
      resolveLinkBadge({
        now: NOW,
        path: 'primary',
        link: link(),
        latency: latency({ browserToNodeMs: 150, ...hostHop(50) }),
      }).tone
    ).toBe('warn');
    expect(
      resolveLinkBadge({
        now: NOW,
        path: 'primary',
        link: link({ reach: 'relay', transport: 'relay' }),
        latency: latency({ browserToNodeMs: 260 }),
      }).tone
    ).toBe('warn');
  });

  test('心跳还没出样本就不带后缀（不再显示「延迟未知」）', () => {
    expect(badgeLabel({ path: 'primary', link: link({ rttMs: 37 }), latency: latency() })).toBe(
      'nodes.reach.lan'
    );
    expect(
      badgeLabel({ path: 'primary', link: link(), latency: latency({ browserToNodeMs: 37.2 }) })
    ).toBe('nodes.reach.lan · 37ms');
  });

  test('到达路径还没拿到时只留标签，不显示「不可达 · 12ms」', () => {
    const measured = latency({ browserToNodeMs: 12, ...hostHop(3) });
    const badge = resolveLinkBadge({
      now: NOW,
      path: 'primary',
      link: link({ reach: null, transport: null }),
      latency: measured,
    });
    expect(badge).toEqual({ labelKey: 'nodes.reach.none', rttMs: null, tone: 'muted' });
    expect(formatLinkBadgeLabel(badge.labelKey, badge.rttMs)).toBe('nodes.reach.none');
    // 本机与直连不受影响：这两种标签本身就说明链路是通的
    expect(
      resolveLinkBadge({
        now: NOW,
        path: 'primary',
        link: link({ reach: null, transport: null }),
        latency: measured,
        isSelf: true,
      }).rttMs
    ).toBe(15);
    expect(
      resolveLinkBadge({
        now: NOW,
        path: 'direct',
        link: link({ reach: null, transport: null }),
        latency: measured,
      }).rttMs
    ).toBe(15);
  });

  test('宿主一跳过期后徽标只剩浏览器那一段', () => {
    const badge = resolveLinkBadge({
      now: NOW,
      path: 'primary',
      link: link({ reach: 'lan' }),
      latency: latency({ browserToNodeMs: 12, ...hostHop(30, 'local', 30, NOW - 60_000) }),
    });
    expect(badge.rttMs).toBe(12);
  });

  test('entry ↔ node 的 peer ping 不再进徽标', () => {
    expect(
      resolveLinkBadge({
        now: NOW,
        path: 'primary',
        link: link({ reach: 'relay', transport: 'relay', rttMs: 210 }),
        latency: latency({ browserToNodeMs: 30 }),
      }).rttMs
    ).toBe(30);
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
        latency={latency({ browserToNodeMs: 12, browserToNodeRawMs: 12 })}
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
        latency={latency({ browserToNodeMs: 12, browserToNodeRawMs: 12 })}
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
        latency={latency({ browserToNodeMs: 12, browserToNodeRawMs: 12 })}
        now={NOW}
      />
    );
    expect(html).toContain('nodes.badge.peerAddress');
    expect(html).toContain('10.0.0.7');
    expect(html).not.toContain('nodes.badge.selectedPair');
    expect(html).not.toContain('nodes.badge.icePlaceholder');
  });

  test('浏览器直连有 ICE 明细时照常列出候选对，peer ping 降为一行明细且不借 entry 侧的时长', () => {
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
        latency={latency({ browserToNodeMs: 12, browserToNodeRawMs: 12 })}
        now={NOW}
      />
    );
    expect(html).toContain('nodes.badge.ice.connected');
    expect(html).toContain('nodes.badge.ice.completed');
    expect(html).toContain('nodes.badge.candidate.host → nodes.badge.candidate.srflx');
    expect(html).toContain('nodes.badge.transportDc');
    // 候选对 RTT 与 entry ↔ node 的 peer ping 各占一行，都不再是徽标上的那个数字
    expect(html).toContain('9ms');
    expect(html).toContain('nodes.badge.peerLink');
    expect(html).toContain('210ms');
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
        latency={latency({ browserToNodeMs: 12, browserToNodeRawMs: 12 })}
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
        latency={latency({ browserToNodeMs: 12, browserToNodeRawMs: 12 })}
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
        latency={latency({ browserToNodeMs: 12, browserToNodeRawMs: 12 })}
        now={NOW}
      />
    );
    expect(html).toContain('nodes.badge.icePlaceholder');
  });

  test('RTT 未测得写「测量中」，不写未知', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link()}
        latency={latency()}
        now={NOW}
      />
    );
    expect(html).toContain('nodes.badge.rttPending');
    expect(html).not.toContain('nodes.badge.since');
  });

  test('按跳拆开：浏览器 → node 用心跳中位数，node → tmux 按本地 / SSH 给', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link({ reach: 'wan', transport: 'ws-secure', rttMs: 21 })}
        latency={latency({
          browserToNodeMs: 30,
          browserToNodeRawMs: 34,
          ...hostHop(12, 'ssh', 15),
        })}
        now={NOW}
      />
    );
    expect(html).toContain('nodes.badge.browserHop');
    expect(html).toContain('nodes.badge.hopMedian');
    expect(html).toContain('nodes.badge.hostHop');
    expect(html).toContain('nodes.badge.hopSsh');
    // 最近一次样本是两段原始样本之和，与合计 42ms 不同才单出一行
    expect(html).toContain('nodes.badge.lastSample');
    expect(html).toContain('49ms');
    expect(html).toContain('nodes.badge.peerLink');
    expect(html).toContain('21ms');
    expect(html).not.toContain('nodes.badge.hopUnsupported');
  });

  test('宿主一跳：本地 tmux 与「节点版本过旧」各有措辞', () => {
    const local = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link()}
        latency={latency({ browserToNodeMs: 8, browserToNodeRawMs: 8, ...hostHop(2) })}
        now={NOW}
      />
    );
    expect(local).toContain('nodes.badge.hopLocal');
    expect(local).not.toContain('nodes.badge.lastSample');

    const old = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link()}
        latency={latency({ browserToNodeMs: 8, browserToNodeRawMs: 8 })}
        now={NOW}
      />
    );
    expect(old).toContain('nodes.badge.hopUnsupported');

    const pending = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link()}
        latency={latency({ browserToNodeMs: 8, browserToNodeRawMs: 8, hostHopSupported: true })}
        now={NOW}
      />
    );
    expect(pending).toContain('nodes.badge.rttPending');
    expect(pending).not.toContain('nodes.badge.hopUnsupported');
  });

  test('宿主一跳过期后写「已停止上报」，最近一次样本也不再带它', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link()}
        latency={latency({
          browserToNodeMs: 8,
          browserToNodeRawMs: 9,
          ...hostHop(30, 'local', 30, NOW - 60_000),
        })}
        now={NOW}
      />
    );
    expect(html).toContain('nodes.badge.hopStale');
    expect(html).not.toContain('nodes.badge.hopLocal');
    expect(html).toContain('9ms');
    expect(html).not.toContain('39ms');
  });

  test('浏览器直连还没拿到候选对明细时也给出候选对 RTT', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics({ path: 'direct', rtt: 9 })}
        link={link({ reach: 'wan', transport: 'dc' })}
        latency={latency({ browserToNodeMs: 12, browserToNodeRawMs: 12 })}
        now={NOW}
      />
    );
    expect(html).toContain('nodes.badge.rttRow');
    expect(html).toContain('9ms');
    expect(html).toContain('nodes.badge.icePlaceholder');
  });

  test('本机只列两跳：没有到达路径 / 承载 / peer ping 这些说不通的行', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link({ reach: 'lan', transport: 'ws-secure', rttMs: 3 })}
        latency={latency({ browserToNodeMs: 6, browserToNodeRawMs: 6, ...hostHop(2) })}
        isSelf
        now={NOW}
      />
    );
    expect(html).toContain('nodes.badge.browserHop');
    expect(html).toContain('nodes.badge.hostHop');
    expect(html).not.toContain('nodes.badge.reachRow');
    expect(html).not.toContain('nodes.badge.transportRow');
    expect(html).not.toContain('nodes.badge.peerLink');
  });

  test('承载未知时该行落到「未知」', () => {
    const html = renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics()}
        link={link({ transport: null })}
        latency={latency({ browserToNodeMs: 12, browserToNodeRawMs: 12 })}
        now={NOW}
      />
    );
    expect(html).toContain('nodes.badge.unknown');
  });
});

describe('directFailureRows', () => {
  test('有失败码就按码翻译并带上插值参数', () => {
    expect(
      directFailureRows({
        at: NOW,
        ws: 'all endpoints backing off (next eligible in 42s)',
        wsCode: 'backoff',
        wsParams: { seconds: 42 },
        dc: 'direct_capable=false',
        dcCode: 'not_direct_capable',
        dcParams: null,
      })
    ).toEqual([
      {
        labelKey: 'nodes.badge.directFailureWs',
        valueKey: 'nodes.badge.failure.backoff',
        valueParams: { seconds: 42 },
        mono: false,
      },
      {
        labelKey: 'nodes.badge.directFailureDc',
        valueKey: 'nodes.badge.failure.not_direct_capable',
        valueParams: {},
        mono: false,
      },
    ]);
  });

  test('熔断冷却的解除时刻按本地时间格式化后再插值', () => {
    const rows = directFailureRows({
      at: NOW,
      dc: 'dial breaker cooling',
      dcCode: 'breaker_cooling',
      dcParams: { until: NOW + 60_000 },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.valueKey).toBe('nodes.badge.failure.breaker_cooling');
    const until = rows[0]?.valueParams?.until;
    expect(typeof until).toBe('string');
    expect(until).toBe(
      new Date(NOW + 60_000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    );
  });

  // 永久禁拨没有解除时刻，breaker_cooling 的模板要 {{until}}，照译会把占位符原样显示
  test('熔断无解除时刻时换用 breaker_paused，不带 until', () => {
    const rows = directFailureRows({
      at: NOW,
      dc: 'dial breaker paused',
      dcCode: 'breaker_cooling',
      dcParams: {},
    });
    expect(rows[0]?.valueKey).toBe('nodes.badge.failure.breaker_paused');
    expect(rows[0]?.valueParams).toEqual({});
  });

  test('网关直接下发 breaker_paused 时按码翻译', () => {
    const rows = directFailureRows({
      at: NOW,
      dc: 'dial breaker paused',
      dcCode: 'breaker_paused',
    });
    expect(rows[0]?.valueKey).toBe('nodes.badge.failure.breaker_paused');
  });

  test('旧网关没有失败码时保留等宽原文', () => {
    expect(
      directFailureRows({ at: NOW, ws: 'timeout ws://10.0.0.7:39001/peer', dc: null })
    ).toEqual([
      {
        labelKey: 'nodes.badge.directFailureWs',
        value: 'timeout ws://10.0.0.7:39001/peer',
      },
    ]);
  });

  test('认不出的码（更新的网关）也回落原文', () => {
    const rows = directFailureRows({
      at: NOW,
      ws: 'brand new failure',
      wsCode: 'not_a_real_code' as never,
    });
    expect(rows[0]?.value).toBe('brand new failure');
    expect(rows[0]?.valueKey).toBeUndefined();
  });

  test('没有失败原因就不出行', () => {
    expect(directFailureRows(null)).toEqual([]);
  });
});

describe('ICE 明细的翻译', () => {
  function iceHtml(ice: Partial<DirectIceDiagnostics>): string {
    return renderToStaticMarkup(
      <NodeLinkDiagnostics
        diagnostics={diagnostics({
          path: 'direct',
          rtt: 9,
          ice: {
            connectionState: null,
            iceConnectionState: null,
            localCandidateType: null,
            remoteCandidateType: null,
            selectedPair: null,
            ...ice,
          },
        })}
        link={link({ reach: 'wan', transport: 'dc' })}
        latency={latency({ browserToNodeMs: 12, browserToNodeRawMs: 12 })}
        now={NOW}
      />
    );
  }

  test('W3C 枚举与候选类型走 key，浏览器方言原样展示', () => {
    const html = iceHtml({
      connectionState: 'connecting',
      iceConnectionState: 'weird-state',
      localCandidateType: 'relay',
      remoteCandidateType: 'mystery',
    });
    expect(html).toContain('nodes.badge.ice.connecting');
    expect(html).toContain('weird-state');
    expect(html).not.toContain('nodes.badge.ice.weird-state');
    expect(html).toContain('nodes.badge.candidate.relay');
    expect(html).toContain('mystery');
    expect(html).not.toContain('nodes.badge.candidate.mystery');
  });

  test('两端候选都拿不到时退回原来的候选对串', () => {
    const html = iceHtml({ selectedPair: 'host → srflx' });
    expect(html).toContain('host → srflx');
  });
});

const REMOTE_NODE_ID = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

describe('DeviceNodeBadges', () => {
  /** 直接往该 node 运行时的 tmux store 里塞读数：徽标就是从这里取两段延迟的。 */
  function seedLatency(
    nodeId: string,
    state: {
      wsLatencyMs?: number | null;
      wsLatencyRawMs?: number | null;
      deviceLatency?: Record<
        string,
        { rttMs: number; rawMs: number; hop: 'local' | 'ssh'; sampledAt: number }
      >;
      deviceLatencySupported?: boolean;
    }
  ): void {
    appNodeRuntimes.get(nodeId).runtime.stores.tmux.setState({
      wsLatencyMs: null,
      wsLatencyRawMs: null,
      deviceLatency: {},
      deviceLatencySupported: false,
      ...state,
    });
  }

  test('self 也有徽标：标签写「本机」，数字是浏览器到本机 tmux 的合计', () => {
    setMeshNodesStateForTest({ entryNodeId: 'entry', nodes: [] });
    seedLatency('self', {
      wsLatencyMs: 4,
      wsLatencyRawMs: 4,
      deviceLatencySupported: true,
      // 组件按真实时钟判过期：种子样本要用当下时刻，否则 45 s 之外的读数不会计入
      deviceLatency: {
        'dev-1': { rttMs: 3, rawMs: 3, hop: 'local', sampledAt: Date.now() },
      },
    });
    const html = renderToStaticMarkup(<DeviceNodeBadges nodeId="self" deviceId="dev-1" />);
    expect(html).toContain('data-testid="badge-node-link"');
    expect(html).toContain('nodes.badge.local · 7ms');
  });

  test('远端 node 的徽标是「浏览器 → node」加「node → tmux」，标签取到达路径', () => {
    setMeshNodesStateForTest({
      entryNodeId: 'entry',
      nodes: [meshNode({ id: REMOTE_NODE_ID, reach: 'wan', transport: 'ws-secure', rttMs: 21.4 })],
    });
    seedLatency(REMOTE_NODE_ID, {
      wsLatencyMs: 38,
      wsLatencyRawMs: 41,
      deviceLatencySupported: true,
      deviceLatency: {
        'dev-1': { rttMs: 12, rawMs: 14, hop: 'ssh', sampledAt: Date.now() },
      },
    });
    const html = renderToStaticMarkup(
      <DeviceNodeBadges nodeId={REMOTE_NODE_ID} deviceId="dev-1" />
    );
    expect(html).toContain('data-testid="badge-node-link"');
    expect(html).toContain('nodes.reach.wan · 50ms');
    // entry ↔ node 的 peer ping 不再是徽标上的数字
    expect(html).not.toContain('21ms');
    // 浮层默认收起
    expect(html).not.toContain('data-testid="ice-diagnostics"');
  });

  test('宿主一跳测不到时只显示浏览器到 node 那一段', () => {
    setMeshNodesStateForTest({
      entryNodeId: 'entry',
      nodes: [meshNode({ id: REMOTE_NODE_ID, reach: 'lan', transport: 'ws-secure', rttMs: 3 })],
    });
    seedLatency(REMOTE_NODE_ID, { wsLatencyMs: 9, wsLatencyRawMs: 9 });
    const html = renderToStaticMarkup(
      <DeviceNodeBadges nodeId={REMOTE_NODE_ID} deviceId="dev-1" />
    );
    expect(html).toContain('nodes.reach.lan · 9ms');
  });

  test('网关停播 45s 后徽标不再加那一跳', () => {
    setMeshNodesStateForTest({
      entryNodeId: 'entry',
      nodes: [meshNode({ id: REMOTE_NODE_ID, reach: 'lan', transport: 'ws-secure', rttMs: 3 })],
    });
    seedLatency(REMOTE_NODE_ID, {
      wsLatencyMs: 9,
      wsLatencyRawMs: 9,
      deviceLatencySupported: true,
      deviceLatency: {
        'dev-1': { rttMs: 30, rawMs: 30, hop: 'local', sampledAt: Date.now() - 60_000 },
      },
    });
    const html = renderToStaticMarkup(
      <DeviceNodeBadges nodeId={REMOTE_NODE_ID} deviceId="dev-1" />
    );
    expect(html).toContain('nodes.reach.lan · 9ms');
  });

  test('心跳还没出样本时只剩标签，且列表里没有这一行按不可达渲染', () => {
    setMeshNodesStateForTest({ entryNodeId: 'entry', nodes: [] });
    seedLatency(REMOTE_NODE_ID, {});
    const html = renderToStaticMarkup(
      <DeviceNodeBadges nodeId={REMOTE_NODE_ID} deviceId="dev-1" />
    );
    expect(html).toContain('nodes.reach.none');
    expect(html).not.toContain('ms<');
  });
});
