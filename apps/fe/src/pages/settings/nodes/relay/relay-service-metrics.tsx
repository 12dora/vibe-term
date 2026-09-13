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

export type RelayServiceMetricsProps = {
  publicUrl: string | null;
  hasPassword: boolean;
  onOpenConsole?: () => void;
  api?: RelayMetricsApi;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * 一行读数：在线节点 · 租户 · 活跃流 · 上下行速率 · 已运行。
 *
 * 逐段取文案而不是一条长模板：英文的「租户」「活跃流」要按数量变单复数，
 * 塞进一条模板就只能写成 `1 tenants`。
 */
export function relaySummaryText(t: Translate, data: RelayMetricsResponse): string {
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
  ].join(' · ');
}

export function RelayServiceMetrics({ onOpenConsole, api }: RelayServiceMetricsProps) {
  const { t } = useTranslation();
  const metrics = useRelayMetrics({ api });
  const { data, lastError } = metrics;

  if (metrics.unavailable) return null;

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

  return (
    <>
      <span
        className={lastError ? 'min-w-0 text-muted-foreground' : 'min-w-0'}
        data-testid="relay-service-metrics"
        data-stale={lastError ? '' : undefined}
      >
        {relaySummaryText(t, data)}
      </span>
      {lastError && (
        <RelayMetricsRetryLine
          message={lastError}
          onRetry={metrics.refresh}
          testId="relay-service-metrics-stale"
        />
      )}
      {onOpenConsole && (
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto text-muted-foreground"
          onClick={onOpenConsole}
          data-testid="relay-service-metrics-console"
        >
          {t('relay.metrics.console')}
          <ArrowRight />
        </Button>
      )}
    </>
  );
}
