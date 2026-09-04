// 本机卡片上的紧凑指标区：四种收尾（骨架 / 首拉失败 / 正常 / 过期）与控制台链接。

import { afterEach, describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { RelayServiceMetrics } = await import('./relay-service-metrics');
const { relayMetricsFixture } = await import('../../relay/relay-metrics-fixture');
const { resetRelayMetricsStateForTest, setRelayMetricsStateForTest } = await import(
  '../../relay/relay-metrics-store'
);

function render(props: Partial<Parameters<typeof RelayServiceMetrics>[0]> = {}): string {
  return renderToStaticMarkup(
    <RelayServiceMetrics publicUrl="https://relay.example.com" hasPassword {...props} />
  );
}

afterEach(() => {
  resetRelayMetricsStateForTest();
});

describe('RelayServiceMetrics', () => {
  test('还没拉到：摆磁贴骨架', () => {
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

  test('角色缺席：整块不渲染', () => {
    setRelayMetricsStateForTest({ unavailable: true });
    expect(render()).toBe('');
  });

  test('正常：主排四格 + 瘦排三格，不出完整排的格子', () => {
    setRelayMetricsStateForTest({ data: relayMetricsFixture() });
    const html = render();
    expect(html).toContain('data-testid="relay-service-metrics"');
    expect(html).toContain('data-testid="relay-metric-members-online"');
    expect(html).toContain('data-testid="relay-metric-throughput"');
    expect(html).toContain('data-testid="relay-metric-rtt"');
    expect(html).toContain('data-testid="relay-metric-cpu"');
    expect(html).not.toContain('data-testid="relay-metric-sockets"');
    expect(html).not.toContain('data-stale=""');
  });

  test('拉到过又失败：磁贴留着旧值并打「已过期」标', () => {
    setRelayMetricsStateForTest({ data: relayMetricsFixture(), lastError: 'timeout' });
    const html = render();
    expect(html).toContain('data-testid="relay-service-metrics-stale"');
    expect(html).toContain('data-stale=""');
    expect(html).toContain('data-testid="relay-metric-throughput"');
  });

  test('给了回调才出控制台链接', () => {
    setRelayMetricsStateForTest({ data: relayMetricsFixture() });
    expect(render()).not.toContain('data-testid="relay-service-metrics-console"');
    expect(render({ onOpenConsole: () => undefined })).toContain(
      'data-testid="relay-service-metrics-console"'
    );
  });
});
