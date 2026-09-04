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
  sortMembers,
} = await import('./relay-metrics-model');
const { relayMetricsFixture, relayMetricsMember, relayMetricsSample } = await import(
  './relay-metrics-fixture'
);
const { RelayCompactTiles, RelayFullTiles } = await import('./relay-metrics-tiles');
const { RelayTrendsCard } = await import('./relay-metrics-trends');
const { RelayMembersTable } = await import('./relay-metrics-members');
const { RelayMetricsPanel, RelayMetricsHeaderStrip } = await import('./relay-metrics-panel');
const { resetRelayMetricsStateForTest, setRelayMetricsStateForTest } = await import(
  './relay-metrics-store'
);

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

  test('排序：在线优先，其次按速率降序', () => {
    const rows = sortMembers([
      relayMetricsMember({ nodeId: 'slow', bytesInPerSec: 1, bytesOutPerSec: 1 }),
      relayMetricsMember({ nodeId: 'offline', online: false, bytesOutPerSec: 999_999 }),
      relayMetricsMember({ nodeId: 'fast', bytesInPerSec: 100, bytesOutPerSec: 100 }),
    ]);
    expect(rows.map((row) => row.nodeId)).toEqual(['fast', 'slow', 'offline']);
  });

  test('标题取名字，没名字取节点号前 8 位', () => {
    expect(memberTitle(relayMetricsMember({ name: ' 北京 ' }))).toBe('北京');
    expect(memberTitle(relayMetricsMember({ name: null, nodeId: 'aabbccddeeff' }))).toBe(
      'aabbccdd'
    );
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

  test('完整排把十二格都摆出来', () => {
    const html = renderToStaticMarkup(<RelayFullTiles data={data} trends={trends} />);
    for (const id of [
      'members-online',
      'active-streams',
      'bytes-in',
      'bytes-out',
      'frames',
      'rtt',
      'event-loop',
      'memory',
      'heap',
      'cpu',
      'sockets',
      'uptime',
    ]) {
      expect(html).toContain(`data-testid="relay-metric-${id}"`);
    }
  });

  test('紧凑排只出七格，吞吐格带折线', () => {
    const html = renderToStaticMarkup(<RelayCompactTiles data={data} trends={trends} />);
    expect(html).toContain('data-testid="relay-metric-throughput"');
    expect(html).toContain('data-testid="relay-metric-uptime"');
    expect(html).not.toContain('data-testid="relay-metric-heap"');
    expect(html).not.toContain('data-testid="relay-metric-sockets"');
    expect(html).toContain('data-slot="sparkline"');
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
  test('在线行在前，离线行的延迟出破折号', () => {
    const data = relayMetricsFixture();
    const html = renderToStaticMarkup(
      <RelayMembersTable members={data.members} now={data.sampledAt} />
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
    const html = renderToStaticMarkup(<RelayMembersTable members={[]} now={0} />);
    expect(html).toContain('relay.metrics.members.empty');
  });
});

describe('RelayMetricsPanel', () => {
  test('还没拉到且没出错：摆骨架', () => {
    const html = renderToStaticMarkup(<RelayMetricsPanel />);
    expect(html).toContain('data-testid="relay-metrics-panel-skeleton"');
  });

  test('一次都没拉到过就失败：一行提示 + 重试', () => {
    setRelayMetricsStateForTest({ lastError: 'ECONNREFUSED' });
    const html = renderToStaticMarkup(<RelayMetricsPanel />);
    expect(html).toContain('data-testid="relay-metrics-load-error"');
    expect(html).toContain('data-testid="relay-metrics-load-error-retry"');
    expect(html).toContain('relay.metrics.refreshFailed');
  });

  test('角色缺席：整块不渲染', () => {
    setRelayMetricsStateForTest({ unavailable: true });
    expect(renderToStaticMarkup(<RelayMetricsPanel />)).toBe('');
  });

  test('拉到过又失败：正文照旧，另加一条「已过期」与重试', () => {
    setRelayMetricsStateForTest({ data: relayMetricsFixture(), lastError: 'timeout' });
    const html = renderToStaticMarkup(<RelayMetricsPanel />);
    expect(html).toContain('data-testid="relay-metrics-panel"');
    expect(html).toContain('data-testid="relay-metrics-tiles"');
    expect(html).toContain('data-testid="relay-metrics-error"');
    expect(html).toContain('relay.metrics.stale');
    expect(html).toContain('data-stale=""');
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
