// 本机作为中继时，节点卡上的运行摘要：一行读数 + 一条通往中继控制台的链接。
//
// 数据源与「中继」标签是同一份宿主级 store，两处同时挂载也只有一条 5 秒轮询回路。
// 磁贴留给控制台：本机卡只回答「还活着、转了多少」，细看走「打开中继控制台」。

import { formatRate } from '@vibeterm/api-client/format';
import type { RelayMetricsResponse } from '@vibeterm/api-client/relay/metrics-types';
import { Button } from '@vibeterm/ui/button';
import { Skeleton } from '@vibeterm/ui/skeleton';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { uptimeText } from '../../relay/relay-format';
import { RelayMetricsRetryLine } from '../../relay/relay-metrics-panel';
import { type RelayMetricsApi, useRelayMetrics } from '../../relay/relay-metrics-store';
import { Row, type SegmentItem, Segments } from '../copy-feedback';

const SUMMARY_KEYS = ['nodes', 'tenants', 'streams', 'rate', 'uptime'] as const;

export type RelayServiceMetricsProps = {
  onOpenConsole?: () => void;
  api?: RelayMetricsApi;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * 一行读数的各段：在线节点 · 租户 · 活跃流 · 上下行速率 · 已运行。
 *
 * 逐段取文案而不是一条长模板：英文的「租户」「活跃流」要按数量变单复数，
 * 塞进一条模板就只能写成 `1 tenants`。窄屏还要把这几段拆成一段一行。
 */
export function relaySummaryParts(t: Translate, data: RelayMetricsResponse): string[] {
  const { totals } = data;
  return [
    t('relay.metrics.summaryNodes', { online: totals.membersOnline, total: totals.members }),
    t('relay.metrics.summaryTenants', { count: totals.tenants }),
    t('relay.metrics.summaryStreams', { count: totals.activeStreams }),
    t('relay.metrics.summaryRate', {
      out: formatRate(totals.bytesOutPerSec),
      in: formatRate(totals.bytesInPerSec),
    }),
    t('relay.metrics.summaryUptime', { uptime: uptimeText(t, data.uptimeMs) }),
  ];
}

/**
 * 「运行」那一行。整行（连同标签）由这里渲染：指标端点不可用时（旧中继 / 401）留一个空标签
 * 比不摆更糟——用户会以为读数没加载出来。
 */
export function RelayServiceMetrics({ onOpenConsole, api }: RelayServiceMetricsProps) {
  const { t } = useTranslation();
  const metrics = useRelayMetrics({ api });
  const { data, lastError } = metrics;

  if (metrics.unavailable) return null;

  return (
    <Row label={t('nodes.machine.relayServiceRuntime')}>
      <RuntimeValue metrics={metrics} />
      {data !== null && lastError && (
        <RelayMetricsRetryLine
          message={lastError}
          onRetry={metrics.refresh}
          testId="relay-service-metrics-stale"
        />
      )}
      {data !== null && onOpenConsole && (
        <Button
          size="xs"
          variant="ghost"
          // 窄屏：整条摆在读数下面，不再挤在行尾；宽屏：贴回行尾。
          className="w-full justify-center border border-border/60 text-muted-foreground sm:ml-auto sm:w-auto sm:border-0"
          onClick={onOpenConsole}
          data-testid="relay-service-metrics-console"
        >
          {t('relay.metrics.console')}
          <ArrowRight />
        </Button>
      )}
    </Row>
  );
}

/** 行内的读数本身：首次加载摆骨架，首拉失败给一行重试，拿到过就出摘要。 */
function RuntimeValue({ metrics }: { metrics: ReturnType<typeof useRelayMetrics> }) {
  const { t } = useTranslation();
  const { data, lastError } = metrics;
  if (data === null) {
    if (!lastError) {
      return (
        <Skeleton className="h-4 w-64 max-w-full" data-testid="relay-service-metrics-skeleton" />
      );
    }
    return (
      <RelayMetricsRetryLine
        message={lastError}
        onRetry={metrics.refresh}
        testId="relay-service-metrics-error"
      />
    );
  }
  const items: SegmentItem[] = relaySummaryParts(t, data).map((text, index) => ({
    key: SUMMARY_KEYS[index] ?? String(index),
    node: <span className="whitespace-nowrap">{text}</span>,
  }));
  return (
    <span
      className={lastError ? 'min-w-0 text-muted-foreground' : 'min-w-0'}
      data-testid="relay-service-metrics"
      data-stale={lastError ? '' : undefined}
    >
      <Segments items={items} />
    </span>
  );
}
