// 本机卡片上的运行摘要：四种收尾（骨架 / 首拉失败 / 正常 / 过期）与控制台链接。

import { afterEach, describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { RelayServiceMetrics, relaySummaryParts } = await import('./relay-service-metrics');
const { relayMetricsFixture } = await import('../../relay/relay-metrics-fixture');
const { resetRelayMetricsStateForTest, setRelayMetricsStateForTest } = await import(
  '../../relay/relay-metrics-store'
);

/** 摘要每一段实际取了哪个 key、传了哪些参数。 */
function summaryParts(data: Parameters<typeof relaySummaryParts>[1]) {
  const seen: Array<{ key: string; params?: Record<string, unknown> }> = [];
  relaySummaryParts((key, params) => {
    if (key.startsWith('relay.metrics.summary')) seen.push({ key, ...(params ? { params } : {}) });
    return key;
  }, data);
  return seen;
}

function render(props: Partial<Parameters<typeof RelayServiceMetrics>[0]> = {}): string {
  return renderToStaticMarkup(
    <RelayServiceMetrics publicUrl="https://relay.example.com" hasPassword {...props} />
  );
}

afterEach(() => {
  resetRelayMetricsStateForTest();
});

describe('RelayServiceMetrics', () => {
  test('还没拉到：摆一行骨架', () => {
    const html = render();
    expect(html).toContain('data-testid="relay-service-metrics-skeleton"');
    expect(html).not.toContain('data-testid="relay-service-metrics"');
  });

  test('一次都没拉到过就失败：一行提示 + 重试', () => {
    setRelayMetricsStateForTest({ lastError: 'ECONNREFUSED' });
    const html = render();
    expect(html).toContain('data-testid="relay-service-metrics-error"');
    expect(html).toContain('data-testid="relay-service-metrics-error-retry"');
  });

  // 指标端点不可用（旧中继 / 401）：留一个空的「运行」标签比不摆更糟，用户会以为读数没加载出来。
  test('端点不可用：连标签一起整行不渲染', () => {
    setRelayMetricsStateForTest({ availability: 'unavailable' });
    expect(render()).toBe('');
    expect(render({ onOpenConsole: () => undefined })).toBe('');
  });

  test('可用时整行自带「运行」标签', () => {
    setRelayMetricsStateForTest({ data: relayMetricsFixture() });
    expect(render()).toContain('nodes.machine.relayServiceRuntime');
    // 骨架那一档也带标签，行高不会在数据到位时跳一下
    resetRelayMetricsStateForTest();
    expect(render()).toContain('nodes.machine.relayServiceRuntime');
  });

  test('正常：一行读数，磁贴一格都不摆', () => {
    setRelayMetricsStateForTest({ data: relayMetricsFixture() });
    const html = render();
    expect(html).toContain('data-testid="relay-service-metrics"');
    expect(html).toContain('relay.metrics.summaryNodes');
    expect(html).not.toContain('data-testid="relay-metrics-compact"');
    expect(html).not.toContain('data-testid="relay-metric-members-online"');
    expect(html).not.toContain('data-stale=""');
  });

  // 英文的租户 / 活跃流按数量变单复数，一条长模板做不到：逐段取文案，宽屏用 ` · ` 串、窄屏堆叠。
  test('一行读数由五段拼成，各段各自带自己的参数', () => {
    const data = relayMetricsFixture();
    const parts = summaryParts(data);
    expect(parts.map((part) => part.key)).toEqual([
      'relay.metrics.summaryNodes',
      'relay.metrics.summaryTenants',
      'relay.metrics.summaryStreams',
      'relay.metrics.summaryRate',
      'relay.metrics.summaryUptime',
    ]);
    expect(parts[0]?.params).toMatchObject({
      online: data.totals.membersOnline,
      total: data.totals.members,
    });
    // `count` 是 i18next 选复数形态的那个参数名，不能改成 tenants / streams
    expect(parts[1]?.params).toEqual({ count: data.totals.tenants });
    expect(parts[2]?.params).toEqual({ count: data.totals.activeStreams });
    expect(String((parts[3]?.params as { out: string }).out).length).toBeGreaterThan(0);
    expect(String((parts[4]?.params as { uptime: string }).uptime)).toContain(
      'relay.admin.health.uptime'
    );
  });

  test('拉到过又失败：读数留着旧值并打「已过期」标', () => {
    setRelayMetricsStateForTest({ data: relayMetricsFixture(), lastError: 'timeout' });
    const html = render();
    expect(html).toContain('data-testid="relay-service-metrics-stale"');
    expect(html).toContain('data-stale=""');
    expect(html).toContain('relay.metrics.summaryNodes');
  });

  test('给了回调才出控制台链接', () => {
    setRelayMetricsStateForTest({ data: relayMetricsFixture() });
    expect(render()).not.toContain('data-testid="relay-service-metrics-console"');
    expect(render({ onOpenConsole: () => undefined })).toContain(
      'data-testid="relay-service-metrics-console"'
    );
  });
});
