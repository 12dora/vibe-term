// 指标面板：取数层的纯函数 + 静态渲染下的磁贴 / 趋势 / 接入节点表。
// 无 DOM 测试环境，用 react-dom/server 静态标记断言结构与 testId（与 RelayTab 测试同一套做法）。

import { afterEach, describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const {
  eventLoopLevel,
  cpuLevel,
  levelTone,
  maxMemberRttMs,
  medianMemberRttMs,
  memberTitle,
  metricSeries,
  relayTrendSeries,
  rttLevel,
  totalMemberReconnects,
  filterMembers,
  sortMembersBy,
  toggleMemberSort,
} = await import('./relay-metrics-model');
const { relayMetricsFixture, relayMetricsMember, relayMetricsSample } = await import(
  './relay-metrics-fixture'
);
const { RelayCompactTiles, RelayFullTiles, RelayTilesSkeleton, ThroughputTile } = await import(
  './relay-metrics-tiles'
);
const { RelayTrendsCard } = await import('./relay-metrics-trends');
const { RelayMembersTable } = await import('./relay-metrics-members');
const { RelayMetricsPanel, RelayMetricsHeaderStrip } = await import('./relay-metrics-panel');
const { resetRelayMetricsStateForTest, setRelayMetricsStateForTest, useRelayMetrics } =
  await import('./relay-metrics-store');
const { DEFAULT_MEMBER_SORT } = await import('./relay-metrics-model');

/** 面板不再自己持有采样回路：测试用这个壳把 store 快照喂进去（静态渲染跑不了 effect）。 */
function MetricsPanelHost() {
  return <RelayMetricsPanel metrics={useRelayMetrics({ enabled: false })} />;
}

afterEach(() => {
  resetRelayMetricsStateForTest();
});

describe('metricSeries', () => {
  test('抽出取值并记住最小 / 最大 / 末值', () => {
    const series = metricSeries(
      [relayMetricsSample(0), relayMetricsSample(1), relayMetricsSample(2)],
      (s) => s.activeStreams
    );
    expect(series.values).toEqual([0, 1, 2]);
    expect(series.min).toBe(0);
    expect(series.max).toBe(2);
    expect(series.last).toBe(2);
  });

  test('null 与非有限值按 0 计', () => {
    const series = metricSeries([relayMetricsSample(0)], () => null);
    expect(series.values).toEqual([0]);
  });

  test('空样本不产生 Infinity', () => {
    const series = metricSeries([], (s) => s.activeStreams);
    expect(series).toEqual({ values: [], min: 0, max: 0, last: 0 });
  });
});

describe('relayTrendSeries', () => {
  test('窗口长度按样本数与采样间隔算', () => {
    const trends = relayTrendSeries(relayMetricsFixture());
    expect(trends.bytesIn.values).toHaveLength(6);
    expect(trends.windowMs).toBe(25_000);
  });

  test('单样本的窗口是 0，不出负数', () => {
    const data = relayMetricsFixture();
    const trends = relayTrendSeries({
      ...data,
      history: { intervalMs: 5_000, samples: [relayMetricsSample(0)] },
    });
    expect(trends.windowMs).toBe(0);
  });
});

describe('成员统计', () => {
  test('中位数与最大值只算在线成员', () => {
    const members = [
      relayMetricsMember({ nodeId: 'a', rttMs: 10 }),
      relayMetricsMember({ nodeId: 'b', rttMs: 30 }),
      relayMetricsMember({ nodeId: 'c', rttMs: 900, online: false }),
    ];
    expect(medianMemberRttMs(members)).toBe(20);
    expect(maxMemberRttMs(members)).toBe(30);
  });

  test('没有在线成员时回 null', () => {
    const members = [relayMetricsMember({ online: false })];
    expect(medianMemberRttMs(members)).toBeNull();
    expect(maxMemberRttMs(members)).toBeNull();
  });

  test('重连次数求和，离线成员也算', () => {
    expect(
      totalMemberReconnects([
        relayMetricsMember({ nodeId: 'a', reconnects: 2 }),
        relayMetricsMember({ nodeId: 'b', reconnects: 3, online: false }),
      ])
    ).toBe(5);
    expect(totalMemberReconnects([])).toBe(0);
  });

  test('标题取名字，没名字取节点号前 8 位', () => {
    expect(memberTitle(relayMetricsMember({ name: ' 北京 ' }))).toBe('北京');
    expect(memberTitle(relayMetricsMember({ name: null, nodeId: 'aabbccddeeff' }))).toBe(
      'aabbccdd'
    );
  });
});

describe('filterMembers', () => {
  const members = [
    relayMetricsMember({ nodeId: 'aaaa1111', name: '北京', tenantId: 't1' }),
    relayMetricsMember({ nodeId: 'bbbb2222', name: null, tenantId: 't2', online: false }),
  ];

  test('空条件放行全部', () => {
    expect(filterMembers(members, { query: '', state: 'all', tenantId: null })).toHaveLength(2);
  });

  test('按租户过滤', () => {
    const rows = filterMembers(members, { query: '', state: 'all', tenantId: 't2' });
    expect(rows.map((row) => row.nodeId)).toEqual(['bbbb2222']);
  });

  test('按在线状态过滤', () => {
    expect(
      filterMembers(members, { query: '', state: 'online', tenantId: null }).map((r) => r.nodeId)
    ).toEqual(['aaaa1111']);
    expect(
      filterMembers(members, { query: '', state: 'offline', tenantId: null }).map((r) => r.nodeId)
    ).toEqual(['bbbb2222']);
  });

  test('检索命中节点名 / 节点号 / 租户号，大小写与前后空白都不计较', () => {
    const q = (query: string) =>
      filterMembers(members, { query, state: 'all', tenantId: null }).map((row) => row.nodeId);
    expect(q(' 北京 ')).toEqual(['aaaa1111']);
    expect(q('BBBB')).toEqual(['bbbb2222']);
    expect(q('T1')).toEqual(['aaaa1111']);
    expect(q('nothing')).toEqual([]);
  });

  test('条件叠加：租户 + 状态 + 关键词', () => {
    expect(filterMembers(members, { query: 'bbbb', state: 'online', tenantId: 't2' })).toHaveLength(
      0
    );
  });
});

describe('sortMembersBy', () => {
  const a = relayMetricsMember({ nodeId: 'n1', name: 'alpha', rttMs: 50, activeStreams: 1 });
  const b = relayMetricsMember({ nodeId: 'n2', name: 'bravo', rttMs: 10, activeStreams: 5 });
  const off = relayMetricsMember({
    nodeId: 'n3',
    name: 'charlie',
    online: false,
    rttMs: 999,
    activeStreams: 0,
    connectedAt: null,
  });

  const ids = (key: Parameters<typeof toggleMemberSort>[1], direction: 'asc' | 'desc') =>
    sortMembersBy([b, off, a], { key, direction }).map((row) => row.nodeId);

  test('默认按节点名升序，降序即翻面', () => {
    expect(ids('node', 'asc')).toEqual(['n1', 'n2', 'n3']);
    expect(ids('node', 'desc')).toEqual(['n3', 'n2', 'n1']);
  });

  test('数值列按值排', () => {
    expect(ids('streams', 'desc')).toEqual(['n2', 'n1', 'n3']);
  });

  test('状态列：升序在线在前', () => {
    expect(ids('state', 'asc')).toEqual(['n1', 'n2', 'n3']);
  });

  test('缺值恒排在最后，升降序都一样（离线成员的延迟不算数）', () => {
    expect(ids('rtt', 'asc')).toEqual(['n2', 'n1', 'n3']);
    expect(ids('rtt', 'desc')).toEqual(['n1', 'n2', 'n3']);
    expect(ids('connected', 'desc')[2]).toBe('n3');
  });

  test('同值时按节点号稳定收尾', () => {
    const same = [
      relayMetricsMember({ nodeId: 'z', name: 'same' }),
      relayMetricsMember({ nodeId: 'a', name: 'same' }),
    ];
    expect(sortMembersBy(same, { key: 'node', direction: 'desc' }).map((r) => r.nodeId)).toEqual([
      'a',
      'z',
    ]);
  });

  test('不改原数组', () => {
    const input = [b, a];
    sortMembersBy(input, { key: 'node', direction: 'asc' });
    expect(input.map((row) => row.nodeId)).toEqual(['n2', 'n1']);
  });
});

describe('toggleMemberSort', () => {
  test('换列回到升序，同列翻面', () => {
    expect(toggleMemberSort({ key: 'node', direction: 'asc' }, 'rate')).toEqual({
      key: 'rate',
      direction: 'asc',
    });
    expect(toggleMemberSort({ key: 'rate', direction: 'asc' }, 'rate')).toEqual({
      key: 'rate',
      direction: 'desc',
    });
    expect(toggleMemberSort({ key: 'rate', direction: 'desc' }, 'rate')).toEqual({
      key: 'rate',
      direction: 'asc',
    });
  });
});

describe('告警档', () => {
  test('事件循环延迟三档', () => {
    expect(eventLoopLevel(20)).toBe('ok');
    expect(eventLoopLevel(120)).toBe('warn');
    expect(eventLoopLevel(400)).toBe('bad');
  });

  test('RTT 三档，未知按正常算', () => {
    expect(rttLevel(null)).toBe('ok');
    expect(rttLevel(80)).toBe('ok');
    expect(rttLevel(200)).toBe('warn');
    expect(rttLevel(800)).toBe('bad');
  });

  test('CPU 三档', () => {
    expect(cpuLevel(null)).toBe('ok');
    expect(cpuLevel(50)).toBe('ok');
    expect(cpuLevel(80)).toBe('warn');
    expect(cpuLevel(95)).toBe('bad');
  });

  test('档位映射到磁贴色调', () => {
    expect(levelTone('ok')).toBe('default');
    expect(levelTone('warn')).toBe('warning');
    expect(levelTone('bad')).toBe('destructive');
  });
});

describe('磁贴排', () => {
  const data = relayMetricsFixture();
  const trends = relayTrendSeries(data);

  test('完整排把十二格分两组摆出来', () => {
    const html = renderToStaticMarkup(<RelayFullTiles data={data} trends={trends} />);
    for (const id of [
      'members-online',
      'active-streams',
      'bytes-in',
      'bytes-out',
      'frames',
      'traffic',
      'rtt',
      'event-loop',
      'memory',
      'cpu',
      'sockets',
      'reconnects',
    ]) {
      expect(html).toContain(`data-testid="relay-metric-${id}"`);
    }
    expect(html).toContain('data-testid="relay-metrics-group-traffic"');
    expect(html).toContain('data-testid="relay-metrics-group-process"');
    expect(html).toContain('relay.metrics.groups.traffic');
    expect(html).toContain('relay.metrics.groups.process');
  });

  test('完整排不再摆运行时长与独立堆格：前者在头部条，后者并进内存格', () => {
    const html = renderToStaticMarkup(<RelayFullTiles data={data} trends={trends} />);
    expect(html).not.toContain('data-testid="relay-metric-uptime"');
    expect(html).not.toContain('data-testid="relay-metric-heap"');
    expect(html).toContain('relay.metrics.tiles.memoryHeapSub');
    expect(html).not.toContain('relay.metrics.tiles.memorySub');
  });

  test('紧凑排的内存格只报堆已用量，副行不塞总量', () => {
    const html = renderToStaticMarkup(<RelayCompactTiles data={data} trends={trends} />);
    expect(html).toContain('relay.metrics.tiles.memorySub');
    expect(html).not.toContain('relay.metrics.tiles.memoryHeapSub');
  });

  test('紧凑排只出七格，吞吐格带折线', () => {
    const html = renderToStaticMarkup(<RelayCompactTiles data={data} trends={trends} />);
    expect(html).toContain('data-testid="relay-metric-throughput"');
    expect(html).toContain('data-testid="relay-metric-uptime"');
    expect(html).not.toContain('data-testid="relay-metric-heap"');
    expect(html).not.toContain('data-testid="relay-metric-sockets"');
    expect(html).toContain('data-slot="sparkline"');
  });

  test('累计流量：完整排单独一格，只出一个数（收发两侧同值）', () => {
    const html = renderToStaticMarkup(<RelayFullTiles data={data} trends={trends} />);
    expect(html).toContain('data-testid="relay-metric-traffic"');
    // totals.bytesOut = 10 MiB；in / out 逐字节相等，只摆一次
    expect(html).toContain('10.0 MB');
    expect(html).toContain('relay.metrics.tiles.trafficSub');
    expect(html).toContain('title="relay.metrics.tiles.trafficHint"');
  });

  test('紧凑排没有单独的流量格，累计量挂在吞吐格副行上', () => {
    const html = renderToStaticMarkup(<RelayCompactTiles data={data} trends={trends} />);
    expect(html).not.toContain('data-testid="relay-metric-traffic"');
    expect(html).toContain('relay.metrics.tiles.throughputTotal');
    expect(html).not.toContain('relay.metrics.tiles.throughputSub');
  });

  test('完整排把进出速率拆成两格，不再摆合计吞吐格', () => {
    const html = renderToStaticMarkup(<RelayFullTiles data={data} trends={trends} />);
    expect(html).toContain('data-testid="relay-metric-bytes-in"');
    expect(html).toContain('data-testid="relay-metric-bytes-out"');
    expect(html).not.toContain('data-testid="relay-metric-throughput"');
  });

  test('吞吐格默认副行是进出速率，showTotal 才换成累计量', () => {
    const rates = renderToStaticMarkup(<ThroughputTile data={data} trends={trends} />);
    expect(rates).toContain('relay.metrics.tiles.throughputSub');
    expect(rates).not.toContain('relay.metrics.tiles.throughputTotal');

    const total = renderToStaticMarkup(<ThroughputTile data={data} trends={trends} showTotal />);
    expect(total).toContain('relay.metrics.tiles.throughputTotal');
    expect(total).not.toContain('relay.metrics.tiles.throughputSub');
  });

  test('响应式栅格：窄屏不摆多列，免得读数被截断', () => {
    const compact = renderToStaticMarkup(<RelayCompactTiles data={data} trends={trends} />);
    // 主排：基础断点单列 → sm 两列 → lg 四列
    expect(compact).toContain('grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4');
    // 瘦排：基础断点两列（值都很短）→ sm 三列
    expect(compact).toContain('grid grid-cols-2 gap-2 sm:grid-cols-3');
    expect(compact).not.toContain('grid grid-cols-3 gap-2"');

    // 完整排：每组六格，列数只取 6 的因数（2/3/6），行才不会缺角；窄屏折线已隐藏所以两列也放得下；六列留给 2xl
    const full = renderToStaticMarkup(<RelayFullTiles data={data} trends={trends} />);
    expect(full).toContain('grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6');
    expect(full).not.toContain(' xl:grid-cols-6');
    expect(full).not.toContain('md:grid-cols-3');
    expect(full).not.toContain('lg:grid-cols-4');

    const skeleton = renderToStaticMarkup(<RelayTilesSkeleton count={4} />);
    expect(skeleton).toContain('grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4');
  });

  test('数值走格式化后的读数而不是裸字节', () => {
    const html = renderToStaticMarkup(<RelayFullTiles data={data} trends={trends} />);
    expect(html).toContain('16.0 KB/s');
    expect(html).toContain('128 MB');
    expect(html).toContain('13%');
  });

  test('事件循环延迟过高时磁贴转告警色', () => {
    const hot = relayMetricsFixture();
    hot.process.eventLoop = { lagMs: 320, maxLagMs: 500 };
    const html = renderToStaticMarkup(<RelayFullTiles data={hot} trends={trends} />);
    expect(html).toContain('data-tone="destructive"');
  });

  test('stale：磁贴留着数值，只打标降透明度', () => {
    const html = renderToStaticMarkup(<RelayFullTiles data={data} trends={trends} stale />);
    expect(html).toContain('data-stale=""');
    expect(html).toContain('16.0 KB/s');
  });
});

describe('趋势卡', () => {
  test('三张图各带峰谷标注与窗口长度', () => {
    const html = renderToStaticMarkup(
      <RelayTrendsCard trends={relayTrendSeries(relayMetricsFixture())} />
    );
    expect(html).toContain('data-testid="relay-trend-throughput"');
    expect(html).toContain('data-testid="relay-trend-streams"');
    expect(html).toContain('data-testid="relay-trend-event-loop"');
    expect(html).toContain('relay.metrics.trends.range');
    expect(html).toContain('relay.metrics.trends.window');
  });

  test('没有样本时不出峰谷，改说空态', () => {
    const empty = relayMetricsFixture({ history: { intervalMs: 5_000, samples: [] } });
    const html = renderToStaticMarkup(<RelayTrendsCard trends={relayTrendSeries(empty)} />);
    expect(html).toContain('relay.metrics.empty');
    expect(html).toContain('data-empty=""');
  });
});

describe('接入节点表', () => {
  test('按传入顺序摆行，离线行的延迟出破折号', () => {
    const data = relayMetricsFixture();
    const html = renderToStaticMarkup(
      <RelayMembersTable
        members={data.members}
        now={data.sampledAt}
        sort={DEFAULT_MEMBER_SORT}
        onSort={() => undefined}
      />
    );
    const online = html.indexOf('data-testid="relay-member-row-aabbccddeeff0011"');
    const offline = html.indexOf('data-testid="relay-member-row-ffeeddccbbaa9988"');
    expect(online).toBeGreaterThan(-1);
    expect(online).toBeLessThan(offline);
    expect(html).toContain('42.0 ms');
    expect(html).toContain('—');
    expect(html).toContain('上海节点');
    // 没名字的成员用节点号前 8 位
    expect(html).toContain('ffeeddcc');
  });

  test('一个成员都没有时出空态', () => {
    const html = renderToStaticMarkup(
      <RelayMembersTable members={[]} now={0} sort={DEFAULT_MEMBER_SORT} onSort={() => undefined} />
    );
    expect(html).toContain('data-testid="relay-members-empty"');
    expect(html).toContain('relay.metrics.members.empty');
  });

  test('筛没了时换一句「没有匹配」', () => {
    const html = renderToStaticMarkup(
      <RelayMembersTable
        members={[]}
        now={0}
        sort={DEFAULT_MEMBER_SORT}
        onSort={() => undefined}
        filtered
      />
    );
    expect(html).toContain('data-testid="relay-members-no-match"');
    expect(html).toContain('relay.metrics.members.noMatch');
  });

  test('表头可点，当前排序列带方向标注', () => {
    const html = renderToStaticMarkup(
      <RelayMembersTable
        members={[]}
        now={0}
        sort={{ key: 'rate', direction: 'desc' }}
        onSort={() => undefined}
      />
    );
    for (const key of ['node', 'state', 'rtt', 'streams', 'rate', 'reconnects', 'connected']) {
      expect(html).toContain(`data-testid="relay-members-sort-${key}"`);
    }
    expect(html).toContain('aria-sort="descending"');
    expect(html.match(/aria-sort=/g)?.length).toBe(1);
  });
});

describe('RelayMetricsPanel', () => {
  test('还没拉到且没出错：摆骨架', () => {
    const html = renderToStaticMarkup(<MetricsPanelHost />);
    expect(html).toContain('data-testid="relay-metrics-panel-skeleton"');
  });

  test('一次都没拉到过就失败：一行提示 + 重试', () => {
    setRelayMetricsStateForTest({ lastError: 'ECONNREFUSED' });
    const html = renderToStaticMarkup(<MetricsPanelHost />);
    expect(html).toContain('data-testid="relay-metrics-load-error"');
    expect(html).toContain('data-testid="relay-metrics-load-error-retry"');
    expect(html).toContain('relay.metrics.refreshFailed');
  });

  test('角色缺席：整块不渲染', () => {
    setRelayMetricsStateForTest({ availability: 'unavailable' });
    expect(renderToStaticMarkup(<MetricsPanelHost />)).toBe('');
  });

  test('拉到过又失败：正文照旧，另加一条「已过期」与重试', () => {
    setRelayMetricsStateForTest({ data: relayMetricsFixture(), lastError: 'timeout' });
    const html = renderToStaticMarkup(<MetricsPanelHost />);
    expect(html).toContain('data-testid="relay-metrics-panel"');
    expect(html).toContain('data-testid="relay-metrics-tiles"');
    expect(html).toContain('data-testid="relay-metrics-error"');
    expect(html).toContain('relay.metrics.stale');
    expect(html).toContain('data-stale=""');
  });

  test('接入节点表已挪出面板，由中继管理页单独摆一张卡', () => {
    setRelayMetricsStateForTest({ data: relayMetricsFixture() });
    const html = renderToStaticMarkup(<MetricsPanelHost />);
    expect(html).not.toContain('data-testid="relay-members-card"');
    expect(html).not.toContain('data-testid="relay-members-table"');
  });
});

describe('RelayMetricsHeaderStrip', () => {
  test('正常态：绿点 + 版本 / 运行时长 / 租户数', () => {
    const html = renderToStaticMarkup(
      <RelayMetricsHeaderStrip version="1.1.27" uptimeMs={90_000_000} tenants={2} stale={false} />
    );
    expect(html).toContain('bg-emerald-500');
    expect(html).toContain('relay.metrics.header.running');
    expect(html).toContain('data-testid="relay-metrics-version"');
    expect(html).toContain('data-testid="relay-metrics-uptime"');
    expect(html).toContain('data-testid="relay-metrics-tenants"');
  });

  test('过期态：改成琥珀点并说明数据已过期', () => {
    const html = renderToStaticMarkup(
      <RelayMetricsHeaderStrip version="1.1.27" uptimeMs={1000} tenants={0} stale />
    );
    expect(html).toContain('bg-amber-500');
    expect(html).toContain('relay.metrics.stale');
  });
});
